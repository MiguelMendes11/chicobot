const MEGASENA_CONFIG = Object.freeze({
  API_URL: 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena',
  TIMEOUT_MS: 8000,
  CACHE_TTL_MS: 10 * 60 * 1000,
});

module.exports = { MEGASENA_CONFIG };
