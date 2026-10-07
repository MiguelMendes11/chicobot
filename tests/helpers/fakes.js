import { EventEmitter } from 'node:events';

function createFakeConnection({ status = 'signalling', channelId = 'vc1', guildId = 'g1' } = {}) {
  const emitter = new EventEmitter();

  const connection = {
    joinConfig: { channelId, guildId, selfDeaf: true },
    state: { status },
    subscribeCalls: [],
    destroyCount: 0,
    on(event, handler) {
      emitter.on(event, handler);
      return connection;
    },
    once(event, handler) {
      emitter.once(event, handler);
      return connection;
    },
    off(event, handler) {
      emitter.off(event, handler);
      return connection;
    },
    removeListener(event, handler) {
      emitter.off(event, handler);
      return connection;
    },
    emit(event, ...args) {
      return emitter.emit(event, ...args);
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
    subscribe(player) {
      connection.subscribeCalls.push(player);
      return connection;
    },
    destroy() {
      connection.destroyCount += 1;
      const previous = connection.state;
      if (previous.status === 'destroyed') return;
      connection.state = { status: 'destroyed' };
      emitter.emit('stateChange', previous, connection.state);
    },
    setStatus(nextStatus) {
      const previous = connection.state;
      connection.state = { status: nextStatus };
      emitter.emit('stateChange', previous, connection.state);
    },
  };

  return connection;
}

function createFakePlayer({ status = 'idle', playStatus = 'buffering' } = {}) {
  const emitter = new EventEmitter();

  const player = {
    state: { status, playbackDuration: 0 },
    playCalls: [],
    stopCalls: 0,
    pauseCalls: 0,
    unpauseCalls: 0,
    on(event, handler) {
      emitter.on(event, handler);
      return player;
    },
    off(event, handler) {
      emitter.off(event, handler);
      return player;
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
    emit(event, ...args) {
      return emitter.emit(event, ...args);
    },
    play(resource) {
      player.playCalls.push(resource);
      const previous = player.state;
      player.state = { status: playStatus, playbackDuration: 0 };
      emitter.emit('stateChange', previous, player.state);
      emitter.emit(playStatus);
      return player;
    },
    stop() {
      player.stopCalls += 1;
      player.emitIdle();
      return true;
    },
    pause() {
      player.pauseCalls += 1;
      if (player.state.status !== 'playing') return false;
      const previous = player.state;
      player.state = { ...player.state, status: 'paused' };
      emitter.emit('stateChange', previous, player.state);
      emitter.emit('paused');
      return true;
    },
    unpause() {
      player.unpauseCalls += 1;
      if (player.state.status !== 'paused') return false;
      const previous = player.state;
      player.state = { ...player.state, status: 'playing' };
      emitter.emit('stateChange', previous, player.state);
      emitter.emit('playing');
      return true;
    },
    setState(nextStatus) {
      const previous = player.state;
      player.state =
        nextStatus === 'idle'
          ? { status: nextStatus }
          : { ...player.state, status: nextStatus, playbackDuration: player.state.playbackDuration || 0 };
      emitter.emit('stateChange', previous, player.state);
      emitter.emit(nextStatus);
    },
    advancePlayback(ms) {
      const delta = Number.isFinite(ms) ? ms : 0;
      player.state = { ...player.state, playbackDuration: (player.state.playbackDuration || 0) + delta };
    },
    emitIdle() {
      player.setState('idle');
    },
    startPlaying() {
      player.setState('playing');
    },
  };

  return player;
}

function createFakeChannel({ id = 'vc1', humans = 1, bots = 0 } = {}) {
  const members = new Map();

  for (let i = 0; i < humans; i += 1) {
    members.set(`human-${i}`, { id: `human-${i}`, user: { id: `human-${i}`, bot: false } });
  }

  for (let i = 0; i < bots; i += 1) {
    members.set(`bot-${i}`, { id: `bot-${i}`, user: { id: `bot-${i}`, bot: true } });
  }

  return { id, members };
}

function createVoiceState({ id, channelId = null, channel = null, guildId = 'g1' } = {}) {
  return { id, channelId, channel, guild: { id: guildId } };
}

function createTrackStub(overrides = {}) {
  return {
    id: 'track-1',
    title: 'Música de teste',
    url: 'https://www.youtube.com/watch?v=track-1',
    duration: 180,
    source: 'youtube',
    requestedBy: 'tester#0001',
    ...overrides,
  };
}

const fakeAdapterCreator = () => ({ send: () => {}, destroy: () => {} });

const fakeClient = { user: { id: 'bot-1' } };

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

export {
  createFakeConnection,
  createFakePlayer,
  createFakeChannel,
  createVoiceState,
  createTrackStub,
  fakeAdapterCreator,
  fakeClient,
  settle,
};
