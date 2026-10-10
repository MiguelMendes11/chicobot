const { EmbedBuilder } = require('discord.js');
const { formatDuration, formatTitle } = require('./musicInteraction');

const THEME = Object.freeze({
  colors: Object.freeze({ music: 0x3b82f6, paused: 0x9aa0a6 }),
  brand: 'ChicoBot',
  idleActivity: 'ChicoBot • digite /play',
  activityTitleMax: 128,
  embedTitleMax: 256,
  progressSegments: 12,
});

const STATUS = Object.freeze({
  playing: Object.freeze({ label: 'Tocando agora', emoji: '▶️' }),
  loading: Object.freeze({ label: 'Preparando…', emoji: '🔃' }),
  paused: Object.freeze({ label: 'Pausado', emoji: '⏸️' }),
  idle: Object.freeze({ label: 'Nada tocando', emoji: '⏹️' }),
});

const LOOP_LABELS = Object.freeze({
  track: 'música',
  queue: 'fila',
});

function statusOf(state) {
  return STATUS[state] || STATUS.playing;
}

function colorOf(state) {
  return state === 'paused' ? THEME.colors.paused : THEME.colors.music;
}

function truncate(value, max) {
  const text = value === null || value === undefined ? '' : String(value);
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;

  if (limit <= 0) return '';

  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  if (limit === 1) return '…';

  return `${chars.slice(0, limit - 1).join('')}…`;
}

function clampSeconds(value, durationSeconds) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0 && value > durationSeconds) return durationSeconds;
  return value;
}

function percentOf(positionSeconds, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((positionSeconds / durationSeconds) * 100)));
}

function progressBar(positionSeconds, durationSeconds, size = THEME.progressSegments) {
  const segments = Number.isFinite(size) && size > 0 ? Math.floor(size) : THEME.progressSegments;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  const position = clampSeconds(positionSeconds, durationSeconds);
  const filled = Math.round((position / durationSeconds) * segments);

  return `${'▬'.repeat(filled)}${'○'.repeat(segments - filled)}`;
}

function trackLink(track, maxTitle = 180) {
  if (!track) return '*Nada tocando.*';

  return `**[${formatTitle(truncate(track.title, maxTitle))}](${track.url})** (${formatDuration(track.duration)})`;
}

function pickDuration(progress, track) {
  if (progress && Number.isFinite(progress.durationSeconds) && progress.durationSeconds >= 0) {
    return progress.durationSeconds;
  }

  if (track && Number.isFinite(track.duration) && track.duration >= 0) return track.duration;

  return null;
}

function pickPosition(progress, durationSeconds) {
  if (progress && Number.isFinite(progress.positionSeconds)) {
    return clampSeconds(progress.positionSeconds, durationSeconds ?? undefined);
  }

  return 0;
}

function progressText(progress, track) {
  const duration = pickDuration(progress, track);
  const position = pickPosition(progress, duration);

  if (!Number.isFinite(duration) || duration <= 0) return `${formatDuration(position)} / —`;

  const percent = percentOf(position, duration);
  const lines = [`${formatDuration(position)} / ${formatDuration(duration)} • ${percent}%`];
  const bar = progressBar(position, duration);

  if (bar) lines.push(bar);

  return lines.join('\n');
}

function applyAuthor(embed, name, client) {
  const authorName = truncate(name, THEME.embedTitleMax);
  const user = client && client.user;
  const iconURL = user && typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL() : null;

  return iconURL ? embed.setAuthor({ name: authorName, iconURL }) : embed.setAuthor({ name: authorName });
}

function applyFooter(embed, info) {
  return embed.setFooter({ text: truncate(`${THEME.brand} • ${info}`, 2048) });
}

function requesterOf(track) {
  return track && track.requestedBy ? truncate(track.requestedBy, 256) : null;
}

function loopSuffix(loopMode) {
  const label = LOOP_LABELS[loopMode];
  return label ? ` • loop: ${label}` : '';
}

const LOOP_MESSAGES = Object.freeze({
  off: '🔁 **Loop desligado.** A fila avança normalmente.',
  track: '🔁 **Loop: música.** A faixa atual repetirá até você usar /skip ou desligar o loop.',
  queue: '🔁 **Loop: fila.** Ao terminar, cada música volta para o final da fila.',
});

