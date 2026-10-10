const { fetchLatestResult } = require('./http');
const { validateResult } = require('./validate');
const { megaSenaCache } = require('./cache');

async function fetchAndValidate({ cache, fetchImpl, timeoutMs, url }) {
  try {
    const payload = await fetchLatestResult({ fetchImpl, timeoutMs, url });
    const result = validateResult(payload);

    cache.set(result);

    return result;
  } finally {
    cache.deleteInflight();
  }
}

async function getLatestResult({ cache = megaSenaCache, fetchImpl, timeoutMs, url } = {}) {
  const cached = cache.get();
  if (cached !== undefined) return cached;

  const pending = cache.getInflight();
  if (pending) return pending;

  const loading = fetchAndValidate({ cache, fetchImpl, timeoutMs, url });
  cache.setInflight(loading);

  return loading;
}

function clearResultCache() {
  megaSenaCache.clear();
}

module.exports = { getLatestResult, clearResultCache };
