const { createMegaSenaError } = require('./errors');

const DRAW_COUNT = 6;
const MIN_DEZENA = 1;
const MAX_DEZENA = 60;

function invalid(details) {
  throw createMegaSenaError('INVALID_PAYLOAD', { details });
}

function parseInteger(value) {
  if (Number.isInteger(value)) return value;

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  }

  return null;
}

function parseConcurso(payload) {
  const raw = payload.numero !== undefined ? payload.numero : payload.concurso;
  const concurso = parseInteger(raw);

  if (concurso === null || concurso <= 0) invalid('concurso inválido');

  return concurso;
}

function formatDate(year, month, day) {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(day)}/${pad(month)}/${year}`;
}

function parseDataSorteio(payload) {
  const raw = payload.dataApuracao;

  if (typeof raw !== 'string') invalid('data do sorteio inválida');

  const text = raw.trim();
  const brasil = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (brasil) {
    const formatted = formatDate(Number(brasil[3]), Number(brasil[2]), Number(brasil[1]));
    if (formatted) return formatted;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const formatted = formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (formatted) return formatted;
  }

  return invalid('data do sorteio inválida');
}

function parseDezenas(payload) {
  const raw = payload.listaDezenas;

  if (!Array.isArray(raw) || raw.length !== DRAW_COUNT) invalid('lista de dezenas inválida');

  const dezenas = raw.map((value) => parseInteger(value));

  if (dezenas.some((dezena) => dezena === null)) invalid('dezena não numérica');
  if (dezenas.some((dezena) => dezena < MIN_DEZENA || dezena > MAX_DEZENA)) invalid('dezena fora de 1 a 60');
  if (new Set(dezenas).size !== DRAW_COUNT) invalid('dezenas repetidas');

  return dezenas;
}

function parseAcumulou(payload) {
  if (typeof payload.acumulado !== 'boolean') invalid('indicador de acumulação inválido');
  return payload.acumulado;
}

function parseEstimativa(payload) {
  const raw = payload.valorEstimadoProximoConcurso;

  if (raw === undefined || raw === null) return null;

  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;

  if (!Number.isFinite(value) || value <= 0) return null;

  return value;
}

function validateResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('payload não é um objeto');

  return {
    concurso: parseConcurso(payload),
    dataSorteio: parseDataSorteio(payload),
    dezenas: parseDezenas(payload),
    acumulou: parseAcumulou(payload),
    estimativaProximoPremio: parseEstimativa(payload),
  };
}

module.exports = { validateResult, DRAW_COUNT, MIN_DEZENA, MAX_DEZENA };
