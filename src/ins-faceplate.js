/**
 * <ins-faceplate> — Render an inSCADA Faceplate as a Web Component
 *
 * Loads a faceplate definition (SVG + animation elements + placeholders)
 * from the inSCADA REST API, substitutes placeholder values from attributes,
 * evaluates element expressions periodically, and renders live SVG.
 *
 * Usage:
 *   <ins-faceplate
 *     project="153"
 *     name="Motor_Standard"
 *     space="claude"
 *     duration="2000"
 *     motor_name="Motor 1"
 *     speed_var="M1_Speed"
 *     status_var="M1_Status">
 *   </ins-faceplate>
 *
 * Attributes:
 *   project   — Project ID (required)
 *   name      — Faceplate name (required)
 *   space     — Space name (default: "default_space")
 *   duration  — Refresh interval in ms (default: 2000)
 *   width     — SVG width (default: auto)
 *   height    — SVG height (default: auto)
 *   Any other attribute is treated as a placeholder value.
 */

const RESERVED_ATTRS = new Set(['project', 'name', 'space', 'duration', 'width', 'height', 'style', 'class', 'id']);

export default class InsFaceplate extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._faceplate = null;
    this._elements = [];
    this._placeholders = {};
    this._timer = null;
    this._loaded = false;
  }

  static get observedAttributes() {
    return ['project', 'name', 'space', 'duration'];
  }

  connectedCallback() {
    this._render();
    this._load();
  }

  disconnectedCallback() {
    this._stopPolling();
  }

  attributeChangedCallback(attr, oldVal, newVal) {
    if (oldVal !== newVal && this._loaded) {
      this._load();
    }
  }

  get project() { return this.getAttribute('project'); }
  get facplateName() { return this.getAttribute('name'); }
  get space() { return this.getAttribute('space') || 'default_space'; }
  get duration() { return parseInt(this.getAttribute('duration') || '2000', 10); }

  /** Collect all non-reserved attributes as placeholder values */
  _getPlaceholderValues() {
    const values = {};
    for (const attr of this.attributes) {
      if (!RESERVED_ATTRS.has(attr.name.toLowerCase())) {
        values[attr.name] = attr.value;
      }
    }
    return values;
  }

  /** Initial loading indicator */
  _render() {
    const w = this.getAttribute('width') || '100%';
    const h = this.getAttribute('height') || 'auto';
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; width: ${w}; height: ${h}; }
        .container { width: 100%; height: 100%; position: relative; }
        .container svg { width: 100%; height: 100%; }
        .loading { color: #888; font-size: 12px; text-align: center; padding: 20px; font-family: sans-serif; }
        .error { color: #c00; font-size: 12px; text-align: center; padding: 10px; font-family: sans-serif; }
      </style>
      <div class="container">
        <div class="loading">Loading faceplate...</div>
      </div>
    `;
  }

  /** Load faceplate from REST API */
  async _load() {
    const projectId = this.project;
    const name = this.facplateName;
    if (!projectId || !name) {
      this._showError('Missing project or name attribute');
      return;
    }

    try {
      // Fetch faceplate by project and name
      const fpResp = await fetch(
        `/api/faceplates/project/names?projectId=${projectId}&names=${encodeURIComponent(name)}`,
        { credentials: 'include', headers: { 'X-Space': this.space } }
      );
      const fpData = await fpResp.json();
      const fp = Array.isArray(fpData) ? fpData[0] : fpData[name];

      if (!fp) {
        this._showError(`Faceplate "${name}" not found in project ${projectId}`);
        return;
      }

      this._faceplate = fp;

      // Fetch SVG content
      const svgResp = await fetch(
        `/api/faceplates/${fp.id}/svg`,
        { credentials: 'include', headers: { 'X-Space': this.space } }
      );
      const svgContent = await svgResp.text();

      // Fetch elements (animation bindings)
      const elemResp = await fetch(
        `/api/faceplates/${fp.id}/elements`,
        { credentials: 'include', headers: { 'X-Space': this.space } }
      );
      this._elements = await elemResp.json();

      // Fetch placeholders definition
      const phResp = await fetch(
        `/api/faceplates/${fp.id}/placeholders`,
        { credentials: 'include', headers: { 'X-Space': this.space } }
      );
      const placeholderDefs = await phResp.json();

      // Get placeholder values from attributes
      this._placeholders = this._getPlaceholderValues();

      // Render SVG
      this._renderSvg(svgContent);
      this._loaded = true;

      // Start polling for live data
      this._startPolling();

    } catch (err) {
      this._showError('Failed to load faceplate: ' + err.message);
    }
  }

  /** Render the faceplate SVG into shadow DOM */
  _renderSvg(svgContent) {
    const w = this.getAttribute('width') || '100%';
    const h = this.getAttribute('height') || 'auto';
    const container = this.shadowRoot.querySelector('.container');
    if (!container) return;

    container.innerHTML = svgContent;

    // Set SVG dimensions
    const svg = container.querySelector('svg');
    if (svg) {
      if (w !== 'auto') svg.style.width = w;
      if (h !== 'auto') svg.style.height = h;
    }
  }

  /** Substitute placeholders in expression: $name$ → value */
  _substituteExpression(expression) {
    let result = expression;
    for (const [key, value] of Object.entries(this._placeholders)) {
      const pattern = new RegExp('\\$' + key + '\\$', 'g');
      result = result.replace(pattern, value);
    }
    return result;
  }

  /** Evaluate all element expressions in a single batch API call */
  async _evaluate() {
    if (!this._faceplate || this._elements.length === 0) return;

    const projectId = this.project;

    // Separate TEXT elements (no execution needed) from EXPRESSION elements
    const textElems = [];
    const exprElems = [];

    for (const elem of this._elements) {
      const substituted = this._substituteExpression(elem.expression);
      if (elem.expressionType === 'TEXT') {
        textElems.push({ elem, value: substituted });
      } else {
        exprElems.push({ elem, expression: substituted });
      }
    }

    // Apply TEXT values immediately
    for (const { elem, value } of textElems) {
      this._applyValue(elem, value);
    }

    // Build a single script that evaluates all expressions and returns results as JSON
    if (exprElems.length === 0) return;

    // Each expression wrapped in a safe function, results collected in an object keyed by domId
    // 'return' works inside functions — keep it if present, add it if missing
    const parts = exprElems.map(({ elem, expression }) => {
      let code = expression.trim();
      // If expression doesn't contain 'return', add 'return' before the last statement
      if (!code.includes('return ')) {
        // Single expression — wrap with return
        code = 'return ' + code;
      }
      return `try { __r["${elem.domId}"] = (function(){ ${code} })(); } catch(e) { __r["${elem.domId}"] = null; }`;
    });

    const batchCode = `var __r = {};\n${parts.join('\n')}\nins.toJSONStr(__r);`;

    try {
      const resp = await fetch('/api/scripts/runner', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Space': this.space
        },
        body: JSON.stringify({
          projectId: parseInt(projectId),
          name: 'faceplate_batch',
          code: batchCode,
          log: false,
          compile: false
        })
      });

      if (!resp.ok) return;

      const resultText = await resp.text();
      let results;
      try {
        results = JSON.parse(resultText);
      } catch {
        return;
      }

      // Apply each result to its element
      for (const { elem } of exprElems) {
        if (elem.domId in results && results[elem.domId] !== null) {
          this._applyValue(elem, String(results[elem.domId]));
        }
      }
    } catch (err) {
      // Silently skip batch evaluation errors
    }
  }

  /** Apply evaluated value to SVG element based on animation type */
  _applyValue(elem, rawValue) {
    const el = this.shadowRoot.querySelector(`#${elem.domId}`) ||
               this.shadowRoot.querySelector(`[id="${elem.domId}"]`);
    if (!el) return;

    // Clean up raw value — remove surrounding quotes if present
    let cleaned = rawValue;
    if (typeof cleaned === 'string') {
      cleaned = cleaned.trim();
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
          (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
    }

    let value;
    try {
      value = JSON.parse(cleaned);
    } catch {
      value = cleaned;
    }

    const type = elem.type;

    switch (type) {
      case 'Get':
        el.textContent = value != null ? String(value) : '';
        break;

      case 'Color':
        if (typeof value === 'string') {
          if (value.includes('/')) {
            // Blink between two colors
            const [c1, c2] = value.split('/');
            el.style.fill = c1;
            // Simple blink via animation
            if (!el._blinkInterval) {
              let toggle = false;
              el._blinkInterval = setInterval(() => {
                el.style.fill = toggle ? c1 : c2;
                toggle = !toggle;
              }, 500);
            }
          } else {
            if (el._blinkInterval) { clearInterval(el._blinkInterval); el._blinkInterval = null; }
            el.style.fill = value;
          }
        }
        break;

      case 'Opacity':
        el.style.opacity = parseFloat(value) || 1;
        break;

      case 'Visibility':
        el.style.display = value ? '' : 'none';
        break;

      case 'Rotate': {
        const angle = parseFloat(value) || 0;
        const props = JSON.parse(elem.props || '{}');
        const cx = props.cx || 0;
        const cy = props.cy || 0;
        el.setAttribute('transform', `rotate(${angle}, ${cx}, ${cy})`);
        break;
      }

      case 'Bar': {
        const numVal = parseFloat(value) || 0;
        const props = JSON.parse(elem.props || '{}');
        const min = props.min || 0;
        const max = props.max || 100;
        const ratio = Math.max(0, Math.min(1, (numVal - min) / (max - min)));
        const orientation = props.orientation || 'Bottom';

        if (orientation === 'Right' || orientation === 'Left') {
          const origW = parseFloat(el.getAttribute('width')) || 100;
          el.setAttribute('width', origW * ratio);
        } else {
          const origH = parseFloat(el.getAttribute('height')) || 100;
          const newH = origH * ratio;
          el.setAttribute('height', newH);
          if (orientation === 'Bottom') {
            const origY = parseFloat(el.getAttribute('data-orig-y') || el.getAttribute('y')) || 0;
            if (!el.getAttribute('data-orig-y')) el.setAttribute('data-orig-y', el.getAttribute('y'));
            el.setAttribute('y', origY + origH - newH);
          }
        }
        break;
      }

      case 'Blink':
        if (value === true || value === 'true') {
          if (!el._blinkInterval) {
            el._blinkInterval = setInterval(() => {
              el.style.visibility = el.style.visibility === 'hidden' ? 'visible' : 'hidden';
            }, 300);
          }
        } else {
          if (el._blinkInterval) { clearInterval(el._blinkInterval); el._blinkInterval = null; }
          el.style.visibility = 'visible';
        }
        break;

      case 'Move': {
        const pos = parseFloat(value) || 0;
        el.setAttribute('transform', `translate(${pos}, 0)`);
        break;
      }

      case 'Scale': {
        const scale = parseFloat(value) || 1;
        el.setAttribute('transform', `scale(${scale})`);
        break;
      }

      default:
        // For unhandled types, try setting textContent
        if (value != null) el.textContent = String(value);
        break;
    }
  }

  _startPolling() {
    this._stopPolling();
    this._evaluate(); // First evaluation
    this._timer = setInterval(() => this._evaluate(), this.duration);
  }

  _stopPolling() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Clean up blink intervals
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll('*').forEach(el => {
        if (el._blinkInterval) { clearInterval(el._blinkInterval); el._blinkInterval = null; }
      });
    }
  }

  _showError(msg) {
    const container = this.shadowRoot.querySelector('.container');
    if (container) {
      container.innerHTML = `<div class="error">${msg}</div>`;
    }
  }
}
