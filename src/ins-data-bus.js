/**
 * InsDataBus — Singleton variable-subscription coordinator.
 *
 * Multiple <ins-live-value> / <ins-variables> components on the same page
 * share this bus: subscriptions are grouped by projectName and fetched in a
 * single batched call per tick, so N components asking for M variables
 * still produce only one HTTP request per project per polling cycle.
 *
 * v1.0 — refactored to delegate HTTP to the Transport layer. The bus no
 * longer knows about endpoint paths, auth, or environment (iframe vs
 * standalone) — that's all in transport/index.js.
 */

import { getTransport } from './transport/index.js';

const DEFAULT_REFRESH_MS = 2000;

class InsDataBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} key: "projectName:varName" */
    this._subscribers = new Map();
    this._intervalId = null;
    this._refreshMs = DEFAULT_REFRESH_MS;
    this._pollingActive = false;

    // Visibility-aware polling — pause when tab hidden, resume when visible.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this._onVisibilityChange());
    }
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

  /** Convenience pass-through to transport.space. */
  get space() { return getTransport().space; }
  set space(val) { getTransport().setSpace(val); }

  /**
   * Subscribe a callback to a (projectName, varName) pair.
   * Starts polling on first subscriber.
   *
   * @param {string} projectName  inSCADA project name (JDK21)
   * @param {string} varName      variable name
   * @param {(payload: {value, date}|{error: string}) => void} callback
   */
  subscribe(projectName, varName, callback) {
    const key = `${projectName}:${varName}`;
    let set = this._subscribers.get(key);
    if (!set) {
      set = new Set();
      this._subscribers.set(key, set);
    }
    set.add(callback);

    if (!this._intervalId && !document?.hidden) {
      this._startPolling();
    }
  }

  /**
   * Unsubscribe. Stops polling when last subscriber leaves.
   */
  unsubscribe(projectName, varName, callback) {
    const key = `${projectName}:${varName}`;
    const set = this._subscribers.get(key);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) this._subscribers.delete(key);
    if (this._subscribers.size === 0) this._stopPolling();
  }

  /** Force an immediate fetch outside the polling cycle. */
  refreshNow() {
    return this._tick();
  }

  /* ── Internal ───────────────────────────────────────── */

  _startPolling() {
    this._pollingActive = true;
    this._tick(); // fire immediately
    this._intervalId = setInterval(() => this._tick(), this._refreshMs);
  }

  _stopPolling() {
    this._pollingActive = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  _onVisibilityChange() {
    if (document.hidden) {
      // Pause polling while tab is hidden — saves bandwidth.
      if (this._intervalId) {
        clearInterval(this._intervalId);
        this._intervalId = null;
      }
    } else if (this._pollingActive && this._subscribers.size > 0 && !this._intervalId) {
      // Tab visible again — resume.
      this._startPolling();
    }
  }

  /**
   * One polling tick: group all subscribers by projectName, fire one batched
   * fetch per group via the transport.
   */
  async _tick() {
    if (this._subscribers.size === 0) return;

    const groups = new Map(); // projectName → string[] names
    for (const key of this._subscribers.keys()) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      const projectName = key.slice(0, idx);
      const varName = key.slice(idx + 1);
      let names = groups.get(projectName);
      if (!names) { names = []; groups.set(projectName, names); }
      names.push(varName);
    }

    const transport = getTransport();
    const fetches = [];
    for (const [projectName, names] of groups) {
      fetches.push(this._fetchGroup(transport, projectName, names));
    }
    await Promise.allSettled(fetches);
  }

  async _fetchGroup(transport, projectName, names) {
    try {
      const data = await transport.fetchVariables(projectName, names);
      this._dispatchValues(projectName, names, data);
    } catch (err) {
      this._notifyError(projectName, names, err?.message || String(err));
    }
  }

  _dispatchValues(projectName, names, data) {
    // Backend returns Map<name, VariableValueDto> — { name: { value, date, ... } }
    for (const varName of names) {
      const key = `${projectName}:${varName}`;
      const subs = this._subscribers.get(key);
      if (!subs || subs.size === 0) continue;

      const entry = data?.[varName];
      const payload = entry && entry.value !== undefined
        ? { value: entry.value, date: entry.date }
        : { error: 'no data' };

      for (const cb of subs) {
        try { cb(payload); } catch (_) { /* subscriber error swallowed */ }
      }
    }
  }

  _notifyError(projectName, names, message) {
    for (const varName of names) {
      const key = `${projectName}:${varName}`;
      const subs = this._subscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb({ error: message }); } catch (_) { /* */ }
      }
    }
  }
}

// Singleton — one instance per page.
if (typeof window !== 'undefined' && !window.__insDataBus) {
  window.__insDataBus = new InsDataBus();
}

export { InsDataBus };
export default (typeof window !== 'undefined' ? window.__insDataBus : new InsDataBus());
