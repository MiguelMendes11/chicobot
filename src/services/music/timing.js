const ENV_FLAG = 'MUSIC_DEBUG_TIMING';
const TTL_MS = 10 * 60 * 1000;
const FINALIZE_CAP_MS = 30000;

const PHASES = Object.freeze([
  { label: 'ack', from: 'ack.begin', to: 'ack.end' },
  { label: 'status', from: 'status.begin', to: 'status.end' },
  { label: 'cache', tags: { 'cache.hit': 'hit', 'cache.inflight': 'inflight', 'cache.miss': 'miss' } },
  { label: 'resolve', from: 'resolve.begin', to: 'resolve.end' },
  { label: 'join', from: 'join.begin', to: 'join.end' },
  { label: 'ready', from: 'ready.begin', to: 'ready.end' },
  { label: 'add', from: 'add.begin', to: 'add.end' },
  { label: 'resource', from: 'resource.begin', to: 'resource.end' },
  { label: 'fallback', from: 'resource.fallback', to: 'resource.end' },
  { label: 'play→audio', from: 'play.call', to: 'play.audio' },
  { label: 'reply', from: 'reply.begin', to: 'reply.end' },
  { label: 'total', from: 'total.begin', to: 'total.end' },
  { label: 'total→audio', from: 'total.begin', to: 'play.audio' },
]);

const contexts = new Map();

function isEnabled() {
  return process.env[ENV_FLAG] === 'true';
}

function purgeStale(now) {
  for (const [guildId, ctx] of contexts) {
    if (now - ctx.createdAt > TTL_MS) {
      if (ctx.capTimer) clearTimeout(ctx.capTimer);
      contexts.delete(guildId);
    }
  }
}

function begin(guildId) {
  if (!guildId || !isEnabled()) return;

  const now = Date.now();
  purgeStale(now);

  const ctx = { createdAt: now, marks: new Map(), pending: false, capTimer: null };
  ctx.marks.set('total.begin', now);
  contexts.set(guildId, ctx);
}

function mark(guildId, label) {
  if (!guildId || !isEnabled()) return;

  const ctx = contexts.get(guildId);
  if (!ctx) return;

  ctx.marks.set(label, Date.now());

  if (ctx.pending && (label === 'play.audio' || label === 'play.error')) {
    if (ctx.capTimer) clearTimeout(ctx.capTimer);
    emit(guildId, ctx);
  }
}

function formatDelta(marks, from, to) {
  const start = marks.get(from);
  const end = marks.get(to);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'n/a';

  return `${Math.max(0, end - start)}ms`;
}

function formatPhase(marks, phase) {
  if (phase.tags) {
    for (const [mark, value] of Object.entries(phase.tags)) {
      if (marks.has(mark)) return value;
    }

    return 'n/a';
  }

  return formatDelta(marks, phase.from, phase.to);
}

function emit(guildId, ctx) {
  contexts.delete(guildId);
  if (ctx.capTimer) {
    clearTimeout(ctx.capTimer);
    ctx.capTimer = null;
  }

  if (!isEnabled()) return;

  const parts = PHASES.map((phase) => `${phase.label}=${formatPhase(ctx.marks, phase)}`);
  console.log(`⏱ [timing] guild=${guildId} ${parts.join(' ')}`);
}

function finish(guildId, options = {}) {
  if (!guildId || !isEnabled()) return;

  const ctx = contexts.get(guildId);
  if (!ctx) return;

  if (!ctx.marks.has('total.end')) ctx.marks.set('total.end', Date.now());

  if (!options.pending || ctx.marks.has('play.audio') || ctx.marks.has('play.error')) {
    emit(guildId, ctx);
    return;
  }

  ctx.pending = true;

  if (!ctx.capTimer) {
    ctx.capTimer = setTimeout(() => {
      ctx.capTimer = null;
      emit(guildId, ctx);
    }, FINALIZE_CAP_MS);

    if (typeof ctx.capTimer.unref === 'function') ctx.capTimer.unref();
  }
}

module.exports = { isEnabled, begin, mark, finish };
