const voice = require('@discordjs/voice');
const { VoiceConnectionStatus } = voice;
const { createMusicError } = require('./errors');
const { MUSIC_CONFIG } = require('./constants');

function waitForConnectionReady(connection, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : MUSIC_CONFIG.CONNECTION_READY_TIMEOUT_MS;
  const entersState = typeof options.entersState === 'function' ? options.entersState : voice.entersState;

  return new Promise((resolve, reject) => {
    if (!connection || typeof connection.on !== 'function') {
      reject(createMusicError('CONNECTION_TIMEOUT'));
      return;
    }

    if (connection.state && connection.state.status === VoiceConnectionStatus.Ready) {
      resolve(connection);
      return;
    }

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (typeof connection.off === 'function') {
        connection.off('stateChange', onStateChange);
      } else if (typeof connection.removeListener === 'function') {
        connection.removeListener('stateChange', onStateChange);
      }
    };

    const settle = (method, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      method(value);
    };

    const fail = () => settle(reject, createMusicError('CONNECTION_TIMEOUT'));

    function onStateChange(_oldState, newState) {
      if (settled || !newState) return;

      if (newState.status === VoiceConnectionStatus.Ready) {
        settle(resolve, connection);
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        fail();
      }
    }

    connection.on('stateChange', onStateChange);

    timer = setTimeout(fail, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const readyPromise = entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);

    Promise.resolve(readyPromise).then(
      () => settle(resolve, connection),
      () => fail()
    );
  });
}

function computeBackoff(attempt) {
  const table = MUSIC_CONFIG.RECONNECT_BACKOFF_MS;
  const index = Math.max(0, Math.min(attempt - 1, table.length - 1));

  return table[index];
}

function shouldReconnect(flags = {}) {
  if (flags.destroyed || flags.manualRemoval || flags.stopping) return false;

  return true;
}

module.exports = { waitForConnectionReady, computeBackoff, shouldReconnect };
