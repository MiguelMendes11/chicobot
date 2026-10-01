const MusicRegistry = require('./registry');
const GuildMusicSession = require('./session');
const { assertSessionActive } = require('./guards');
const { waitForConnectionReady } = require('./connectionLifecycle');
const timing = require('./timing');
const presence = require('../presence');
const voice = require('@discordjs/voice');

const registry = new MusicRegistry();

function logInfo(message) {
  console.log(`🎵 [música] ${message}`);
}

function logWarn(message) {
  console.warn(`⚠️ [música] ${message}`);
}

function logError(context, error) {
  const detail = error && error.message ? error.message : String(error);
  console.error(`❌ [música] ${context}`, detail);
}

function getSession(guildId) {
  return registry.get(guildId);
}

function requireSession(guildId) {
  const session = registry.get(guildId);
  assertSessionActive(session);
  return session;
}

function getOrCreateSession(guildId, options = {}) {
  return registry.getOrCreate(
    guildId,
    (id) =>
      new GuildMusicSession(id, {
        ...options,
        registry,
        hooks: { ...presence.hooks, ...(options.hooks || {}) },
      })
  );
}

function attachConnection(guildId, connection, options = {}) {
  const session = getOrCreateSession(guildId, options);
  session.attachConnection(connection);

  return session;
}

async function join({
  guildId,
  channelId,
  adapterCreator,
  textChannelId = null,
  joinVoiceChannel = voice.joinVoiceChannel,
  waitForReady = waitForConnectionReady,
  ...sessionOptions
} = {}) {
  if (!guildId || !channelId || !adapterCreator) {
    throw new TypeError('music.join: guildId, channelId e adapterCreator são obrigatórios.');
  }

  const startedAt = Date.now();

  timing.mark(guildId, 'join.begin');
  timing.mark(guildId, 'ready.begin');

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: true,
  });

  const session = attachConnection(guildId, connection, {
    ...sessionOptions,
    textChannelId,
    adapterCreator,
    targetChannelId: channelId,
    joinVoiceChannel,
  });

  try {
    await waitForReady(connection);
  } catch (error) {
    await handleJoinFailure(session, guildId, error);
    throw error;
  }

  timing.mark(guildId, 'ready.end');
  timing.mark(guildId, 'join.end');

  logInfo(`conexão de voz pronta em ${Date.now() - startedAt}ms (guild ${guildId}).`);

  return session;
}

async function handleJoinFailure(session, guildId, error) {
  if (!session) return;

  if (session.destroyed) return;

  const isEmpty = session.queue.length === 0 && !session.current;

  if (!isEmpty) {
    logWarn(`espera por conexão falhou na guild ${guildId}, mas a sessão tem faixa(s) em andamento; mantendo sessão.`);
    return;
  }

  try {
    await session.destroy();
    logWarn(`sessão da guild ${guildId} encerrada após falha de conexão.`);
  } catch (destroyError) {
    logError('falha ao limpar sessão após falha de conexão:', destroyError);
  }
}

function onVoiceStateUpdate(client, oldState, newState) {
  const guildId =
    (oldState && oldState.guild && oldState.guild.id) ||
    (newState && newState.guild && newState.guild.id) ||
    null;

  if (!guildId) return null;

  const session = registry.get(guildId);
  if (!session) return null;

  return session.handleVoiceStateUpdate(client, oldState, newState);
}

async function add(guildId, track, options = {}) {
  const session = getOrCreateSession(guildId, options);
  const result = await session.add(track);

  return { session, ...result };
}

async function pause(guildId) {
  return requireSession(guildId).pause();
}

async function resume(guildId) {
  return requireSession(guildId).resume();
}

async function skip(guildId) {
  return requireSession(guildId).skip();
}

async function stop(guildId) {
  const session = registry.get(guildId);

  if (!session) return false;

  await session.destroy();

  return true;
}

function snapshot(guildId) {
  const session = registry.get(guildId);

  if (!session) {
    return {
      exists: false,
      guildId,
      state: 'idle',
      current: null,
      queue: [],
      queueLength: 0,
      channelId: null,
      textChannelId: null,
      destroyed: false,
      progress: { positionSeconds: 0, durationSeconds: null, percent: null },
    };
  }

  return { exists: true, ...session.snapshot() };
}

async function destroySession(guildId) {
  const session = registry.get(guildId);

  if (!session) return false;

  await session.destroy();

  return true;
}

async function destroyAll() {
  const sessions = registry.list();
  await Promise.all(sessions.map((session) => session.destroy()));

  return sessions.length;
}

module.exports = {
  registry,
  getSession,
  requireSession,
  getOrCreateSession,
  attachConnection,
  join,
  add,
  pause,
  resume,
  skip,
  stop,
  snapshot,
  destroySession,
  destroyAll,
  onVoiceStateUpdate,
};