function buildNowPlayingEmbed({
  track,
  state = 'playing',
  progress = null,
  queueLength = 0,
  client = null,
  loopMode = 'off',
} = {}) {
  const status = statusOf(state);
  const embed = new EmbedBuilder().setColor(colorOf(state));

  applyAuthor(embed, `${THEME.brand} • ${status.label}`, client);

  embed.setTitle(truncate(track ? track.title : status.label, THEME.embedTitleMax));
  if (track && track.url) embed.setURL(track.url);
  if (track && track.thumbnail) embed.setThumbnail(track.thumbnail);

  const requester = requesterOf(track);

  embed.addFields(
    { name: '⏱️ Progresso', value: progressText(progress, track), inline: true },
    { name: '🎧 Pedido por', value: requester || '—', inline: true },
    { name: '📋 Fila', value: `${Number.isFinite(queueLength) ? queueLength : 0} música(s)`, inline: true }
  );

  applyFooter(embed, `${Number.isFinite(queueLength) ? queueLength : 0} na fila${loopSuffix(loopMode)}`);

  return embed;
}

function buildQueueEmbed({ snapshot = {}, guildName = null, client = null, previewLimit = 10 } = {}) {
  const state = snapshot.state || 'idle';
  const status = statusOf(state);
  const current = snapshot.current || null;
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const queueLength = Number.isFinite(snapshot.queueLength) ? snapshot.queueLength : queue.length;
  const limit = Number.isFinite(previewLimit) && previewLimit > 0 ? Math.floor(previewLimit) : 10;

  const preview = queue.slice(0, limit);
  const remaining = queue.length - preview.length;

  const lines = preview.map((item, index) => `${index + 1}. ${trackLink(item)}`);
  if (lines.length === 0) lines.push('*Nada na fila.*');
  if (remaining > 0) lines.push(`… e mais ${remaining} na fila.`);

  const currentLines = [`${status.emoji} **${status.label}**`];

  if (current) {
    currentLines.push(trackLink(current));

    const requester = requesterOf(current);
    if (requester) currentLines.push(`Pedido por **${requester}**`);

    currentLines.push(progressText(snapshot.progress, current));
  }

  const description = [...currentLines, '', `**📋 Próximas**`, ...lines].join('\n');

  const embed = new EmbedBuilder()
    .setColor(colorOf(state))
    .setDescription(truncate(description, 4096));

  applyAuthor(
    embed,
    guildName ? `${THEME.brand} • Fila — ${truncate(guildName, 200)}` : `${THEME.brand} • Fila`,
    client
  );

  if (current && current.thumbnail) embed.setThumbnail(current.thumbnail);

  applyFooter(embed, `${queueLength} na fila • mostrando ${preview.length}${loopSuffix(snapshot.loopMode)}`);

  return embed;
}

function buildQueuedEmbed({ track, position = 1, queueLength = 0, client = null } = {}) {
  const embed = new EmbedBuilder().setColor(THEME.colors.music);

  applyAuthor(embed, `${THEME.brand} • Adicionada à fila`, client);

  embed.setTitle(truncate(track ? track.title : 'Adicionada à fila', THEME.embedTitleMax));
  if (track && track.url) embed.setURL(track.url);
  if (track && track.thumbnail) embed.setThumbnail(track.thumbnail);

  embed.addFields(
    { name: '📍 Posição', value: `#${Number.isFinite(position) ? position : 1}`, inline: true },
    { name: '🎧 Pedido por', value: requesterOf(track) || '—', inline: true },
    { name: '📋 Fila', value: `${Number.isFinite(queueLength) ? queueLength : 0} música(s)`, inline: true }
  );

  applyFooter(embed, 'use /nowplaying para ver o progresso');

  return embed;
}

function formatMegaSenaDezenas(dezenas) {
  const list = Array.isArray(dezenas) ? dezenas : [];
  return list.map((value) => String(value).padStart(2, '0')).join('  ');
}

