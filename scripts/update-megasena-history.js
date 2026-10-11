#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { validateSnapshot, buildRankings } = require('../src/services/megasena/statistics');

const API_BASE = 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena';
const FONT = 'Caixa Econômica Federal — API oficial (servicebus2.caixa.gov.br/portaldeloterias/api/megasena)';
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'megasena-frequencias.json');
const DRAW_COUNT = 6;
const MIN_DEZENA = 1;
const MAX_DEZENA = 60;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RPS = 5;
const DEFAULT_CHUNK = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInteger(value, flag) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} espera um inteiro positivo, recebido: ${value}`);
  const parsed = Number.parseInt(text, 10);
  if (parsed <= 0) throw new Error(`${flag} espera um inteiro positivo, recebido: ${value}`);
  return parsed;
}

function toNonNegativeInteger(value, flag) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} espera um inteiro maior ou igual a zero, recebido: ${value}`);
  return Number.parseInt(text, 10);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rps: DEFAULT_RPS,
    chunk: DEFAULT_CHUNK,
    out: DEFAULT_OUTPUT,
    ate: null,
    limit: null,
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--ate=')) options.ate = toPositiveInteger(arg.slice(6), '--ate');
    else if (arg.startsWith('--limit=')) options.limit = toPositiveInteger(arg.slice(8), '--limit');
    else if (arg.startsWith('--concurrency=')) {
      options.concurrency = toPositiveInteger(arg.slice(14), '--concurrency');
    } else if (arg.startsWith('--retries=')) options.retries = toPositiveInteger(arg.slice(10), '--retries');
    else if (arg.startsWith('--rps=')) options.rps = toNonNegativeInteger(arg.slice(6), '--rps');
    else if (arg.startsWith('--chunk=')) options.chunk = toPositiveInteger(arg.slice(8), '--chunk');
    else if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else throw new Error(`argumento desconhecido: ${arg}`);
  }

  return options;
}

function createRateLimiter(rps = DEFAULT_RPS) {
  const interval = 1000 / rps;
  let nextStart = 0;

  return async function acquire() {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + interval;

    if (start > now) await sleep(start - now);
  };
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível neste runtime');

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'ChicoBot/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} em ${url}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (!retryable || attempt === retries) break;

      const backoff = error.status === 429 ? 2000 * 2 ** attempt : 300 * 2 ** attempt;
      await sleep(backoff);
    }
  }

  throw lastError;
}

function parseDezena(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function extractDezenas(payload, concurso) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`concurso ${concurso}: resposta sem dados`);
  }

  const numero = parseDezena(payload.numero);
  if (numero !== concurso) throw new Error(`concurso ${concurso}: a API devolveu o concurso ${numero}`);

  const raw = payload.listaDezenas;
  if (!Array.isArray(raw) || raw.length !== DRAW_COUNT) {
    throw new Error(`concurso ${concurso}: lista de dezenas inválida`);
  }

  const dezenas = raw.map(parseDezena);

  if (dezenas.some((dezena) => dezena === null)) throw new Error(`concurso ${concurso}: dezena não numérica`);
  if (dezenas.some((dezena) => dezena < MIN_DEZENA || dezena > MAX_DEZENA)) {
    throw new Error(`concurso ${concurso}: dezena fora de 1 a 60`);
  }
  if (new Set(dezenas).size !== DRAW_COUNT) throw new Error(`concurso ${concurso}: dezenas repetidas`);

  return dezenas;
}

async function fetchRange({ de, ate, total = ate, counts, concurrency, retries, timeoutMs, fetchImpl, acquire, onProgress }) {
  for (let start = de; start <= ate; start += concurrency) {
    const end = Math.min(start + concurrency - 1, ate);

    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, index) => start + index).map(async (concurso) => {
        if (acquire) await acquire();

        const payload = await fetchJson(`${API_BASE}/${concurso}`, { fetchImpl, retries, timeoutMs });
        const dezenas = extractDezenas(payload, concurso);

        for (const dezena of dezenas) counts[dezena] += 1;
      })
    );

    if (onProgress) onProgress(end, total);
  }

  return counts;
}

function emptyCounts() {
  return new Array(MAX_DEZENA + 1).fill(0);
}

function isUsableCounts(value) {
  return (
    Array.isArray(value) &&
    value.length === MAX_DEZENA + 1 &&
    value.every((count, index) => (index === 0 ? count === 0 : Number.isInteger(count) && count >= 0))
  );
}

function partialPathOf(outPath) {
  return `${outPath}.partial.json`;
}

