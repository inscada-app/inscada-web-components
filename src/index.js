export { InsDataBus } from './ins-data-bus.js';
export { InsLiveValue } from './ins-live-value.js';
export { default as InsFaceplate } from './ins-faceplate.js';
export { InsDataSource } from './ins-data-source.js';
import dataBus from './ins-data-bus.js';
import InsLiveValue from './ins-live-value.js';
import InsFaceplate from './ins-faceplate.js';
import InsDataSource from './ins-data-source.js';

if (!customElements.get('ins-live-value')) {
  customElements.define('ins-live-value', InsLiveValue);
}

if (!customElements.get('ins-faceplate')) {
  customElements.define('ins-faceplate', InsFaceplate);
}

if (!customElements.get('ins-data-source')) {
  customElements.define('ins-data-source', InsDataSource);
}

export { dataBus };