function buildMegaSenaGameEmbed({ dezenas = [], client = null } = {}) {
  const formatted = formatMegaSenaDezenas(dezenas);
  const embed = new EmbedBuilder().setColor(THEME.colors.music);

  applyAuthor(embed, `${THEME.brand} • Mega-Sena`, client);

  embed.setTitle(truncate('🎯 Jogo da Mega-Sena', THEME.embedTitleMax));
  embed.setDescription(formatted ? `**${formatted}**` : '*Nenhuma dezena gerada.*');

  applyFooter(embed, 'diversão apenas — números aleatórios, sem garantia de prêmio');

  return embed;
}

function formatMegaSenaBRL(value) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const [integer, decimals] = value.toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `R$ ${grouped},${decimals}`;
}

function buildMegaSenaResultEmbed({ result = {}, client = null } = {}) {
  const dezenas = Array.isArray(result.dezenas) ? result.dezenas : [];
  const embed = new EmbedBuilder().setColor(THEME.colors.music);

  applyAuthor(embed, `${THEME.brand} • Mega-Sena`, client);

  embed.setTitle(truncate('🎯 Resultado da Mega-Sena', THEME.embedTitleMax));
  embed.setDescription(dezenas.length ? `**${formatMegaSenaDezenas(dezenas)}**` : '*Dezenas indisponíveis.*');

  embed.addFields(
    { name: '🔢 Concurso', value: `#${result.concurso ?? '—'}`, inline: true },
    { name: '📅 Data do sorteio', value: result.dataSorteio || '—', inline: true },
    {
      name: '🟡 Acumulou?',
      value: result.acumulou ? 'Sim — acumulou para o próximo concurso.' : 'Não — houve ganhador.',
      inline: true,
    }
  );

  const estimativa = formatMegaSenaBRL(result.estimativaProximoPremio);
  if (estimativa) {
    embed.addFields({ name: '💰 Estimativa do próximo prêmio', value: estimativa, inline: true });
  }

  applyFooter(embed, 'resultado informativo — não representa previsão de sorteios futuros');

  return embed;
}

function pausedMessage(track) {
  return `⏸️ **Música pausada.** ${trackLink(track)} — use \`/resume\` para continuar.`;
}

function resumedMessage(track) {
  return `▶️ **Música retomada.** ${trackLink(track)}`;
}

function skippedMessage(current, next) {
  const nextPart = next ? `Próxima: ${trackLink(next)}` : '*Fila vazia.*';
  return `⏭️ Pulando ${trackLink(current)}. ${nextPart}`;
}

function stoppedMessage() {
  return '⏹️ **Fila encerrada.** Desconectando do canal de voz.';
}

function loopModeMessage(mode) {
  return LOOP_MESSAGES[mode] || LOOP_MESSAGES.off;
}

function shuffledMessage(count) {
  const total = Number.isFinite(count) ? count : 0;
  return `🔀 **Fila embaralhada.** ${total} música(s) reordenadas (a música atual não mudou).`;
}

function removedMessage(track, position, queueLength) {
  const remaining = Number.isFinite(queueLength) ? queueLength : 0;
  return `🗑️ Removida ${trackLink(track)} da posição ${position}. Restam ${remaining} na fila.`;
}

function clearedMessage(count) {
  const total = Number.isFinite(count) ? count : 0;
  return `🧹 **Fila limpa.** ${total} música(s) removida(s); a música atual continua tocando.`;
}

function movedMessage(track, from, to) {
  return `↕️ ${trackLink(track)} movida da posição ${from} para ${to}.`;
}

module.exports = {
  THEME,
  STATUS,
  LOOP_LABELS,
  statusOf,
  colorOf,
  truncate,
  progressBar,
  percentOf,
  trackLink,
  progressText,
  loopSuffix,
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildQueuedEmbed,
  formatMegaSenaDezenas,
  buildMegaSenaGameEmbed,
  formatMegaSenaBRL,
  buildMegaSenaResultEmbed,
  pausedMessage,
  resumedMessage,
  skippedMessage,
  stoppedMessage,
  loopModeMessage,
  shuffledMessage,
  removedMessage,
  clearedMessage,
  movedMessage,
};
