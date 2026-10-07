const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createMusicError } = require('./errors');
const { MUSIC_CONFIG } = require('./constants');

function assertInteractionInGuild(interaction) {
  if (!interaction.inGuild() || !interaction.guildId) {
    throw createMusicError('NOT_IN_GUILD');
  }

  return interaction.guildId;
}

function getMemberVoiceChannel(interaction) {
  const direct = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
  if (direct) return direct;

  const cached = interaction.guild && interaction.guild.members.cache
    ? interaction.guild.members.cache.get(interaction.user.id)
    : null;

  return cached && cached.voice ? cached.voice.channel : null;
}

function assertMemberInVoice(interaction) {
  const channel = getMemberVoiceChannel(interaction);

  if (!channel) throw createMusicError('NOT_IN_VOICE');
  if (channel.type === ChannelType.GuildStageVoice) throw createMusicError('STAGE_CHANNEL');

  return channel;
}

function getBotMember(guild) {
  return (guild && guild.members && guild.members.me) || null;
}

function assertBotCanConnect(channel, guild) {
  const bot = getBotMember(guild);
  const permissions = bot ? channel.permissionsFor(bot) : null;

  if (!permissions) throw createMusicError('BOT_NO_CONNECT');

  if (!permissions.has(PermissionFlagsBits.Connect)) throw createMusicError('BOT_NO_CONNECT');
  if (!permissions.has(PermissionFlagsBits.Speak)) throw createMusicError('BOT_NO_SPEAK');

  return channel;
}

function assertSameVoiceChannel(interaction, botChannelId) {
  if (!botChannelId) throw createMusicError('BOT_NOT_IN_VOICE');

  const channel = assertMemberInVoice(interaction);

  if (channel.id !== botChannelId) throw createMusicError('WRONG_VOICE_CHANNEL');

  return channel;
}

function assertSessionActive(session) {
  if (!session || session.state === 'idle' || !session.current) {
    throw createMusicError('NO_PLAYBACK');
  }

  return session;
}

function assertSessionPaused(session) {
  assertSessionActive(session);

  if (session.state !== 'paused') throw createMusicError('NOT_PAUSED');

  return session;
}

function assertSessionPlaying(session) {
  assertSessionActive(session);

  if (session.state !== 'playing') throw createMusicError('ALREADY_PAUSED');

  return session;
}

function assertQueueCapacity(session) {
  const queued = session && Array.isArray(session.queue) ? session.queue.length : 0;

  if (queued >= MUSIC_CONFIG.MAX_QUEUE_SIZE) throw createMusicError('QUEUE_FULL');

  return session;
}

function assertQueueNotEmpty(session) {
  const queued = session && Array.isArray(session.queue) ? session.queue.length : 0;

  if (queued === 0) throw createMusicError('NO_NEXT_TRACK');

  return session;
}

function parseQueuePosition(value, queueLength, options = {}) {
  const lowDetail = options.lowDetail || 'informe uma posição a partir de 1';
  const position = Number(value);
  const total = Number.isFinite(queueLength) ? queueLength : 0;

  if (!Number.isInteger(position) || position < 1) {
    throw createMusicError('INVALID_POSITION', { details: lowDetail });
  }

  if (position > total) {
    throw createMusicError('INVALID_POSITION', { details: `a fila tem ${total} música(s)` });
  }

  return position;
}

module.exports = {
  assertInteractionInGuild,
  getMemberVoiceChannel,
  assertMemberInVoice,
  assertBotCanConnect,
  assertSameVoiceChannel,
  assertSessionActive,
  assertSessionPaused,
  assertSessionPlaying,
  assertQueueCapacity,
  assertQueueNotEmpty,
  parseQueuePosition,
};
