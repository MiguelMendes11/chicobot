const MusicRegistry = require('./registry');
const GuildMusicSession = require('./session');
const { assertSessionActive } = require('./guards');
const voice = require('@discordjs/voice');

const registry = new MusicRegistry();

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
    (id) => new GuildMusicSession(id, { ...options, registry })
  );
}

function attachConnection(guildId, connection, options = {}) {
  const session = getOrCreateSession(guildId, options);
  session.attachConnection(connection);

  return session;
}

function join({ guildId, channelId, adapterCreator, textChannelId = null, ...sessionOptions } = {}) {
  if (!guildId || !channelId || !adapterCreator) {
    throw new TypeError('music.join: guildId, channelId e adapterCreator são obrigatórios.');
  }

  const connection = voice.joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: true,
  });

  return attachConnection(guildId, connection, { ...sessionOptions, textChannelId });
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
};
