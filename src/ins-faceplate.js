/**
 * <ins-faceplate> v3 — domain-API-only faceplate renderer.
 *
 * Attributes:
 *   name       (required) inSCADA faceplate name
 *   project    (required) inSCADA project name — used for the InscadaApi context
 *   poll       (optional) live-tag refresh interval in ms (default 2000, min 200)
 *   debug      (optional) console.warn on missing element / resolver / bad JSON
 *   width      (optional) inline CSS width
 *   height     (optional) inline CSS height
 *   <any-other-name>=<value>  →  placeholder override — mirrors the "attr =
 *                               placeholder value" convention. If the DB has
 *                               a placeholder `brand`, then attribute
 *                               `brand="Siemens 7SJ82"` overrides its default.
 *
 * Runtime pipeline:
 *   1. connectedCallback yields to the parser (so attributes are all present).
 *   2. transport.loadFaceplateFull(project, name) fetches def + svg + elements
 *      + placeholders via the domain API (getFaceplateByName / getFaceplateSvg
 *      / getFaceplateElements / getFaceplatePlaceholders — backend
 *      commit 617709390, live 2026-07-06).
 *      In iframe mode the calls go through InscadaApi's postMessage proxy;
 *      in standalone mode they hit the REST endpoints directly.
 *   3. SVG is injected as inline light DOM (no <object>, no Shadow DOM).
 *   4. Placeholder values collected from tag attributes.
 *   5. Placeholders of type=`tag` derive the live tag poll list; a batched
 *      api.getVariableValues([...]) refreshes them every `poll` ms.
 *   6. Elements iterate; each dom_id looks up a resolver registered via
 *      setResolvers({dom_id: fn}). The resolver receives (insShim, phValues)
 *      and returns the value we hand to the element-type handler
 *      (Get/Color/Opacity/Visibility/Rotate/Bar/Blink/Move/Scale).
 *
 * Sandbox CSP note:
 *   `unsafe-eval` is NOT granted, so we never `new Function(body)`. Element
 *   expressions from the DB are surfaced to the caller (via getElementDefs())
 *   but interpreting them is the caller's responsibility — supply pre-written
 *   resolver functions instead of stringly-typed code.
 *
 * Usage:
 *   <ins-faceplate name="H01" project="PALANDOKEN_GES"
 *                  brand="Siemens 7SJ82" cb_status="CB01_STATUS" poll="2000">
 *   </ins-faceplate>
 *
 *   <script>
 *     const fp = document.querySelector('ins-faceplate');
 *     fp.setResolvers({
 *       label:   (ins, ph) => ph.brand,
 *       cb_body: (ins, ph) => ins.getVariableValue(ph.cb_status).value ? '#0c0' : '#c00',
 *     });
 *   </script>
 */

import { getTransport } from './transport/index.js';

const RESERVED_ATTRS = new Set([
  'name', 'project', 'poll',
  'width', 'height', 'style', 'class', 'id', 'debug',
]);

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 200;
const BLINK_MS = 500;

export default class InsFaceplate extends HTMLElement {
  constructor() {
    super();
    // Deliberately NO Shadow DOM (browser quirks around <object> in shadow).
    // Also NO string-eval anywhere — the sandbox iframe's CSP forbids
    // `unsafe-eval`, so `new Function(body)` throws. Callers instead ship
    // pre-written resolver functions keyed by dom_id via setResolvers().
    this._api = null;
    this._svgRoot = null;
    this._elementDefs = [];
    this._placeholderDefs = [];
    this._placeholders = {};       // { brand: 'Siemens 7SJ82', ... } — keyed by RAW attr name (not $wrapped$)
    this._resolvers = {};          // { dom_id: (ins, ph) => value }
    this._tagsToPoll = [];
    this._cache = {};              // { varName: { value, date, ... } }
    this._timer = null;
    this._observer = null;
    this._debug = false;
    this._def = null;              // FaceplateResponseDto
  }

  // We handle every attribute change through a MutationObserver so runtime
  // updates from user code — `fp.setAttribute('brand', 'ABB REF615')` — flow
  // through re-substitute + re-compile + tick without requiring the caller
  // to enumerate every placeholder up-front.
  static get observedAttributes() { return []; }

  async connectedCallback() {
    this._debug = this.hasAttribute('debug');
    this._renderShell();
    this._observeAttrs();
    await this._init();
  }

  disconnectedCallback() {
    this._stopPolling();
    this._clearBlinks();
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    this._svgRoot = null;
  }

  _observeAttrs() {
    if (this._observer) return;
    const self = this;
    this._observer = new MutationObserver(function (mutations) { self._onAttrChange(mutations); });
    this._observer.observe(this, { attributes: true });
  }

