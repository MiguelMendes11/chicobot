const { ActivityType } = require('discord.js');
const { truncate, THEME } = require('../utils/embeds');

const PRESENCE_DEBOUNCE_MS = 1500;
const ACTIVE_STATES = new Set(['playing', 'loading', 'paused']);

let client = null;
let lastAppliedKey = null;
let timer = null;

const recentGuildIds = [];
const activeSessions = new Map();

function touch(guildId) {
  const index = recentGuildIds.indexOf(guildId);
  if (index >= 0) recentGuildIds.splice(index, 1);
  recentGuildIds.push(guildId);
}

function forget(guildId) {
  const index = recentGuildIds.indexOf(guildId);
  if (index >= 0) recentGuildIds.splice(index, 1);
  activeSessions.delete(guildId);
}

function isActive(session) {
  return Boolean(session) && session.destroyed !== true && ACTIVE_STATES.has(session.state) && Boolean(session.current);
}

function computePayload() {
  for (let index = recentGuildIds.length - 1; index >= 0; index -= 1) {
    const session = activeSessions.get(recentGuildIds[index]);
    if (!isActive(session)) continue;

    const title = String(session.current.title || '');
    const paused = session.state === 'paused';
    const name = paused
      ? `⏸ ${truncate(title, THEME.activityTitleMax - 2)}`
      : truncate(title, THEME.activityTitleMax);

    return { status: 'online', activities: [{ type: ActivityType.Listening, name }] };
  }

  return {
    status: 'online',
    activities: [{ type: ActivityType.Listening, name: THEME.idleActivity }],
  };
}

function payloadKey(payload) {
  return `${payload.status}|${payload.activities.map((activity) => `${activity.type}:${activity.name}`).join('|')}`;
}

function apply() {
  if (!client || !client.user || typeof client.user.setPresence !== 'function') return false;

  const payload = computePayload();
  const key = payloadKey(payload);

  if (key === lastAppliedKey) return false;

  try {
    client.user.setPresence(payload);
    lastAppliedKey = key;
    return true;
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    console.warn(`⚠️ [presença] falha ao atualizar presença: ${detail}`);
    return false;
  }
}

function schedule() {
  if (!client || timer) return;

  timer = setTimeout(() => {
    timer = null;
    apply();
  }, PRESENCE_DEBOUNCE_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

function clearScheduled() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function start(botClient) {
  client = botClient || null;
  lastAppliedKey = null;
  flush();
}

function flush() {
  clearScheduled();
  return apply();
}

function reset() {
  clearScheduled();
  client = null;
  lastAppliedKey = null;
  recentGuildIds.length = 0;
  activeSessions.clear();
}

function notify(session) {
  if (!session || !session.guildId) return;
  if (!isActive(session)) return;

  activeSessions.set(session.guildId, session);
  touch(session.guildId);
  schedule();
}

const hooks = {
  onTrackStart(session) {
    if (!session || !session.guildId) return;
    activeSessions.set(session.guildId, session);
    touch(session.guildId);
    schedule();
  },
  onQueueFinish(session) {
    if (!session || !session.guildId) return;
    forget(session.guildId);
    schedule();
  },
  onDestroy(session) {
    if (!session || !session.guildId) return;
    forget(session.guildId);
    schedule();
  },
};

module.exports = {
  PRESENCE_DEBOUNCE_MS,
  start,
  flush,
  reset,
  notify,
  hooks,
  computePayload,
};
