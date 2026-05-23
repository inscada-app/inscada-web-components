/**
 * <ins-variables> — Headless data provider for inSCADA variable values.
 *
 * Subscribes a list of variables via InsDataBus (single batched fetch shared
 * with all other ins-* components on the page) and exposes their values to
 * arbitrary consumers via events, methods, properties, or template binding.
 *
 * NOTE: Renamed from <ins-data-source> in v1.0 to make the semantic clear
 *       — this component reads variable values (vs. <ins-fetch> which calls
 *       arbitrary REST endpoints).
 *
 * USAGE:
 *
 * 1) Headless (feed any chart/library):
 *
 *    <ins-variables id="plant" project="AYBIGE_HES"
 *      variables="Temp_In, Pressure, Flow_Rate" refresh="2000">
 *    </ins-variables>
 *
 *    <script>
 *      const plant = document.getElementById('plant');
 *
 *      // Reactive — listen for updates
 *      plant.addEventListener('ins-data-update', (e) => {
 *        // e.detail = { Temp_In: {value, date}, Pressure: {value, date}, ... }
 *        chart.update(e.detail);
 *      });
 *
 *      // Or imperative reads
 *      const t = plant.getValue('Temp_In');   // {value, date}
 *      const all = plant.getValues();          // full snapshot
 *
 *      // Or callback-style subscribe (auto-cleanup on disconnect)
 *      const off = plant.subscribe(data => chart.update(data));
 *      // off() to stop
 *    </script>
 *
 * 2) Template binding (no JS needed):
 *
 *    <ins-variables project="AYBIGE_HES" variables="Temp_In, Pressure">
 *      <template>
 *        <div>Temp: <b data-bind="Temp_In">--</b> °C</div>
 *        <div>Pressure: <b data-bind="Pressure">--</b> bar</div>
 *      </template>
 *    </ins-variables>
 *
 *    Optional bind modifiers on data-bind elements:
 *      data-bind="Temp_In"           — textContent (default)
 *      data-bind-format="0.1"         — toFixed(1)
 *      data-bind-attr="fill"          — set element attribute instead of textContent
 *      data-bind-style="background"   — set style property
 *
 * Attributes:
 *   project    — Project NAME (JDK21, string, required)
 *   variables  — Comma-separated variable names (required)
 *   space      — Override space (default: from transport config)
 *   refresh    — Refresh interval ms (default: from InsDataBus, usually 2000)
 *
 * Events:
 *   ins-data-update — fired on every successful refresh
 *     event.detail = { varName: { value, date }, ... }
 *   ins-data-error  — fired on fetch/individual variable error
 *     event.detail = { variable, error }
 */

import dataBus from './ins-data-bus.js';

class InsVariables extends HTMLElement {
  static get observedAttributes() {
    return ['project', 'variables', 'space', 'refresh'];
  }

  constructor() {
    super();
    this._data = {};                  // { varName: {value, date} }
    this._subscribed = [];            // [{project, name, cb}, ...]
    this._jsSubscribers = new Set();  // user .subscribe() callbacks
    this._templateRendered = false;
  }

  connectedCallback() {
    // Hide if no template (headless mode)
    if (!this.querySelector('template')) {
      this.style.display = 'none';
    } else {
      this._renderTemplate();
    }

    const refresh = this.getAttribute('refresh');
    if (refresh) {
      const ms = parseInt(refresh, 10);
      if (!isNaN(ms) && ms >= 500) dataBus.refreshMs = ms;
    }

    const space = this.getAttribute('space');
    if (space) dataBus.space = space;

    this._subscribe();
  }

  disconnectedCallback() {
    this._unsubscribe();
    this._jsSubscribers.clear();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;

    if (name === 'project' || name === 'variables') {
      this._unsubscribe();
      this._subscribe();
    } else if (name === 'space' && newVal) {
      dataBus.space = newVal;
    } else if (name === 'refresh' && newVal) {
      const ms = parseInt(newVal, 10);
      if (!isNaN(ms) && ms >= 500) dataBus.refreshMs = ms;
    }
  }

  /* ── Public API ─────────────────────────────────────── */

  /** Get a single variable value snapshot. */
  getValue(name) { return this._data[name]; }

  /** Get all current variable values (shallow copy). */
  getValues() { return { ...this._data }; }

  /** Read-only snapshot (alias of getValues). */
  get data() { return { ...this._data }; }

  /** Register a callback called on every data update. Returns unsubscribe fn. */
  subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    this._jsSubscribers.add(cb);
    if (Object.keys(this._data).length > 0) {
      try { cb({ ...this._data }); } catch (_) { /* */ }
    }
    return () => this._jsSubscribers.delete(cb);
  }

  /* ── Internal ───────────────────────────────────────── */

  _subscribe() {
    const project = this.getAttribute('project');
    const varsAttr = this.getAttribute('variables');
    if (!project || !varsAttr) return;

    const names = varsAttr.split(',').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      const cb = (entry) => this._onVarUpdate(name, entry);
      dataBus.subscribe(project, name, cb);
      this._subscribed.push({ project, name, cb });
    }
  }

  _unsubscribe() {
    for (const { project, name, cb } of this._subscribed) {
      dataBus.unsubscribe(project, name, cb);
    }
    this._subscribed = [];
    this._data = {};
  }

  _onVarUpdate(name, entry) {
    if (entry?.error) {
      this.dispatchEvent(new CustomEvent('ins-data-error', {
        detail: { variable: name, error: entry.error },
        bubbles: true,
        composed: true,
      }));
      return;
    }

    this._data[name] = { value: entry.value, date: entry.date };

    // Microtask-batched: when multiple variables arrive in the same tick,
    // listeners see one event with the full snapshot.
    if (!this._updateScheduled) {
      this._updateScheduled = true;
      Promise.resolve().then(() => {
        this._updateScheduled = false;
        this._fireUpdate();
      });
    }
  }

  _fireUpdate() {
    const snapshot = { ...this._data };

    this.dispatchEvent(new CustomEvent('ins-data-update', {
      detail: snapshot,
      bubbles: true,
      composed: true,
    }));

    for (const cb of this._jsSubscribers) {
      try { cb(snapshot); } catch (_) { /* */ }
    }

    if (this._templateRendered) {
      this._applyBindings(snapshot);
    }
  }

  /* ── Template binding ──────────────────────────────── */

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
    const elements = this.querySelectorAll('[data-bind]');
    for (const el of elements) {
      const varName = el.getAttribute('data-bind');
      const entry = snapshot[varName];
      if (!entry || entry.value == null) continue;

      let value = entry.value;

      const fmt = el.getAttribute('data-bind-format');
      if (fmt) {
        const num = Number(value);
        if (!isNaN(num)) {
          const decimals = parseInt(fmt.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(decimals)) value = num.toFixed(decimals);
        }
      }

      const bindAttr = el.getAttribute('data-bind-attr');
      if (bindAttr) { el.setAttribute(bindAttr, value); continue; }

      const bindStyle = el.getAttribute('data-bind-style');
      if (bindStyle) { el.style[bindStyle] = value; continue; }

      el.textContent = value;
    }
  }
}

export { InsVariables };
export default InsVariables;