  _onAttrChange(mutations) {
    if (!this._svgRoot) return;
    const structural = ['name', 'project'];
    let restart = false, pollChanged = false, phChanged = false;
    for (const m of mutations) {
      const n = String(m.attributeName || '').toLowerCase();
      if (!n) continue;
      if (structural.indexOf(n) !== -1) { restart = true; break; }
      if (n === 'poll') pollChanged = true;
      else if (!RESERVED_ATTRS.has(n)) phChanged = true;
    }
    if (restart) { this._init(); return; }
    if (pollChanged && this._timer) this._startPolling();
    if (phChanged) {
      this._placeholders = this._collectPlaceholderValues();
      this._deriveTagsToPoll();
      if (this._tagsToPoll.length === 0) this._tick();
      else if (!this._timer) this._startPolling();
    }
  }

  /* ── shell / errors ──────────────────────────────────────────── */

  _renderShell() {
    // Preserve caller-supplied inline styles; only fill missing.
    if (!this.style.display) this.style.display = 'inline-block';
    if (!this.style.width && this.getAttribute('width')) this.style.width = this.getAttribute('width');
    if (!this.style.height && this.getAttribute('height')) this.style.height = this.getAttribute('height');
    // Light-DOM markup — replaces any children (including the metadata
    // <script>), which is safe because we cache metadata before this runs.
    this.innerHTML =
      '<div class="ins-fp-wrap" style="width:100%;height:100%;position:relative;">' +
        '<div class="ins-fp-msg" style="font-family:sans-serif;font-size:12px;padding:6px;color:#888;">Loading faceplate…</div>' +
      '</div>';
  }

  _err(msg) {
    const wrap = this.querySelector('.ins-fp-wrap');
    if (wrap) wrap.innerHTML = '<div class="ins-fp-msg" style="font-family:sans-serif;font-size:12px;padding:6px;color:#c00;">' + this._esc(msg) + '</div>';
    if (this._debug) console.error('[ins-faceplate]', msg);
  }

  _esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* ── init pipeline ───────────────────────────────────────────── */

  async _init() {
    this._stopPolling();
    this._clearBlinks();
    this._svgRoot = null;

    const project = this.getAttribute('project');
    const name = this.getAttribute('name');
    if (!project) return this._err('`project` attribute is required.');
    if (!name)    return this._err('`name` attribute is required.');

    let full;
    try {
      full = await getTransport().loadFaceplateFull(project, name);
    } catch (e) {
      return this._err('Faceplate load failed: ' + (e && e.message || e));
    }

    this._def = full.def || null;
    this._placeholderDefs = Array.isArray(full.placeholders) ? full.placeholders : [];
    this._elementDefs = Array.isArray(full.elements) ? full.elements : [];

    const svg = full.svg;
    if (typeof svg !== 'string' || svg.indexOf('<svg') < 0) {
      return this._err('Faceplate "' + name + '" has no SVG content.');
    }
    const wrap = this.querySelector('.ins-fp-wrap');
    wrap.innerHTML = svg;
    const root = wrap.querySelector('svg');
    if (!root) return this._err('Loaded SVG has no <svg> root element.');
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.display = 'block';
    this._svgRoot = root;

    this._placeholders = this._collectPlaceholderValues();
    this._api = this._resolveApi();
    this._deriveTagsToPoll();

    if (this._tagsToPoll.length > 0 && !this._api && this._debug) {
      console.warn(
        '[ins-faceplate] window.InscadaApi not found; live tag values will ' +
        'be null until the InscadaApi proxy is available.'
      );
    }

    if (this._tagsToPoll.length === 0) this._tick();
    else this._startPolling();
  }

  /* ── read accessors — expose DB-fetched metadata for caller code ── */

  getDefinition()   { return this._def; }
  getElementDefs()  { return this._elementDefs.slice(); }
  getPlaceholderDefs() { return this._placeholderDefs.slice(); }

  /**
   * All non-reserved attributes become placeholder values, keyed by RAW
   * attribute name (e.g. `ph.brand`, not `ph['$brand$']`). This is what
   * resolver functions consume — `function(ins, ph) { return ph.brand; }`.
   */
  _collectPlaceholderValues() {
    const out = {};
    for (const attr of Array.from(this.attributes)) {
      const name = attr.name.toLowerCase();
      if (RESERVED_ATTRS.has(name)) continue;
      out[name] = attr.value;
    }
    return out;
  }

  _resolveApi() {
    if (typeof window === 'undefined' || typeof window.InscadaApi !== 'function') return null;
    const project = this.getAttribute('project') || 'default';
    try { return new window.InscadaApi(project); }
    catch (e) { if (this._debug) console.warn('[ins-faceplate] InscadaApi construct failed', e); return null; }
  }

