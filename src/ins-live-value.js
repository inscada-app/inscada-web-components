/**
 * <ins-live-value> — Canlı SCADA değeri gösteren Web Component.
 *
 * Kullanım (JDK21 — project = project NAME, string):
 *   <ins-live-value project="AYBIGE_HES" variable="Temp_In" unit="°C"
 *     label="Sıcaklık" decimals="1" thresholds="0:blue,30:green,60:orange,80:red">
 *   </ins-live-value>
 *
 * Auto-detects iframe (uses InscadaApi proxy) vs standalone (uses fetch with
 * same-origin cookie). All HTTP routes through the Transport layer.
 */
import dataBus from './ins-data-bus.js';

const STALE_TICKS = 3;

const STYLES = `
:host {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 1em;
  transition: opacity 0.3s;
}
:host(.stale) {
  opacity: var(--stale-opacity, 0.4);
}
.label {
  color: var(--label-color, #888);
  font-size: 0.85em;
}
.value {
  color: var(--value-color, inherit);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.unit {
  color: var(--unit-color, #888);
  font-size: 0.85em;
}
.error {
  color: #d32f2f;
  font-size: 0.85em;
}
`;

class InsLiveValue extends HTMLElement {
  static get observedAttributes() {
    return ['project', 'variable', 'unit', 'label', 'decimals', 'thresholds', 'format'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <span class="label"></span>
      <span class="value">--</span>
      <span class="unit"></span>`;

    this._elLabel = this.shadowRoot.querySelector('.label');
    this._elValue = this.shadowRoot.querySelector('.value');
    this._elUnit = this.shadowRoot.querySelector('.unit');

    this._callback = (data) => this._onData(data);
    this._staleTicks = 0;
    this._thresholds = [];
  }

  connectedCallback() {
    this._updateStatic();
    this._parseThresholds();
    this._sub();
  }

  disconnectedCallback() {
    this._unsub();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;

    if (name === 'project' || name === 'variable') {
      // Re-subscribe
      this._unsub();
      this._sub();
    } else if (name === 'thresholds') {
      this._parseThresholds();
    } else {
      this._updateStatic();
    }
  }

  /* ── Subscription ──────────────────────────────────── */

  _sub() {
    const pid = this.getAttribute('project');
    const vname = this.getAttribute('variable');
    if (pid && vname) {
      dataBus.subscribe(pid, vname, this._callback);
    }
  }

  _unsub() {
    const pid = this.getAttribute('project');
    const vname = this.getAttribute('variable');
    if (pid && vname) {
      dataBus.unsubscribe(pid, vname, this._callback);
    }
  }

  /* ── Data handling ─────────────────────────────────── */

  _onData(data) {
    if (data.error) {
      this._staleTicks++;
      if (this._staleTicks >= STALE_TICKS) {
        this.classList.add('stale');
      }
      return;
    }

    this._staleTicks = 0;
    this.classList.remove('stale');

    const raw = data.value;
    const num = Number(raw);
    const decimals = this.getAttribute('decimals');
    const format = this.getAttribute('format');

    let display;
    if (format === 'raw') {
      display = String(raw);
    } else if (!isNaN(num) && decimals !== null) {
      display = num.toFixed(parseInt(decimals, 10) || 0);
    } else {
      display = String(raw);
    }

    this._elValue.textContent = display;
    this._applyThresholdColor(num);
  }

  /* ── Threshold renk değişimi ───────────────────────── */

  _parseThresholds() {
    const attr = this.getAttribute('thresholds');
    if (!attr) { this._thresholds = []; return; }

    // "0:blue,30:green,60:orange,80:red"
    this._thresholds = attr.split(',').map(pair => {
      const [val, color] = pair.trim().split(':');
      return { min: parseFloat(val), color: color.trim() };
    }).sort((a, b) => a.min - b.min);
  }

  _applyThresholdColor(num) {
    if (this._thresholds.length === 0 || isNaN(num)) return;

    let color = this._thresholds[0].color;
    for (const t of this._thresholds) {
      if (num >= t.min) color = t.color;
      else break;
    }
    this._elValue.style.color = color;
  }

  /* ── Static attribute render ───────────────────────── */

  _updateStatic() {
    this._elLabel.textContent = this.getAttribute('label') || '';
    this._elUnit.textContent = this.getAttribute('unit') || '';
  }
}

export { InsLiveValue };
export default InsLiveValue;
