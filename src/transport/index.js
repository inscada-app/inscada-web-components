/**
 * Transport — single abstraction over fetch + InscadaApi proxy.
 *
 * v1.0 scope (safe modes only — NO token-in-config):
 *   • iframe inside inSCADA Custom HTML → uses session cookie + InscadaApi proxy
 *     for cross-origin (ins.rest); same-origin /api/* via direct fetch.
 *   • Standalone page hosted same-origin as inSCADA → direct fetch with
 *     credentials: 'include'. User must already be logged into inSCADA.
 *
 * v1.0 INTENTIONALLY NOT SUPPORTED:
 *   • Cross-origin embed with token (e.g. external dashboard pulling
 *     inSCADA data). Requires scoped short-lived JWT — design deferred to v1.1.
 *   • setConfig({ token }) is rejected with a clear error.
 *
 * Auto-detect:
 *   inside iframe + window.InscadaApi present  → proxy mode
 *   else                                        → standalone same-origin mode
 *
 * Tests can call setTransport(mock) to inject a fake.
 */

let _config = {
  baseUrl: '',           // empty = same-origin (recommended)
  space: 'default_space',
};
let _instance = null;
let _override = null;

/**
 * Configure the transport (standalone mode). No-op for proxy/iframe mode —
 * the parent SPA's session is used regardless.
 *
 *   setConfig({ baseUrl: '', space: 'aybige' });
 *
 * `token` is intentionally rejected — see v1.1 scoped-token plan.
 */
export function setConfig(cfg) {
  if (cfg && 'token' in cfg) {
    throw new Error(
      "@inscada/web-components: token-based auth is not supported in v1.0. " +
      "Use same-origin embed (cookie-based) or wait for v1.1 scoped JWT support."
    );
  }
  _config = { ..._config, ...(cfg || {}) };
  _instance = null; // re-build with new config on next getTransport()
}

export function getConfig() { return { ..._config }; }

export function setTransport(t) { _override = t; _instance = null; }

export function getTransport() {
  if (_override) return _override;
  if (!_instance) _instance = new Transport(_config);
  return _instance;
}

/* ───────────────────────── Transport ───────────────────────── */

class Transport {
  constructor(config) {
    this._baseUrl = (config.baseUrl || '').replace(/\/$/, ''); // strip trailing /
    this._space = config.space || 'default_space';
    this._apiCache = new Map(); // projectName → InscadaApi
    this._isIframeWithProxy = _detectProxyMode();
  }

  setSpace(space) { this._space = space || 'default_space'; }
  get space() { return this._space; }

  /**
   * Batch variable read (JDK21).
   *
   * In iframe mode → uses InscadaApi proxy (api.getVariableValues). This is
   * REQUIRED in Custom HTML iframes because the iframe is served from the
   * sandbox origin (inscada.cloud:8083) which does NOT host the /api/
   * endpoints. The proxy forwards via postMessage → parent SPA → main app
   * origin where the API lives.
   *
   * In standalone mode → direct fetch:
   *   GET /api/variables/values/by-project-name-and-names
   *     ?projectName=X&names=A&names=B
   *
   * Returns Map<name, {value, date, ...}>.
   */
  async fetchVariables(projectName, names) {
    if (!projectName || !names || names.length === 0) return {};
    if (this._isIframeWithProxy) {
      const api = this._getApi(projectName);
      return api.getVariableValues(names);
    }
    const namesParams = names.map(n => 'names=' + encodeURIComponent(n)).join('&');
    const url = `${this._baseUrl}/api/variables/values/by-project-name-and-names` +
                `?projectName=${encodeURIComponent(projectName)}&${namesParams}`;
    return this._sameOriginJson(url);
  }

  /**
   * Run a script (by id) on backend.
   *   POST /api/scripts/{id}/run
   */
  async runScript(scriptId) {
    const url = `${this._baseUrl}/api/scripts/${encodeURIComponent(scriptId)}/run`;
    return this._sameOriginJson(url, { method: 'POST' });
  }

