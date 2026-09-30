const { AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer } = require('@discordjs/voice');
const { createMusicError } = require('./errors');
const {
  assertQueueCapacity,
  assertSessionActive,
  assertSessionPaused,
  assertSessionPlaying,
} = require('./guards');
const { createTrackResource } = require('./stream');

const IDLE_STATUS = AudioPlayerStatus.Idle;
const DISCONNECT_GRACE_MS = 5000;

function logError(context, error) {
  const detail = error && error.message ? error.message : String(error);
  console.error(`❌ [música] ${context}`, detail);
}

class GuildMusicSession {
  constructor(guildId, options = {}) {
    if (!guildId || typeof guildId !== 'string') {
      throw new TypeError('GuildMusicSession: guildId é obrigatório.');
    }

    this.guildId = guildId;
    this.registry = options.registry || null;
    this.player = options.player || createAudioPlayer();
    this.createResource = typeof options.createResource === 'function' ? options.createResource : createTrackResource;
    this.hooks = options.hooks || {};
    this.textChannelId = options.textChannelId || null;

    this.connection = null;
    this.queue = [];
    this.current = null;
    this.state = 'idle';
    this.destroyed = false;
    this.lastError = null;

    this._playback = null;
    this._chain = Promise.resolve();
    this._advancePending = false;
    this._advanceCoversCurrent = false;
    this._pendingSkips = 0;
    this._tornDown = false;
    this._disconnectTimer = null;

    this._onPlayerIdle = () => this._scheduleAdvance('player-idle');
    this._onPlayerError = (error) => {
      this.lastError = error;
      logError(`player errou na guild ${guildId}:`, error);
    };

    this.player.on(IDLE_STATUS, this._onPlayerIdle);
    this.player.on('error', this._onPlayerError);
  }

  get channelId() {
    if (!this.connection || !this.connection.joinConfig) return null;
    return this.connection.joinConfig.channelId || null;
  }

  snapshot() {
    return {
      guildId: this.guildId,
      state: this.state,
      current: this.current,
      queue: [...this.queue],
      queueLength: this.queue.length,
      channelId: this.channelId,
      textChannelId: this.textChannelId,
      destroyed: this.destroyed,
    };
  }

  _enqueue(task, ignoreDestroyed = false) {
    const run = async () => {
      if (this.destroyed && !ignoreDestroyed) throw createMusicError('NO_PLAYBACK');
      return task();
    };

    const promise = this._chain.then(run, run);
    this._chain = promise.then(() => undefined, () => undefined);

    return promise;
  }

  _emit(hookName, ...args) {
    const hook = this.hooks[hookName];

    if (typeof hook !== 'function') return;

    try {
      hook(...args);
    } catch (error) {
      logError(`hook ${hookName} falhou:`, error);
    }
  }

  add(track) {
    return this._enqueue(() => {
      assertQueueCapacity(this);

      const position = this.queue.length + 1;
      this.queue.push(track);

      const shouldStart = this.state === 'idle' && !this.current;

      if (shouldStart) this._scheduleAdvance('auto-start');

      this._emit('onQueueChange', this);

      return { position, started: shouldStart && position === 1, queueLength: this.queue.length };
    });
  }

  pause() {
    return this._enqueue(() => {
      assertSessionPlaying(this);

      if (!this.player.pause()) throw createMusicError('NO_PLAYBACK');
      this.state = 'paused';

      return true;
    });
  }

  resume() {
    return this._enqueue(() => {
      assertSessionPaused(this);

      if (!this.player.unpause()) throw createMusicError('NO_PLAYBACK');
      this.state = 'playing';

      return true;
    });
  }

  skip() {
    return this._enqueue(() => {
      assertSessionActive(this);

      if (this.player.state.status === IDLE_STATUS) {
        if (this._advanceCoversCurrent) {
          this._pendingSkips += 1;
        } else {
          this._advanceCoversCurrent = true;
          this._scheduleAdvance('skip-idle');
        }

        return { skipped: true, deferred: true };
      }

      this._advanceCoversCurrent = true;
      this.player.stop(true);

      return { skipped: true, deferred: false };
    });
  }

  stop() {
    return this.destroy();
  }

  destroy() {
    this.destroyed = true;

    return this._enqueue(() => this._teardown(), true);
  }

  attachConnection(connection) {
    if (!connection) return null;

    if (this.destroyed) {
      try {
        connection.destroy();
      } catch (error) {
        logError('falha ao destruir conexão órfã:', error);
      }
      return null;
    }

    if (this.connection === connection) {
      this._subscribe(connection);
      return connection;
    }

    if (this.connection && this.connection !== connection) {
      this._destroyConnection(this.connection);
    }

    this.connection = connection;
    this._bindConnection(connection);
    this._subscribe(connection);

    return connection;
  }

  detachConnection() {
    const connection = this.connection;
    this.connection = null;
    this._clearDisconnectTimer();

    return connection;
  }

  _scheduleAdvance(reason) {
    if (this.destroyed || this._advancePending) return;

    this._advancePending = true;
    if (this.current) this._advanceCoversCurrent = true;

    this._enqueue(() => {
      this._advancePending = false;
      return this._advance(reason);
    }, true).catch((error) => logError('falha ao avançar a fila:', error));
  }