  /**
   * Register per-element resolver functions. Called by page code — the
   * component itself performs no string-to-function compilation, so it's
   * CSP-safe even under `script-src` without `unsafe-eval`.
   *
   * Example:
   *   fp.setResolvers({
   *     'text4-8': function(ins, ph) { return ph.brand; },
   *     'cb_body': function(ins, ph) {
   *       return ins.getVariableValue(ph.cb_status).value ? '#0c0' : '#c00';
   *     }
   *   });
   *
   * `ph` is the placeholder map keyed by raw attribute name; `ins` is a
   * proxy that reads from the last poll's cache (see _insShim).
   */
  setResolvers(map) {
    this._resolvers = (map && typeof map === 'object') ? map : {};
    this._deriveTagsToPoll();
    if (this._svgRoot) {
      if (this._tagsToPoll.length === 0) this._tick();
      else if (!this._timer) this._startPolling();
    }
  }

  // Union of (a) tag-type placeholder attribute values and (b) explicitly
  // declared extra tags from an optional `poll-tags` attribute (comma-
  // separated). Resolvers can reference variables the metadata doesn't
  // enumerate; poll-tags is the escape hatch for those.
  _deriveTagsToPoll() {
    const tags = new Set();
    for (const p of this._placeholderDefs) {
      if (!p) continue;
      if (String(p.type || '').toLowerCase() !== 'tag') continue;
      const key = this._unwrap(p.name || '').toLowerCase();
      const val = this._placeholders[key];
      if (val) tags.add(val);
    }
    const extra = this.getAttribute('poll-tags');
    if (extra) {
      const parts = String(extra).split(',');
      for (const raw of parts) { const t = raw.trim(); if (t) tags.add(t); }
    }
    this._tagsToPoll = Array.from(tags);
  }

  _unwrap(name) {
    if (typeof name !== 'string') return name;
    if (name.length >= 2 && name.charAt(0) === '$' && name.charAt(name.length - 1) === '$') {
      return name.slice(1, -1);
    }
    return name;
  }

  /* ── polling & eval loop ────────────────────────────────────── */

  _startPolling() {
    this._stopPolling();
    const p = parseInt(this.getAttribute('poll') || DEFAULT_POLL_MS, 10);
    const interval = Math.max(MIN_POLL_MS, isNaN(p) ? DEFAULT_POLL_MS : p);
    this._tick();
    const self = this;
    this._timer = setInterval(function () { self._tick(); }, interval);
  }

  _stopPolling() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _tick() {
    if (this._tagsToPoll.length > 0 && this._api) {
      try {
        const result = await this._api.getVariableValues(this._tagsToPoll);
        this._cache = (result && typeof result === 'object') ? result : {};
      } catch (e) {
        if (this._debug) console.warn('[ins-faceplate] getVariableValues failed', e);
      }
    }
    const ins = this._insShim();
    const ph = this._placeholders;
    for (const def of this._elementDefs) {
      if (!def || !def.dom_id) continue;
      const resolver = this._resolvers[def.dom_id];
      if (typeof resolver !== 'function') {
        if (this._debug) console.warn('[ins-faceplate] no resolver registered for dom_id', def.dom_id);
        continue;
      }
      let value;
      try { value = resolver.call(null, ins, ph); }
      catch (e) {
        if (this._debug) console.warn('[ins-faceplate] resolver threw for', def.dom_id, e);
        continue;
      }
      this._apply(def, value);
    }
  }

  _insShim() {
    const cache = this._cache;
    return {
      getVariableValue: function (name) { return cache[name] || { value: null, date: null }; },
      getVariableValues: function (names) {
        const out = {};
        for (const n of names) out[n] = cache[n] || { value: null, date: null };
        return out;
      },
      toJSONStr: function (o) { return JSON.stringify(o); },
      // No-op stubs so server-only calls in expressions don't throw. If a
      // faceplate relies on writes / logs / alarms from an expression, that
      // is a server-side script pattern and doesn't belong in a widget anyway.
      setVariableValue: function () {},
      log: function () {},
    };
  }

  /* ── apply value to SVG ─────────────────────────────────────── */

