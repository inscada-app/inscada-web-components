/**
 * @inscada/web-components — v1.0 entry point.
 *
 * Auto-registers all custom elements on import. Also exports the Transport
 * config API for standalone (non-iframe) deployments.
 *
 * Breaking changes vs v0.3.x:
 *   - <ins-data-source> renamed to <ins-variables>
 *   - `project` attribute is now the project NAME (string, JDK21), not
 *     integer project ID. Resolution happens server-side.
 *   - New: <ins-fetch> for arbitrary REST endpoints (via Transport).
 *   - All HTTP routes through the Transport layer (auto-detects iframe
 *     proxy vs same-origin fetch). No token-in-config support — see v1.1
 *     scoped JWT plan.
 */

import dataBus, { InsDataBus } from './ins-data-bus.js';
import InsLiveValue from './ins-live-value.js';
import InsVariables from './ins-variables.js';
import InsFaceplate from './ins-faceplate.js';
import InsFetch from './ins-fetch.js';

import {
  setConfig, getConfig, getTransport, setTransport, Transport, ASSET_READER_CODE,
} from './transport/index.js';

if (typeof customElements !== 'undefined') {
  if (!customElements.get('ins-live-value')) {
    customElements.define('ins-live-value', InsLiveValue);
  }
  if (!customElements.get('ins-variables')) {
    customElements.define('ins-variables', InsVariables);
  }
  if (!customElements.get('ins-faceplate')) {
    customElements.define('ins-faceplate', InsFaceplate);
  }
  if (!customElements.get('ins-fetch')) {
    customElements.define('ins-fetch', InsFetch);
  }
}

export {
  // Components
  InsLiveValue,
  InsVariables,
  InsFaceplate,
  InsFetch,
  // Data bus
  InsDataBus,
  dataBus,
  // Transport & config
  Transport,
  getTransport,
  setTransport,
  setConfig,
  getConfig,
  ASSET_READER_CODE,
};