  async _advance(reason) {
    if (this.destroyed) return;

    const idleDerived = reason === 'player-idle' || reason === 'skip-idle';

    if (idleDerived && this.player.state.status !== IDLE_STATUS) return;

    if (!this.current && this.queue.length === 0) return;

    const finished = this.current;
    const extraSkips = this._pendingSkips;

    this._pendingSkips = 0;
    this._advanceCoversCurrent = false;
    this._releasePlayback();

    if (finished) this._emit('onTrackEnd', this, finished, reason);

    let remaining = extraSkips;

    while (remaining > 0 && this.queue.length > 0) {
      this.queue.shift();
      remaining -= 1;
    }

    const next = this.queue.shift();

    if (!next) {
      this.state = 'idle';
      this._emit('onQueueFinish', this, reason);
      this._emit('onQueueChange', this);
      return;
    }

    await this._startTrack(next);
  }

  async _startTrack(track) {
    this.current = track;
    this.state = 'loading';

    let playback = null;

    try {
      playback = await this.createResource(track, this);
    } catch (error) {
      this._handleTrackFailure(track, error);
      return;
    }

    if (this.destroyed) {
      this._safeKill(playback);
      return;
    }

    try {
      this.player.play(playback.resource);
    } catch (error) {
      this._safeKill(playback);
      this._handleTrackFailure(track, error);
      return;
    }

    this._playback = playback;
    this.current = track;
    this.state = 'playing';
    this._emit('onTrackStart', this, track);
  }

  _handleTrackFailure(track, error) {
    this._playback = null;
    this.current = null;
    this.state = 'idle';
    this.lastError = error;

    if (this.destroyed) return;

    logError(`não foi possível reproduzir "${track.title}":`, error);
    this._emit('onTrackError', this, track, error);
    this._emit('onQueueChange', this);

    if (this.queue.length > 0) {
      this._scheduleAdvance('track-error');
      return;
    }

    this._emit('onQueueFinish', this, 'track-error');
  }

  _releasePlayback() {
    const playback = this._playback;

    this._playback = null;
    this.current = null;

    if (!playback) return null;

    this._safeKill(playback);

    const stream = playback.resource && playback.resource.playStream;

    if (stream && typeof stream.destroy === 'function') {
      stream.on('error', () => {});

      try {
        stream.destroy();
      } catch (error) {
        logError('falha ao destruir o stream da faixa:', error);
      }
    }

    return playback;
  }

  _safeKill(playback) {
    if (!playback || typeof playback.kill !== 'function') return;

    try {
      playback.kill();
    } catch (error) {
      logError('falha ao encerrar o processo de áudio:', error);
    }
  }

  async _teardown() {
    if (this._tornDown) return;
    this._tornDown = true;

    this._clearDisconnectTimer();
    this.queue.length = 0;

    try {
      this.player.stop(true);
    } catch (error) {
      logError('falha ao parar o player:', error);
    }

    this._releasePlayback();

    this.player.off(IDLE_STATUS, this._onPlayerIdle);
    this.player.off('error', this._onPlayerError);

    const connection = this.detachConnection();

    if (connection) this._destroyConnection(connection);

    this.current = null;
    this.state = 'idle';

    if (this.registry) this.registry.delete(this.guildId);

    this._emit('onDestroy', this);
  }

  _subscribe(connection) {
    if (typeof connection.subscribe !== 'function') return;

    try {
      connection.subscribe(this.player);
    } catch (error) {
      logError('falha ao assinar o player na conexão:', error);
    }
  }

  _bindConnection(connection) {
    if (typeof connection.on !== 'function') return;

    connection.on('stateChange', (oldState, newState) => {
      if (!newState) return;

      if (newState.status === VoiceConnectionStatus.Ready) {
        this._clearDisconnectTimer();
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        this._scheduleDisconnectTimeout();
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        this._handleConnectionDestroyed();
      }
    });

    connection.on('error', (error) => {
      this.lastError = error;
      logError(`conexão de voz errou na guild ${this.guildId}:`, error);
    });
  }

  _scheduleDisconnectTimeout() {
    if (this._disconnectTimer || this.destroyed) return;

    this._disconnectTimer = setTimeout(() => {
      this._disconnectTimer = null;

      if (this.destroyed) return;
      if (this.connection && this.connection.state && this.connection.state.status === VoiceConnectionStatus.Ready) return;

      logError(`conexão de voz não recuperada na guild ${this.guildId}; encerrando sessão.`, 'timeout');
      this.destroy().catch((error) => logError('falha ao encerrar sessão após desconexão:', error));
    }, DISCONNECT_GRACE_MS);

    if (typeof this._disconnectTimer.unref === 'function') this._disconnectTimer.unref();
  }

  _clearDisconnectTimer() {
    if (!this._disconnectTimer) return;

    clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
  }

  _handleConnectionDestroyed() {
    if (this.destroyed) return;

    this.destroy().catch((error) => logError('falha ao encerrar sessão após conexão destruída:', error));
  }

  _destroyConnection(connection) {
    if (!connection) return;
    if (connection.state && connection.state.status === VoiceConnectionStatus.Destroyed) return;

    try {
      connection.destroy();
    } catch (error) {
      logError('falha ao destruir a conexão de voz:', error);
    }
  }
}

module.exports = GuildMusicSession;
