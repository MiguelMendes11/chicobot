const { MUSIC_CONFIG } = require('../constants');

const DEFAULT_TTL_MS = MUSIC_CONFIG.RESOLVE_CACHE_TTL_MS;
const DEFAULT_MAX_ENTRIES = MUSIC_CONFIG.RESOLVE_CACHE_MAX_ENTRIES;

function createMetadataCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;

  const entries = new Map();
  const inflight = new Map();

  function purge(now) {
    for (const [key, slot] of entries) {
      if (slot.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    ttlMs: ttl,
    maxEntries: limit,

    get(key) {
      const slot = entries.get(key);
      if (!slot) return undefined;

      if (slot.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }

      entries.delete(key);
      entries.set(key, slot);

      return slot.value;
    },

    set(key, value) {
      const now = Date.now();
      purge(now);
      entries.delete(key);
      entries.set(key, { value, expiresAt: now + ttl });

      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },

    getInflight(key) {
      const pending = inflight.get(key);
      return pending || undefined;
    },

    setInflight(key, promise) {
      inflight.set(key, promise);
    },

    deleteInflight(key) {
      inflight.delete(key);
    },

    clear() {
      entries.clear();
      inflight.clear();
    },

    get size() {
      return entries.size;
    },

    get inflightSize() {
      return inflight.size;
    },
  };
}

const metadataCache = createMetadataCache();

module.exports = { createMetadataCache, metadataCache };
