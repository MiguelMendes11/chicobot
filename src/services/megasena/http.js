const { MEGASENA_CONFIG } = require('./constants');
const { createMegaSenaError } = require('./errors');

function isAbortError(error) {
  if (!error) return false;
  return error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 20;
}

function statusOf(response) {
  if (response && Number.isFinite(response.status)) return response.status;
  if (response && response.ok === true) return 200;
  return 0;
}

function assertUsableResponse(response) {
  if (!response || typeof response !== 'object') {
    throw createMegaSenaError('UNAVAILABLE');
  }

  const status = statusOf(response);
  const ok = response.ok === true || (status >= 200 && status < 300);

  if (ok) return;

  if (status === 403) throw createMegaSenaError('FORBIDDEN', { details: 'HTTP 403' });
  if (status === 429) throw createMegaSenaError('RATE_LIMITED', { details: 'HTTP 429' });
  if (status >= 500 && status < 600) {
    throw createMegaSenaError('SERVER_ERROR', { details: `HTTP ${status}` });
  }

  throw createMegaSenaError('UNAVAILABLE', { details: status ? `HTTP ${status}` : undefined });
}

async function fetchLatestResult({
  fetchImpl = globalThis.fetch,
  url = MEGASENA_CONFIG.API_URL,
  timeoutMs = MEGASENA_CONFIG.TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw createMegaSenaError('UNAVAILABLE');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;

  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ChicoBot/1.0' },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw createMegaSenaError('TIMEOUT', { details: `${timeoutMs}ms`, cause: error });
    }
    throw createMegaSenaError('UNAVAILABLE', { cause: error });
  } finally {
    clearTimeout(timer);
  }

  assertUsableResponse(response);

  if (typeof response.json !== 'function') throw createMegaSenaError('INVALID_RESPONSE');

  try {
    return await response.json();
  } catch (error) {
    throw createMegaSenaError('INVALID_RESPONSE', { cause: error });
  }
}

module.exports = { fetchLatestResult, isAbortError, statusOf };
