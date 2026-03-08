/**
 * InsDataBus — Singleton merkezi veri yönetimi.
 * Aynı sayfadaki tüm <ins-*> component'ları tek batch fetch ile besler.
 */

const DEFAULT_REFRESH_MS = 2000;
const DEFAULT_SPACE = 'default_space';

class InsDataBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} key: "projectId:varName" */
    this._subscribers = new Map();
    this._intervalId = null;
    this._refreshMs = DEFAULT_REFRESH_MS;
    this._space = DEFAULT_SPACE;
  }

  /* ── Public API ─────────────────────────────────────── */

  get refreshMs() { return this._refreshMs; }
  set refreshMs(ms) {
    this._refreshMs = Math.max(500, ms);
    if (this._intervalId) {
      this._stopPolling();
      this._startPolling();
    }
  }

  get space() { return this._space; }
  set space(val) { this._space = val || DEFAULT_SPACE; }

  /**
   * Component kayıt. İlk subscriber'da polling başlar.
   * @param {number|string} projectId
   * @param {string} varName
   * @param {Function} callback — ({value, date} | {error}) ile çağrılır
   */
  subscribe(projectId, varName, callback) {
    const key = `${projectId}:${varName}`;
    if (!this._subscribers.has(key)) {
      this._subscribers.set(key, new Set());
    }
    this._subscribers.get(key).add(callback);

    if (!this._intervalId) {
      this._startPolling();
    }
  }

  /**
   * Component çıkış. Son subscriber'da polling durur.
   */
  unsubscribe(projectId, varName, callback) {
    const key = `${projectId}:${varName}`;
    const set = this._subscribers.get(key);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      this._subscribers.delete(key);
    }
    if (this._subscribers.size === 0) {
      this._stopPolling();
    }
  }

  /* ── Internal ───────────────────────────────────────── */

  _startPolling() {
    this._tick(); // ilk fetch hemen
    this._intervalId = setInterval(() => this._tick(), this._refreshMs);
  }

  _stopPolling() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Her tick'te projectId bazlı gruplama → batch fetch.
   */
  async _tick() {
    // Grup: projectId → [varName, ...]
    const groups = new Map();
    for (const key of this._subscribers.keys()) {
      const [pid, vname] = key.split(':');
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(vname);
    }

    // Her proje için tek batch fetch
    const fetches = [];
    for (const [pid, names] of groups) {
      fetches.push(this._fetchBatch(pid, names));
    }
    await Promise.allSettled(fetches);
  }

  async _fetchBatch(projectId, names) {
    const namesParam = names.join(',');
    const url = `/api/variables/values?projectId=${projectId}&names=${encodeURIComponent(namesParam)}`;

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Space': this._space }
      });

      if (!res.ok) {
        const errMsg = `HTTP ${res.status}`;
        this._notifyError(projectId, names, errMsg);
        return;
      }

      const data = await res.json();
      this._dispatchValues(projectId, names, data);
    } catch (err) {
      this._notifyError(projectId, names, err.message);
    }
  }

  _dispatchValues(projectId, names, data) {
    for (const varName of names) {
      const key = `${projectId}:${varName}`;
      const subs = this._subscribers.get(key);
      if (!subs || subs.size === 0) continue;

      // inSCADA response: { varName: { value, date, ... } } veya doğrudan { value, date }
      const entry = data[varName] || data;
      const value = entry?.value ?? entry?.data?.value;
      const date = entry?.date ?? entry?.data?.date;

      const payload = value !== undefined
        ? { value, date }
        : { error: 'no data' };

      for (const cb of subs) {
        try { cb(payload); } catch (_) { /* subscriber hatası yutulur */ }
      }
    }
  }

  _notifyError(projectId, names, message) {
    for (const varName of names) {
      const key = `${projectId}:${varName}`;
      const subs = this._subscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb({ error: message }); } catch (_) { /* */ }
      }
    }
  }
}

// Singleton — sayfa başına tek instance
if (!window.__insDataBus) {
  window.__insDataBus = new InsDataBus();
}

export { InsDataBus };
export default window.__insDataBus;