  _apply(def, rawValue) {
    if (!this._svgRoot) return;
    const svgEl = this._findSvgEl(def.dom_id);
    if (!svgEl) {
      if (this._debug) console.warn('[ins-faceplate] SVG element not found for dom_id', def.dom_id);
      return;
    }

    // Strip accidental outer quotes coming back as a string.
    let value = rawValue;
    if (typeof value === 'string') {
      value = value.trim();
      if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
          (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
        value = value.slice(1, -1);
      }
    }

    const props = this._parseProps(def.props);

    switch (def.type) {
      case 'Get': {
        // Preserve <text><tspan>…</tspan></text> structure — SCADA convention.
        // Overwriting `textContent` on the <text> wipes the tspan; write to
        // the tspan when present so styling/positioning is retained.
        const tspan = svgEl.querySelector('tspan');
        const target = tspan || svgEl;
        target.textContent = value != null ? String(value) : '';
        break;
      }

      case 'Color': {
        if (typeof value !== 'string') break;
        const property = props.property || 'fill';
        if (value.indexOf('/') !== -1) {
          const parts = value.split('/');
          const c1 = parts[0], c2 = parts[1];
          svgEl.style[property] = c1;
          if (!svgEl._blinkInterval) {
            let toggle = false;
            svgEl._blinkInterval = setInterval(function () {
              svgEl.style[property] = toggle ? c1 : c2;
              toggle = !toggle;
            }, BLINK_MS);
          }
        } else {
          this._clearBlink(svgEl);
          svgEl.style[property] = value;
        }
        break;
      }

      case 'Opacity': {
        const o = parseFloat(value);
        svgEl.style.opacity = isNaN(o) ? 1 : o;
        break;
      }

      case 'Visibility': {
        const on = value === true || value === 'true' || value === 1 || value === '1';
        svgEl.style.display = on ? '' : 'none';
        break;
      }

      case 'Rotate': {
        const angle = parseFloat(value) || 0;
        const cx = props.cx != null ? props.cx : 0;
        const cy = props.cy != null ? props.cy : 0;
        svgEl.setAttribute('transform', 'rotate(' + angle + ',' + cx + ',' + cy + ')');
        break;
      }

      case 'Bar': {
        const numVal = parseFloat(value) || 0;
        const min = props.min != null ? props.min : 0;
        const max = props.max != null ? props.max : 100;
        const orientation = props.orientation || 'Bottom';
        const denom = (max - min) || 1;
        const ratio = Math.max(0, Math.min(1, (numVal - min) / denom));

        if (orientation === 'Right' || orientation === 'Left') {
          if (!svgEl.getAttribute('data-orig-width')) {
            svgEl.setAttribute('data-orig-width', svgEl.getAttribute('width') || '100');
          }
          const origW = parseFloat(svgEl.getAttribute('data-orig-width')) || 100;
          svgEl.setAttribute('width', origW * ratio);
        } else {
          if (!svgEl.getAttribute('data-orig-height')) {
            svgEl.setAttribute('data-orig-height', svgEl.getAttribute('height') || '100');
          }
          if (!svgEl.getAttribute('data-orig-y')) {
            svgEl.setAttribute('data-orig-y', svgEl.getAttribute('y') || '0');
          }
          const origH = parseFloat(svgEl.getAttribute('data-orig-height')) || 100;
          const origY = parseFloat(svgEl.getAttribute('data-orig-y')) || 0;
          const newH = origH * ratio;
          svgEl.setAttribute('height', newH);
          if (orientation === 'Bottom') {
            svgEl.setAttribute('y', origY + origH - newH);
          }
        }
        break;
      }

      case 'Blink': {
        const on = value === true || value === 'true' || value === 1 || value === '1';
        if (on) {
          if (!svgEl._blinkInterval) {
            svgEl._blinkInterval = setInterval(function () {
              svgEl.style.visibility = svgEl.style.visibility === 'hidden' ? 'visible' : 'hidden';
            }, 300);
          }
        } else {
          this._clearBlink(svgEl);
          svgEl.style.visibility = 'visible';
        }
        break;
      }

      case 'Move': {
        const pos = parseFloat(value) || 0;
        const axis = String(props.orientation || 'X').toUpperCase();
        svgEl.setAttribute('transform', axis === 'Y' ? ('translate(0,' + pos + ')') : ('translate(' + pos + ',0)'));
        break;
      }

      case 'Scale': {
        const s = parseFloat(value) || 1;
        svgEl.setAttribute('transform', 'scale(' + s + ')');
        break;
      }

      default:
        if (this._debug) console.warn('[ins-faceplate] unhandled element type', def.type, def.dom_id);
    }
  }

  _findSvgEl(domId) {
    if (!this._svgRoot || !domId) return null;
    // CSS.escape not available in every polyfill target — fall back to
    // `[id="…"]` which handles anything the CSS selector can't.
    try {
      const q = this._svgRoot.querySelector('#' + (window.CSS && window.CSS.escape ? window.CSS.escape(domId) : domId));
      if (q) return q;
    } catch (_) { /* invalid selector */ }
    return this._svgRoot.querySelector('[id="' + String(domId).replace(/"/g, '\\"') + '"]');
  }

  _parseProps(props) {
    if (!props) return {};
    if (typeof props === 'object') return props;
    try { return JSON.parse(props); } catch (_) { return {}; }
  }

  _clearBlink(el) {
    if (el && el._blinkInterval) {
      clearInterval(el._blinkInterval);
      el._blinkInterval = null;
    }
  }

  _clearBlinks() {
    if (!this._svgRoot) return;
    const all = this._svgRoot.querySelectorAll('*');
    for (const el of all) this._clearBlink(el);
  }
}