  /**
   * Run an ad-hoc script (used by faceplate batch evaluation).
   *   POST /api/scripts/runner  { projectId, name, code, log, compile }
   */
  async runAdHocScript(payload) {
    const url = `${this._baseUrl}/api/scripts/runner`;
    return this._sameOriginJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Resolve project NAME → project UUID (cached). Used by endpoints that
   * still take projectId (e.g. faceplates). Lookup: GET /api/projects/by-name
   */
  async resolveProjectId(projectName) {
    if (!projectName) throw new Error('projectName is required');
    if (!this._projectIdCache) this._projectIdCache = new Map();
    if (this._projectIdCache.has(projectName)) {
      return this._projectIdCache.get(projectName);
    }
    const url = `${this._baseUrl}/api/projects/by-name?name=${encodeURIComponent(projectName)}`;
    const proj = await this._sameOriginJson(url);
    if (!proj || !proj.id) throw new Error(`Project "${projectName}" not found`);
    this._projectIdCache.set(projectName, proj.id);
    return proj.id;
  }

  /**
   * Faceplate load — resolves project name → id, then 4 parallel same-origin
   * fetches (definition + svg + elements + placeholders).
   * Returns { def, svg, elements, placeholders }.
   */
  async loadFaceplate(projectName, name) {
    const projectId = await this.resolveProjectId(projectName);
    const base = `${this._baseUrl}/api/faceplates`;
    const defUrl = `${base}/by-project-and-names?projectId=${encodeURIComponent(projectId)}` +
                   `&names=${encodeURIComponent(name)}`;
    const defResp = await this._sameOriginJson(defUrl);
    const arr = Array.isArray(defResp) ? defResp : Object.values(defResp || {});
    const fp = arr.find(f => f && f.name === name);
    if (!fp) throw new Error(`Faceplate "${name}" not found in project ${projectName}`);

    const [svg, elements, placeholders] = await Promise.all([
      this._sameOriginText(`${base}/${fp.id}/svg`),
      this._sameOriginJson(`${base}/${fp.id}/elements`),
      this._sameOriginJson(`${base}/${fp.id}/placeholders`),
    ]);
    return { def: fp, projectId, svg, elements, placeholders };
  }

  /**
   * Load a published file's content as a UTF-8 string.
   *
   *   iframe mode → uses the `asset_reader` server-side script pattern.
   *     The script must exist in the target project; see
   *     `ASSET_READER_CODE` below for the source. Two round-trips:
   *       1) setGlobalObject('reader_path', path)
   *       2) executeScript('asset_reader')
   *     Returns { path, content, bytes } — we extract .content.
   *
   *     Why not `api.readPublishedFile(path)` directly: it exists (build
   *     ≥ 2026-06-15) but the parent SPA's InscadaApi.call() unconditionally
   *     JSON.parses the response, and Spring writes String returns as raw
   *     text — parse crashes. See tools/BUG_scripts_callapi_raw_string_response.md.
   *     asset_reader wraps the string in a Map so Jackson JSON-encodes it.
   *
   *   standalone mode → direct fetch of `/api/custom-html/assets/<path>`
   *     with credentials. Same-origin so CORS is fine.
   *
   * Errors:
   *   - 'Missing asset_reader script in project X' — user must create it once
   *     per project via MCP or platform UI. Component surfaces
   *     `InsFaceplate.ASSET_READER_CODE` for copy-paste.
   */
  async loadPublishedFile(projectName, path) {
    if (!path) throw new Error('path is required');
    if (this._isIframeWithProxy) {
      if (!projectName) throw new Error('projectName is required in iframe mode');
      const api = this._getApi(projectName);
      await api.setGlobalObject('reader_path', path);
      let res;
      try {
        res = await api.executeScript('asset_reader');
      } catch (e) {
        const msg = String(e && e.message || e);
        if (msg.indexOf('Repeatable script not found') >= 0 || msg.indexOf('asset_reader') >= 0) {
          throw new Error(
            "Missing 'asset_reader' script in project '" + projectName + "'. " +
            "Create it once (server-side script named exactly 'asset_reader') " +
            'with this code: `Transport.ASSET_READER_CODE`.'
          );
        }
        throw e;
      }
      if (!res || typeof res !== 'object') {
        throw new Error("asset_reader returned unexpected shape: " + JSON.stringify(res));
      }
      if (res.error) throw new Error("asset_reader error: " + res.error);
      if (typeof res.content !== 'string') {
        throw new Error("asset_reader returned no content for '" + path + "'");
      }
      return res.content;
    }
    const url = this._baseUrl + '/api/custom-html/assets/' + path.replace(/^\/+/, '');
    return this._sameOriginText(url);
  }

  /**
   * External URL fetch (cross-origin). In iframe mode this MUST go through
   * the InscadaApi proxy (CSP blocks direct cross-origin fetch + ins.rest
   * server-side allowlist applies). In standalone mode it's a direct fetch
   * (target server must permit CORS).
   *
   * Returns { statusCode, headers, body } — mirrors ins.rest response shape.
   */
  async fetchExternalUrl(url, opts = {}) {
    const method = opts.method || 'GET';
    const headers = opts.headers || 'application/json';
    const body = opts.body !== undefined ? opts.body : null;

    if (this._isIframeWithProxy) {
      const api = this._getApi(opts.projectName || 'default');
      return api.rest(method, url, headers, body);
    }

    // Standalone: direct fetch (no credentials cross-origin unless explicitly
    // configured; v1.0 does not pass cookies cross-origin — too risky).
    const init = { method };
    if (typeof headers === 'object') init.headers = headers;
    else init.headers = { 'Content-Type': String(headers) };
    if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const r = await fetch(url, init);
    const text = await r.text();
    const headersOut = {};
    r.headers.forEach((v, k) => { headersOut[k] = v; });
    return { statusCode: r.status, headers: headersOut, body: text };
  }

  /* ── Internal ────────────────────────────────────────── */

  async _sameOriginJson(url, init = {}) {
    const r = await this._sameOriginFetch(url, init);
    if (r.status === 204) return null;
    return await r.json();
  }

  async _sameOriginText(url, init = {}) {
    const r = await this._sameOriginFetch(url, init);
    return await r.text();
  }

  async _sameOriginFetch(url, init = {}) {
    const headers = { 'X-Space': this._space, ...(init.headers || {}) };
    const r = await fetch(url, { credentials: 'include', ...init, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
    return r;
  }

  _getApi(projectName) {
    if (!this._apiCache.has(projectName)) {
      this._apiCache.set(projectName, new window.InscadaApi(projectName));
    }
    return this._apiCache.get(projectName);
  }
}

/**
 * The exact source code of the server-side script named `asset_reader`.
 * Copy this into a new Repeatable Script in the target project.
 *
 * Nashorn ES5 syntax (JDK21 default). Wraps the raw String from ins.readFile
 * in an Object so Jackson serializes it as JSON — bypasses the
 * StringHttpMessageConverter raw-text bug that crashes InscadaApi.call().
 */
export const ASSET_READER_CODE = "(function () {\n" +
  "  var path = ins.getGlobalObject('reader_path');\n" +
  "  if (path == null) return { error: 'reader_path global not set' };\n" +
  "  var content = ins.readFile(path);\n" +
  "  return { path: path, content: content, bytes: content == null ? 0 : content.length };\n" +
  "})();\n";

function _detectProxyMode() {
  try {
    return typeof window !== 'undefined'
      && typeof window.InscadaApi === 'function'
      && window.parent !== window;
  } catch (_) { return false; }
}

export { Transport };
