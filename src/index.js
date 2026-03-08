export { InsDataBus } from './ins-data-bus.js';
export { InsLiveValue } from './ins-live-value.js';
import dataBus from './ins-data-bus.js';
import InsLiveValue from './ins-live-value.js';

if (!customElements.get('ins-live-value')) {
  customElements.define('ins-live-value', InsLiveValue);
}

export { dataBus };
