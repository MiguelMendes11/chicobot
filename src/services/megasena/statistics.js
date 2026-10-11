const fs = require('node:fs');
const path = require('node:path');
const { createMegaSenaError } = require('./errors');

const MIN_DEZENA = 1;
const MAX_DEZENA = 60;
const DEZENA_COUNT = 60;
const DRAW_COUNT = 6;
const RANKING_SIZE = 6;
const DEFAULT_SNAPSHOT_PATH = path.join(__dirname, '..', '..', '..', 'data', 'megasena-frequencias.json');

function invalidSnapshot(details) {
  throw createMegaSenaError('HISTORY_INVALID', { details });
}

function parseInteger(value) {
  if (Number.isInteger(value)) return value;

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  }

  return null;
}

function validateMetadata(snapshot) {
  const fonte = typeof snapshot.fonte === 'string' ? snapshot.fonte.trim() : '';
  if (!fonte) invalidSnapshot('fonte ausente');

  const geradoEm = typeof snapshot.geradoEm === 'string' ? snapshot.geradoEm.trim() : '';
  if (!geradoEm || Number.isNaN(Date.parse(geradoEm))) invalidSnapshot('geradoEm inválido');

  const ateConcurso = snapshot.ateConcurso;
  if (!Number.isInteger(ateConcurso) || ateConcurso <= 0) invalidSnapshot('ateConcurso inválido');

  return { fonte, geradoEm, ateConcurso };
}

function validateContagens(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidSnapshot('contagens ausentes');

  const keys = Object.keys(raw);
  if (keys.length !== DEZENA_COUNT) invalidSnapshot(`esperadas 60 dezenas, encontradas ${keys.length}`);

  const contagens = {};
  let total = 0;

  for (const key of keys) {
    const dezena = parseInteger(key);
    if (dezena === null || dezena < MIN_DEZENA || dezena > MAX_DEZENA) invalidSnapshot(`dezena inválida: ${key}`);

    const normalized = String(dezena);
    if (Object.prototype.hasOwnProperty.call(contagens, normalized)) invalidSnapshot(`dezena duplicada: ${key}`);

    const count = raw[key];
    if (typeof count !== 'number' || !Number.isInteger(count)) {
      invalidSnapshot(`contagem não inteira para a dezena ${normalized}`);
    }
    if (count < 0) invalidSnapshot(`contagem negativa para a dezena ${normalized}`);

    contagens[normalized] = count;
    total += count;
  }

  if (Object.keys(contagens).length !== DEZENA_COUNT) invalidSnapshot('conjunto de dezenas incompleto');

  return { contagens, total };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    invalidSnapshot('snapshot não é um objeto');
  }

  const metadata = validateMetadata(snapshot);
  const { contagens, total } = validateContagens(snapshot.contagens);
  const esperado = metadata.ateConcurso * DRAW_COUNT;

  if (total !== esperado) {
    invalidSnapshot(`soma das contagens (${total}) difere de 6 × ateConcurso (${esperado})`);
  }

  return { ...metadata, contagens, totalAparicoes: total };
}

async function loadSnapshot({ filePath = DEFAULT_SNAPSHOT_PATH, fsImpl = fs.promises } = {}) {
  let raw;

  try {
    raw = await fsImpl.readFile(filePath, 'utf8');
  } catch (error) {
    throw createMegaSenaError('HISTORY_UNAVAILABLE', { details: error && error.code, cause: error });
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw createMegaSenaError('HISTORY_INVALID', { details: 'JSON inválido', cause: error });
  }

  return validateSnapshot(parsed);
}

function buildRankings(contagens, limit = RANKING_SIZE) {
  const entries = Object.entries(contagens || {})
    .map(([dezena, contagem]) => ({ dezena: Number(dezena), contagem }))
    .sort((a, b) => a.dezena - b.dezena);

  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, entries.length) : RANKING_SIZE;

  const maisSorteadas = [...entries]
    .sort((a, b) => b.contagem - a.contagem || a.dezena - b.dezena)
    .slice(0, size);

  const menosSorteadas = [...entries]
    .sort((a, b) => a.contagem - b.contagem || a.dezena - b.dezena)
    .slice(0, size);

  return { maisSorteadas, menosSorteadas };
}

async function getStatistics(options = {}) {
  const snapshot = await loadSnapshot(options);
  const rankings = buildRankings(snapshot.contagens, options.limit);

  return { ...snapshot, ...rankings };
}

module.exports = {
  getStatistics,
  loadSnapshot,
  validateSnapshot,
  buildRankings,
  DEFAULT_SNAPSHOT_PATH,
  DEZENA_COUNT,
  RANKING_SIZE,
};
