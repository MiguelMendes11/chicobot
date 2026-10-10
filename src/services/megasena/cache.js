const { MEGASENA_CONFIG } = require('./constants');

function createMegaSenaCache({ ttlMs = MEGASENA_CONFIG.CACHE_TTL_MS } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : MEGASENA_CONFIG.CACHE_TTL_MS;

  let entry = null;
  let inflight = null;

  return {
    ttlMs: ttl,

    get() {
      if (!entry) return undefined;

      if (entry.expiresAt <= Date.now()) {
        entry = null;
        return undefined;
      }

      return entry.value;
    },

    set(value) {
      entry = { value, expiresAt: Date.now() + ttl };
    },

    getInflight() {
      return inflight || undefined;
    },

    setInflight(promise) {
      inflight = promise;
    },

    deleteInflight() {
      inflight = null;
    },

    clear() {
      entry = null;
      inflight = null;
    },

    get size() {
      return entry ? 1 : 0;
    },

    get inflightSize() {
      return inflight ? 1 : 0;
    },
  };
}

const megaSenaCache = createMegaSenaCache();

module.exports = { createMegaSenaCache, megaSenaCache };
