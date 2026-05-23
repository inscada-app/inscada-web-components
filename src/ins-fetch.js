/**
 * <ins-fetch> — Generic REST endpoint fetcher with polling, headless data
 * provider, and optional template binding.
 *
 * Calls go through the Transport layer:
 *   • Inside inSCADA Custom HTML iframe → InscadaApi proxy (ins.rest with
 *     server-side allowlist enforcement).
 *   • Standalone page → direct fetch (target server must permit CORS).
 *
 * USAGE:
 *
 * 1) Headless — listen for updates:
 *
 *    <ins-fetch id="plant"
 *      url="https://vpn.inscada.online/api/internal/plant-summary?plant=aybigehes"
 *      refresh="10000"
 *      project="AYBIGE_HES">
 *    </ins-fetch>
 *
 *    <script>
 *      document.getElementById('plant').addEventListener('ins-data-update',
 *        e => render(e.detail));   // e.detail is the parsed JSON body
 *    </script>
 *
 * 2) Template binding (dot-notation for nested paths):
 *
 *    <ins-fetch url="..." refresh="10000">
 *      <template>
 *        <h2 data-bind="plant_name">--</h2>
 *        <span data-bind="channels.active">--</span> /
 *        <span data-bind="channels.total">--</span>
 *      </template>
 *    </ins-fetch>
 *
 * Attributes:
 *   url       — Target URL (required)
 *   method    — HTTP method (default GET)
 *   refresh   — Polling interval ms (default 10000, 0 = one-shot, min 500)
 *   project   — inSCADA project NAME context for proxy mode (default 'default')
 *   parse     — Response parsing: 'json' (default) | 'text' | 'auto'
 *   timeout   — Per-request timeout in ms (default none — relies on transport)
 *
 * Events:
 *   ins-data-update — fired on every successful fetch
 *     event.detail = parsed response (object/string depending on `parse`)
 *   ins-data-error  — fired on fetch/parse error
 *     event.detail = { error: string, statusCode?: number }
 *
 * Methods (on element):
 *   .getData()           — last successful response (or null)
 *   .data                — getter alias of getData()
 *   .subscribe(cb)       — register callback; returns unsubscribe fn
 *   .refresh()           — force an immediate fetch
 *   .isStale             — true when last fetch failed but had prior success
 */

import { getTransport } from './transport/index.js';

class InsFetch extends HTMLElement {
  static get observedAttributes() {
    return ['url', 'method', 'refresh', 'project', 'parse'];
  }

  constructor() {
    super();
    this._data = null;
    this._lastSuccessTs = null;
    this._isStale = false;
    this._jsSubscribers = new Set();
    this._timer = null;
    this._pollingActive = false;
    this._templateRendered = false;
    this._inFlight = false;
  }

  connectedCallback() {
    if (!this.querySelector('template')) {
      this.style.display = 'none';
    } else {
      this._renderTemplate();
    }

    if (typeof document !== 'undefined') {
      this._visHandler = () => this._onVisibilityChange();
      document.addEventListener('visibilitychange', this._visHandler);
    }

    this._start();
  }

  disconnectedCallback() {
    this._stop();
    this._jsSubscribers.clear();
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (!this.isConnected) return;
    if (name === 'url' || name === 'method' || name === 'project' || name === 'parse') {
      this._restart();
    } else if (name === 'refresh') {
      this._restart();
    }
  }

  /* ── Public API ─────────────────────────────────────── */

  getData() { return this._data; }
  get data() { return this._data; }
  get isStale() { return this._isStale; }

  subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    this._jsSubscribers.add(cb);
    if (this._data !== null) {
      try { cb(this._data); } catch (_) { /* */ }
    }
    return () => this._jsSubscribers.delete(cb);
  }

  /** Force an immediate fetch outside the polling cycle. */
  refresh() {
    return this._fetchOnce();
  }

  /* ── Internal ───────────────────────────────────────── */

  _start() {
    this._pollingActive = true;
    this._fetchOnce(); // initial fetch
    const interval = this._refreshMs();
    if (interval > 0 && !document?.hidden) {
      this._timer = setInterval(() => this._fetchOnce(), interval);
    }
  }

  _stop() {
    this._pollingActive = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _restart() {
    this._stop();
    this._start();
  }

  _onVisibilityChange() {
    if (document.hidden) {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    } else if (this._pollingActive && !this._timer) {
      const interval = this._refreshMs();
      if (interval > 0) {
        this._fetchOnce(); // catch-up
        this._timer = setInterval(() => this._fetchOnce(), interval);
      }
    }
  }

  _refreshMs() {
    const raw = this.getAttribute('refresh');
    if (raw === null) return 10000;
    const ms = parseInt(raw, 10);
    if (isNaN(ms)) return 10000;
    if (ms === 0) return 0;
    return Math.max(500, ms);
  }

  async _fetchOnce() {
    if (this._inFlight) return; // skip if previous tick still pending
    const url = this.getAttribute('url');
    if (!url) return;

    this._inFlight = true;
    try {
      const transport = getTransport();
      const opts = {
        method: this.getAttribute('method') || 'GET',
        projectName: this.getAttribute('project') || 'default',
      };
      const r = await transport.fetchExternalUrl(url, opts);
      const status = Number(r?.statusCode);
      if (!(status >= 200 && status < 300)) {
        this._onError(`HTTP ${status}`, status);
        return;
      }

      const parsed = this._parseBody(r?.body);
      this._data = parsed;
      this._lastSuccessTs = Date.now();
      this._isStale = false;
      this._fireUpdate();
    } catch (err) {
      this._onError(err?.message || String(err));
    } finally {
      this._inFlight = false;
    }
  }

  _parseBody(body) {
    const mode = (this.getAttribute('parse') || 'json').toLowerCase();
    if (mode === 'text') return String(body ?? '');
    if (mode === 'auto') {
      try { return JSON.parse(body); } catch { return String(body ?? ''); }
    }
    // 'json' (default) — throw if not parseable
    if (typeof body !== 'string') return body;
    return JSON.parse(body);
  }

  _onError(message, statusCode) {
    if (this._lastSuccessTs) this._isStale = true;
    this.dispatchEvent(new CustomEvent('ins-data-error', {
      detail: statusCode !== undefined ? { error: message, statusCode } : { error: message },
      bubbles: true,
      composed: true,
    }));
  }

  _fireUpdate() {
    this.dispatchEvent(new CustomEvent('ins-data-update', {
      detail: this._data,
      bubbles: true,
      composed: true,
    }));
    for (const cb of this._jsSubscribers) {
      try { cb(this._data); } catch (_) { /* */ }
    }
    if (this._templateRendered) this._applyBindings(this._data);
  }

  /* ── Template binding (dot-notation nested paths) ───── */

  _renderTemplate() {
    const tpl = this.querySelector('template');
    if (!tpl) return;
    const frag = tpl.content.cloneNode(true);
    Array.from(this.children).forEach(child => {
      if (child.tagName !== 'TEMPLATE') child.remove();
    });
    this.appendChild(frag);
    this._templateRendered = true;
  }

  _applyBindings(snapshot) {
    if (snapshot == null || typeof snapshot !== 'object') return;
    const elements = this.querySelectorAll('[data-bind]');
    for (const el of elements) {
      const path = el.getAttribute('data-bind');
      const value = this._getByPath(snapshot, path);
      if (value === undefined || value === null) continue;

      let display = value;
      const fmt = el.getAttribute('data-bind-format');
      if (fmt) {
        const num = Number(value);
        if (!isNaN(num)) {
          const decimals = parseInt(fmt.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(decimals)) display = num.toFixed(decimals);
        }
      }

      const bindAttr = el.getAttribute('data-bind-attr');
      if (bindAttr) { el.setAttribute(bindAttr, display); continue; }

      const bindStyle = el.getAttribute('data-bind-style');
      if (bindStyle) { el.style[bindStyle] = display; continue; }

      el.textContent = display;
    }
  }

  _getByPath(obj, path) {
    if (!path) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }
}

export { InsFetch };
export default InsFetch;
