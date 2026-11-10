/**
 * dsh-browser-sidecar context store — the in-memory snapshot warehouse behind
 * /__bridge/* and the `browser_page` tool.
 *
 * One snapshot per Chrome tab, capped at LIMITS.maxTabs with LRU eviction (the
 * tab whose snapshot was refreshed longest ago is dropped first). Nothing is
 * persisted in v1: the extension re-syncs on demand, and writing page content to
 * disk would widen the privacy surface for no product gain.
 */
import { LIMITS, summarizeSnapshot, sanitizeSnapshot } from './core.js';

export class ContextStore {
  /**
   * @param {{ maxTabs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.maxTabs = Number.isSafeInteger(options.maxTabs) && options.maxTabs > 0 ? options.maxTabs : LIMITS.maxTabs;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {Map<number, object>} insertion order doubles as LRU order */
    this.snapshots = new Map();
    /** @type {number|undefined} */
    this.activeTabId = undefined;
    /** @type {string|null} ISO timestamp of the newest accepted snapshot. */
    this.updatedAt = null;
  }

  /**
   * Validate, normalize and store one snapshot; marks its tab active when the
   * extension says so (or when no active tab is known yet).
   *
   * @param {unknown} raw - POST /__bridge/context body
   * @returns {{ snapshot: object, activeTabId: number|undefined }}
   * @throws {import('./core.js').BridgeError} on invalid required fields
   */
  upsert(raw) {
    const snapshot = sanitizeSnapshot(raw, { now: this.now });
    this.snapshots.delete(snapshot.tabId);
    this.snapshots.set(snapshot.tabId, snapshot);
    while (this.snapshots.size > this.maxTabs) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done === true) break;
      this.snapshots.delete(oldest.value);
      if (this.activeTabId === oldest.value) this.activeTabId = undefined;
    }
    if (snapshot.active || this.activeTabId === undefined) {
      this.activeTabId = snapshot.tabId;
      // Exactly one snapshot may claim `active`; older tabs keep their content
      // but stop pretending they are the focused tab.
      for (const other of this.snapshots.values()) other.active = other.tabId === this.activeTabId;
    }
    this.updatedAt = snapshot.receivedAt;
    return { snapshot, activeTabId: this.activeTabId };
  }

  /**
   * Switch the active tab without re-sending its (unchanged) content. The
   * extension calls this on tab activation/focus even when its snapshot is
   * deduplicated, so `latest` and `browser_page` keep following the user.
   *
   * @param {number} tabId - numeric Chrome tab id
   * @returns {boolean} false when that tab has no snapshot yet
   */
  setActive(tabId) {
    if (!Number.isSafeInteger(tabId) || !this.snapshots.has(tabId)) return false;
    this.activeTabId = tabId;
    for (const other of this.snapshots.values()) other.active = other.tabId === tabId;
    return true;
  }

  /**
   * Latest snapshot for one tab (default: the active tab).
   *
   * @param {number|string|undefined} tabId - numeric tab id, or undefined for active
   * @returns {object|undefined}
   */
  latest(tabId) {
    if (tabId !== undefined && tabId !== null && tabId !== '') {
      const numeric = typeof tabId === 'number' ? tabId : Number(tabId);
      if (!Number.isSafeInteger(numeric)) return undefined;
      return this.snapshots.get(numeric);
    }
    if (this.activeTabId !== undefined) return this.snapshots.get(this.activeTabId);
    // No explicit active flag ever arrived: fall back to the newest snapshot so a
    // single-tab session still works.
    let newest;
    for (const snapshot of this.snapshots.values()) newest = snapshot;
    return newest;
  }

  /** Verified active tab id, or null. */
  getActiveTabId() {
    return this.activeTabId !== undefined && this.snapshots.has(this.activeTabId) ? this.activeTabId : null;
  }

  /** Summaries, newest first (bounded by maxTabs). */
  list() {
    const rows = [];
    for (const snapshot of this.snapshots.values()) rows.push(summarizeSnapshot(snapshot));
    rows.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    return rows;
  }

  /** Health fragment for GET /__bridge/health. */
  health() {
    return {
      tabs: this.snapshots.size,
      activeTabId: this.getActiveTabId(),
      updatedAt: this.updatedAt,
    };
  }

  /** Drop everything (tests / plugin teardown). */
  clear() {
    this.snapshots.clear();
    this.activeTabId = undefined;
    this.updatedAt = null;
  }
}