function readPartial(partialPath, ateConcurso) {
  try {
    const parsed = JSON.parse(fs.readFileSync(partialPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.ateConcurso !== ateConcurso) return null;
    if (!Number.isInteger(parsed.concluidoAte) || parsed.concluidoAte < 1) return null;
    if (parsed.concluidoAte > ateConcurso) return null;
    if (!isUsableCounts(parsed.contagensParciais)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePartial(partialPath, { ateConcurso, concluidoAte, contagensParciais }) {
  const payload = { ateConcurso, concluidoAte, contagensParciais };
  const tempPath = `${partialPath}.tmp`;

  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tempPath, partialPath);
}

async function fetchHistory({
  ateConcurso,
  from = 1,
  counts = emptyCounts(),
  concurrency = DEFAULT_CONCURRENCY,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chunk = DEFAULT_CHUNK,
  rps = DEFAULT_RPS,
  fetchImpl = globalThis.fetch,
  onProgress = null,
  onChunk = null,
} = {}) {
  const acquire = rps > 0 ? createRateLimiter(rps) : null;
  let concluidoAte = from - 1;

  for (let start = from; start <= ateConcurso; start += chunk) {
    const end = Math.min(start + chunk - 1, ateConcurso);

    await fetchRange({
      de: start,
      ate: end,
      total: ateConcurso,
      counts,
      concurrency,
      retries,
      timeoutMs,
      fetchImpl,
      acquire,
      onProgress,
    });

    concluidoAte = end;
    if (onChunk) onChunk(concluidoAte, counts);
  }

  return { counts, concluidoAte };
}

function buildSnapshot({ counts, ateConcurso, geradoEm = new Date().toISOString(), fonte = FONT }) {
  const contagens = {};

  for (let dezena = MIN_DEZENA; dezena <= MAX_DEZENA; dezena += 1) {
    contagens[dezena] = counts[dezena];
  }

  return { fonte, geradoEm, ateConcurso, contagens };
}

function summarize(snapshot) {
  const { maisSorteadas, menosSorteadas } = buildRankings(snapshot.contagens);
  const line = (item) => `${String(item.dezena).padStart(2, '0')}: ${item.contagem}`;

  return { mais: maisSorteadas.map(line).join(', '), menos: menosSorteadas.map(line).join(', ') };
}

async function latestConcurso(fetchImpl, options) {
  const payload = await fetchJson(API_BASE, { fetchImpl, retries: options.retries, timeoutMs: options.timeoutMs });
  const numero = parseDezena(payload.numero);
  if (!numero) throw new Error('não foi possível identificar o último concurso oficial');
  return numero;
}

const USAGE = `
Atualiza data/megasena-frequencias.json a partir da API oficial da Caixa.

Uso: node scripts/update-megasena-history.js [opções]

  --ate=N            último concurso a incluir (padrão: último concurso oficial)
  --limit=N          processa apenas os N primeiros concursos (teste)
  --concurrency=N    requisições simultâneas (padrão: ${DEFAULT_CONCURRENCY})
  --rps=N            requisições por segundo (padrão: ${DEFAULT_RPS}; 0 desativa)
  --chunk=N          concursos por bloco de checkpoint (padrão: ${DEFAULT_CHUNK})
  --retries=N        tentativas extras por requisição (padrão: ${DEFAULT_RETRIES})
  --out=PATH         arquivo de saída (padrão: data/megasena-frequencias.json)
  --dry-run          valida sem gravar o arquivo final
`.trim();

async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return null;
  }

  const oficial = await latestConcurso(fetchImpl, options);
  const ateConcurso = options.limit ? Math.min(options.limit, oficial) : options.ate ?? oficial;

  if (ateConcurso > oficial) {
    throw new Error(`concurso ${ateConcurso} ainda não existe (último oficial: #${oficial})`);
  }

  const partialPath = partialPathOf(options.out);
  const partial = readPartial(partialPath, ateConcurso);
  const counts = partial ? partial.contagensParciais : emptyCounts();
  const from = partial ? partial.concluidoAte + 1 : 1;

  if (partial) {
    log(`♻️  Retomando: concursos 1..${partial.concluidoAte} já coletados em ${path.basename(partialPath)}.`);
  }

  log(`⏳ Coletando concursos ${from}..${ateConcurso} na API oficial da Caixa (último concurso oficial: #${oficial})...`);

  await fetchHistory({
    ateConcurso,
    from,
    counts,
    concurrency: options.concurrency,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    chunk: options.chunk,
    rps: options.rps,
    fetchImpl,
    onProgress: (done, total) => log(`   ${done}/${total} concursos`),
    onChunk: (concluidoAte, current) => {
      if (!options.dryRun) writePartial(partialPath, { ateConcurso, concluidoAte, contagensParciais: current });
    },
  });

  const snapshot = buildSnapshot({ counts, ateConcurso });
  validateSnapshot(snapshot);

  const summary = summarize(snapshot);

  if (options.dryRun) {
    log('🧪 Dry run: snapshot validado, nada foi gravado.');
  } else {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.rmSync(partialPath, { force: true });
    log(`✅ Snapshot gravado em ${path.relative(process.cwd(), options.out)}`);
  }

  log(`🎟️  Concurso mais recente no histórico: #${snapshot.ateConcurso}`);
  log(`🔺 Mais sorteadas: ${summary.mais}`);
  log(`🔻 Menos sorteadas: ${summary.menos}`);

  return snapshot;
}

module.exports = {
  API_BASE,
  FONT,
  DEFAULT_OUTPUT,
  parseArgs,
  extractDezenas,
  buildSnapshot,
  fetchHistory,
  fetchRange,
  latestConcurso,
  summarize,
  createRateLimiter,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Falha ao atualizar o histórico: ${error.message}`);
    process.exit(1);
  });
}
