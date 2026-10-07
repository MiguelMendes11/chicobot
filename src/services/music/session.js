const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  joinVoiceChannel: defaultJoinVoiceChannel,
} = require('@discordjs/voice');
const { createMusicError } = require('./errors');
const {
  assertQueueCapacity,
  assertQueueNotEmpty,
  assertSessionActive,
  assertSessionPaused,
  assertSessionPlaying,
  parseQueuePosition,
} = require('./guards');
const { createTrackResource } = require('./stream');
const { releaseTrackInfo } = require('./source/ytdlp');
const { computeBackoff, shouldReconnect } = require('./connectionLifecycle');
const timing = require('./timing');
const { MUSIC_CONFIG } = require('./constants');

const IDLE_STATUS = AudioPlayerStatus.Idle;
const DISCONNECT_GRACE_MS = MUSIC_CONFIG.DISCONNECT_GRACE_MS;
const RECONNECT_MAX_ATTEMPTS = MUSIC_CONFIG.RECONNECT_MAX_ATTEMPTS;
const EMPTY_CHANNEL_GRACE_MS = MUSIC_CONFIG.EMPTY_CHANNEL_GRACE_MS;

function logError(context, error) {
  const detail = error && error.message ? error.message : String(error);
  console.error(`❌ [música] ${context}`, detail);
}

function logInfo(message) {
  console.log(`🎵 [música] ${message}`);
}

function logWarn(message) {
  console.warn(`⚠️ [música] ${message}`);
}

function countChannelHumans(channel) {
  if (!channel || !channel.members || typeof channel.members.forEach !== 'function') return null;

  let humans = 0;

  channel.members.forEach((member) => {
    if (member && member.user && member.user.bot !== true) humans += 1;
  });

  return humans;
}

function clampProgressSeconds(seconds, durationSeconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0 && seconds > durationSeconds) return durationSeconds;
  return seconds;
}

function normalizeLoopMode(mode) {
  const value = typeof mode === 'string' ? mode.trim().toLowerCase() : '';

  if (!MUSIC_CONFIG.LOOP_MODES.includes(value)) {
    throw createMusicError('INVALID_LOOP_MODE', {
      details: `esperado ${MUSIC_CONFIG.LOOP_MODES.join(', ')}`,
    });
  }

  return value;
}

function pickRandom(random) {
  if (typeof random === 'function') return random;
  return Math.random;
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
    this.adapterCreator = options.adapterCreator || null;
    this.targetChannelId = options.targetChannelId || null;
    this.joinVoiceChannel = typeof options.joinVoiceChannel === 'function'
      ? options.joinVoiceChannel
      : defaultJoinVoiceChannel;

    this.connection = null;
    this.queue = [];
    this.current = null;
    this.state = 'idle';
    this.destroyed = false;
    this.lastError = null;
    this.loopMode = 'off';
    this.random = pickRandom(options.random);

    this._playback = null;
    this._chain = Promise.resolve();
    this._advancePending = false;
    this._advanceCoversCurrent = false;
    this._pendingSkips = 0;
    this._skipRequested = false;
    this._playerErrorAt = null;
    this._instantStreak = 0;
    this._tornDown = false;

    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._reconnecting = false;
    this._emptyChannelTimer = null;
    this._emptyChannelSource = null;
    this._manualRemoval = false;
    this._stopping = false;

    this._boundConnection = null;
    this._boundStateHandler = null;
    this._boundErrorHandler = null;
    this._audioProbeListener = null;

    this._onPlayerIdle = () => this._scheduleAdvance('player-idle');
    this._onPlayerError = (error) => {
      this.lastError = error;
      this._playerErrorAt = Date.now();
      logError(`player errou na guild ${guildId}:`, error);
    };

    this.player.on(IDLE_STATUS, this._onPlayerIdle);
    this.player.on('error', this._onPlayerError);
  }

  get channelId() {
    if (!this.connection || !this.connection.joinConfig) return null;
    return this.connection.joinConfig.channelId || null;
  }

  getProgress() {
    if (!this.current) return { positionSeconds: 0, durationSeconds: null, percent: null };

    const durationSeconds =
      Number.isFinite(this.current.duration) && this.current.duration >= 0 ? this.current.duration : null;

    const rawMs = this.player && this.player.state ? this.player.state.playbackDuration : null;
    const positionSeconds = Number.isFinite(rawMs)
      ? Math.round(clampProgressSeconds(rawMs / 1000, durationSeconds) * 100) / 100
      : 0;

    const percent =
      durationSeconds && durationSeconds > 0
        ? Math.min(100, Math.max(0, Math.round((positionSeconds / durationSeconds) * 100)))
        : null;

    return { positionSeconds, durationSeconds, percent };
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
      loopMode: this.loopMode,
      progress: this.getProgress(),
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
      this._clearEmptyChannelTimer();
      assertQueueCapacity(this);

      const position = this.queue.length + 1;
      this.queue.push(track);

      const shouldStart = this.state === 'idle' && !this.current;

      if (shouldStart) this._scheduleAdvance('auto-start');

      this._emit('onQueueChange', this);

      return { position, started: shouldStart && position === 1, queueLength: this.queue.length };
    });
  }

  setLoop(mode) {
    return this._enqueue(() => {
      const next = normalizeLoopMode(mode);
      const previous = this.loopMode;

      this.loopMode = next;
      this._instantStreak = 0;

      return { mode: next, previous, changed: next !== previous };
    });
  }

  shuffle() {
    return this._enqueue(() => {
      assertQueueNotEmpty(this);

      const total = this.queue.length;

      for (let index = total - 1; index > 0; index -= 1) {
        const raw = Math.floor(this.random() * (index + 1));
        const swap = Math.max(0, Math.min(index, raw));

        if (swap === index) continue;

        const held = this.queue[index];
        this.queue[index] = this.queue[swap];
        this.queue[swap] = held;
      }

      this._emit('onQueueChange', this);

      return { shuffled: total, queueLength: total };
    });
  }

  removeAt(position) {
    return this._enqueue(async () => {
      assertQueueNotEmpty(this);

      const index =
        parseQueuePosition(position, this.queue.length, {
          lowDetail: 'a música atual não pode ser removida; use /skip',
        }) - 1;

      const [removed] = this.queue.splice(index, 1);

      if (removed) await releaseTrackInfo(removed);

      this._emit('onQueueChange', this);

      return { track: removed || null, position: index + 1, queueLength: this.queue.length };
    });
  }

  clearUpcoming() {
    return this._enqueue(async () => {
      assertQueueNotEmpty(this);

      const removed = this.queue.splice(0, this.queue.length);

      for (const track of removed) {
        await releaseTrackInfo(track);
      }

      this._emit('onQueueChange', this);

      return { removed: removed.length, queueLength: this.queue.length };
    });
  }

  moveTrack(from, to) {
    return this._enqueue(() => {
      assertQueueNotEmpty(this);

      const total = this.queue.length;
      const options = { lowDetail: 'informe posições a partir de 1' };

      const fromIndex = parseQueuePosition(from, total, options) - 1;
      const toIndex = parseQueuePosition(to, total, options) - 1;

      const [moved] = this.queue.splice(fromIndex, 1);
      this.queue.splice(toIndex, 0, moved);

      this._emit('onQueueChange', this);

      return { track: moved, from: fromIndex + 1, to: toIndex + 1, queueLength: total };
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
        this._skipRequested = true;

        if (this._advanceCoversCurrent) {
          this._pendingSkips += 1;
        } else {
          this._advanceCoversCurrent = true;
          this._scheduleAdvance('skip-idle');
        }

        return { skipped: true, deferred: true };
      }

      this._skipRequested = true;
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
    this._stopping = true;

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
      this._unbindConnection();
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
    this._unbindConnection();
    this._clearReconnectTimer();
    this._reconnecting = false;
    this._clearEmptyChannelTimer();

    return connection;
  }

  handleVoiceStateUpdate(client, oldState, newState) {
    if (this.destroyed) return;

    const botId = client && client.user ? client.user.id : null;
    if (!botId) return;

    const oldId = oldState ? oldState.id : null;
    const newId = newState ? newState.id : null;
    const involvesBot = oldId === botId || newId === botId;

    if (involvesBot) {
      if (this._stopping) return;

      const from = oldState ? oldState.channelId : null;
      const to = newState ? newState.channelId : null;

      if (from && !to) {
        this._manualRemoval = true;
        logInfo(`bot removido do canal de voz na guild ${this.guildId}; encerrando sessão e fila.`);
        this.destroy().catch((error) => logError('falha ao encerrar sessão após remoção manual:', error));
        return;
      }

      if (from && to && from !== to) {
        this._manualRemoval = true;
        logInfo(`bot movido de canal de voz na guild ${this.guildId}; encerrando sessão e fila.`);
        this.destroy().catch((error) => logError('falha ao encerrar sessão após movimentação:', error));
        return;
      }

      return;
    }

    const botChannelId = this.channelId;
    if (!botChannelId) return;

    const enteredBotChannel = newState && newState.channelId === botChannelId;
    const leftBotChannel = oldState && oldState.channelId === botChannelId;

    if (enteredBotChannel) {
      this._clearEmptyChannelTimer();
      return;
    }

    if (!leftBotChannel) return;

    const channel = (oldState && oldState.channel) || (newState && newState.channel) || null;
    const humans = countChannelHumans(channel);

    if (humans === null) {
      logWarn(`não foi possível verificar a ocupação do canal na guild ${this.guildId}; desconexão automática não agendada.`);
      return;
    }

    if (humans === 0) this._scheduleEmptyChannelDisconnect(channel);
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
    const skipIntent = this._skipRequested || this._pendingSkips > 0 || reason === 'skip-idle';
    const playerFailed = Boolean(this._playerErrorAt);

    this._skipRequested = false;
    this._playerErrorAt = null;

    if (this.destroyed) return;

    const idleDerived = reason === 'player-idle' || reason === 'skip-idle';

    if (idleDerived && this.player.state.status !== IDLE_STATUS) return;

    if (!this.current && this.queue.length === 0) return;

    const finished = this.current;
    const extraSkips = this._pendingSkips;

    this._pendingSkips = 0;
    this._advanceCoversCurrent = false;
    const finishedPlayback = this._releasePlayback();

    if (finished) this._emit('onTrackEnd', this, finished, reason);

    const naturalEnd = reason === 'player-idle' && !skipIntent && !playerFailed;

    let allowLoop = false;

    if (naturalEnd && this.loopMode !== 'off' && finished) {
      allowLoop = this._registerLoopEnd(finishedPlayback);

      if (!allowLoop) {
        logWarn(
          `loop ${this.loopMode} abortado na guild ${this.guildId}: término instantâneo repetido; seguindo com a fila.`
        );
      }
    }

    if (allowLoop && this.loopMode === 'track') {
      await this._startTrack(finished);
      return;
    }

    if (allowLoop && this.loopMode === 'queue') {
      this.queue.push(finished);
      this._emit('onQueueChange', this);
    }

    let remaining = extraSkips;

    while (remaining > 0 && this.queue.length > 0) {
      const dropped = this.queue.shift();
      await releaseTrackInfo(dropped);
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

  _registerLoopEnd(playback) {
    const playedMs = playback && playback.resource ? Number(playback.resource.playbackDuration) : NaN;

    if (Number.isFinite(playedMs) && playedMs < MUSIC_CONFIG.LOOP_MIN_PLAYBACK_MS) {
      this._instantStreak += 1;
    } else {
      this._instantStreak = 0;
    }

    return this._instantStreak < MUSIC_CONFIG.LOOP_MAX_INSTANT_ENDS;
  }

  async _startTrack(track) {
    this.current = track;
    this.state = 'loading';

    let playback = null;

    timing.mark(this.guildId, 'resource.begin');

    try {
      playback = await this.createResource(track, this);
    } catch (error) {
      timing.mark(this.guildId, 'resource.end');
      await this._handleTrackFailure(track, error);
      return;
    }

    timing.mark(this.guildId, 'resource.end');

    if (this.destroyed) {
      this._safeKill(playback);
      return;
    }

    timing.mark(this.guildId, 'play.call');

    try {
      this.player.play(playback.resource);
    } catch (error) {
      this._safeKill(playback);
      await this._handleTrackFailure(track, error);
      return;
    }

    this._playback = playback;
    this.current = track;
    this.state = 'playing';
    this._playerErrorAt = null;
    this._armAudioStartProbe();
    this._emit('onTrackStart', this, track);
  }

  async _handleTrackFailure(track, error) {
    this._playback = null;
    this.current = null;
    this.state = 'idle';
    this.lastError = error;

    timing.mark(this.guildId, 'play.error');

    await releaseTrackInfo(track);

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

  _armAudioStartProbe() {
    if (!timing.isEnabled()) return;

    this._disarmAudioStartProbe();

    const onStateChange = (_oldState, newState) => {
      if (!newState) return;

      if (newState.status === AudioPlayerStatus.Playing) {
        timing.mark(this.guildId, 'play.audio');
        this._disarmAudioStartProbe();
      }
    };

    this._audioProbeListener = onStateChange;
    this.player.on('stateChange', onStateChange);
  }

  _disarmAudioStartProbe() {
    if (!this._audioProbeListener) return;

    this.player.off('stateChange', this._audioProbeListener);
    this._audioProbeListener = null;
  }

  _releasePlayback() {
    const playback = this._playback;

    this._playback = null;
    this.current = null;

    this._disarmAudioStartProbe();

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

    this._clearReconnectTimer();
    this._reconnecting = false;
    this._clearEmptyChannelTimer();
    this._disarmAudioStartProbe();

    await releaseTrackInfo(this.current);

    for (const queued of this.queue) {
      await releaseTrackInfo(queued);
    }

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

    if (this.registry && this.registry.get(this.guildId) === this) {
      this.registry.delete(this.guildId);
    }

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

    this._unbindConnection();

    const onStateChange = (_oldState, newState) => {
      if (!newState || this.destroyed) return;

      if (newState.status === VoiceConnectionStatus.Ready) {
        this._handleConnectionReady();
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        this._handleConnectionDisconnected();
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        this._handleConnectionDestroyed();
      }
    };

    const onError = (error) => {
      this.lastError = error;
      logError(`conexão de voz errou na guild ${this.guildId}:`, error);
    };

    connection.on('stateChange', onStateChange);
    connection.on('error', onError);

    this._boundConnection = connection;
    this._boundStateHandler = onStateChange;
    this._boundErrorHandler = onError;
  }

  _unbindConnection() {
    const connection = this._boundConnection;

    if (connection) {
      if (typeof connection.off === 'function') {
        if (this._boundStateHandler) connection.off('stateChange', this._boundStateHandler);
        if (this._boundErrorHandler) connection.off('error', this._boundErrorHandler);
      } else if (typeof connection.removeListener === 'function') {
        if (this._boundStateHandler) connection.removeListener('stateChange', this._boundStateHandler);
        if (this._boundErrorHandler) connection.removeListener('error', this._boundErrorHandler);
      }
    }

    this._boundConnection = null;
    this._boundStateHandler = null;
    this._boundErrorHandler = null;
  }

  _reconnectGuard() {
    return shouldReconnect({
      destroyed: this.destroyed,
      manualRemoval: this._manualRemoval,
      stopping: this._stopping,
    });
  }

  _handleConnectionReady() {
    const wasReconnecting = this._reconnecting;
    const attempts = this._reconnectAttempts;

    this._clearReconnectTimer();
    this._reconnecting = false;
    this._reconnectAttempts = 0;

    if (wasReconnecting) {
      logInfo(`conexão restaurada na guild ${this.guildId} após ${attempts} tentativa(s).`);
    }
  }

  _handleConnectionDisconnected() {
    if (!this._reconnectGuard()) return;

    if (this._reconnecting) {
      if (this._reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        this._giveUpReconnect(`reconexão falhou após ${this._reconnectAttempts} tentativa(s)`);
        return;
      }

      if (!this._reconnectTimer) this._scheduleReconnectAttempt();
      return;
    }

    logWarn(`conexão perdida na guild ${this.guildId}; aguardando ${DISCONNECT_GRACE_MS}ms antes de reconectar.`);

    this._reconnecting = true;
    this._reconnectAttempts = 0;
    this._reconnectTimer = setTimeout(() => this._attemptReconnect(), DISCONNECT_GRACE_MS);

    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  _scheduleReconnectAttempt() {
    if (this._reconnectTimer) return;
    if (!this._reconnectGuard()) return;

    const delay = computeBackoff(this._reconnectAttempts);
    this._reconnectTimer = setTimeout(() => this._attemptReconnect(), delay);

    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  _attemptReconnect() {
    this._reconnectTimer = null;

    if (!this._reconnectGuard()) return;

    if (this.connection && this.connection.state && this.connection.state.status === VoiceConnectionStatus.Ready) {
      this._handleConnectionReady();
      return;
    }

    if (!this.adapterCreator) {
      this._giveUpReconnect('adapterCreator indisponível para reconexão');
      return;
    }

    const channelId = this.channelId || this.targetChannelId;

    if (!channelId) {
      this._giveUpReconnect('canal de voz de destino desconhecido');
      return;
    }

    this._reconnectAttempts += 1;

    if (this._reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this._giveUpReconnect(`reconexão falhou após ${RECONNECT_MAX_ATTEMPTS} tentativa(s)`);
      return;
    }

    logInfo(`reconexão tentativa ${this._reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} na guild ${this.guildId}.`);

    try {
      const connection = this.joinVoiceChannel({
        channelId,
        guildId: this.guildId,
        adapterCreator: this.adapterCreator,
        selfDeaf: true,
      });

      this.attachConnection(connection);
    } catch (error) {
      logError(`falha ao tentar reconectar na guild ${this.guildId}:`, error);
      this._scheduleReconnectAttempt();
    }
  }

  _giveUpReconnect(reason) {
    this._clearReconnectTimer();
    this._reconnecting = false;

    logWarn(`reconexão abortada na guild ${this.guildId}: ${reason}; encerrando sessão.`);
    this.destroy().catch((error) => logError('falha ao encerrar sessão após reconexão:', error));
  }

  _clearReconnectTimer() {
    if (!this._reconnectTimer) return;

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _scheduleEmptyChannelDisconnect(channel) {
    if (this.destroyed || this._emptyChannelTimer) return;

    this._emptyChannelSource = channel || null;
    logInfo(`canal de voz sem usuários na guild ${this.guildId}; desconectando em ${EMPTY_CHANNEL_GRACE_MS / 1000}s.`);

    this._emptyChannelTimer = setTimeout(() => this._onEmptyChannelTimeout(), EMPTY_CHANNEL_GRACE_MS);

    if (typeof this._emptyChannelTimer.unref === 'function') this._emptyChannelTimer.unref();
  }

  _onEmptyChannelTimeout() {
    this._emptyChannelTimer = null;

    if (this.destroyed) return;

    const channel = this._emptyChannelSource;
    this._emptyChannelSource = null;

    if (channel) {
      const humans = countChannelHumans(channel);

      if (humans === null) {
        logWarn(`não foi possível confirmar a ocupação do canal na guild ${this.guildId}; desconexão automática cancelada.`);
        return;
      }

      if (humans > 0) return;
    }

    logInfo(`canal de voz vazio por ${EMPTY_CHANNEL_GRACE_MS / 1000}s na guild ${this.guildId}; desconectando.`);
    this.destroy().catch((error) => logError('falha ao desconectar de canal vazio:', error));
  }

  _clearEmptyChannelTimer() {
    if (!this._emptyChannelTimer) {
      this._emptyChannelSource = null;
      return;
    }

    clearTimeout(this._emptyChannelTimer);
    this._emptyChannelTimer = null;
    this._emptyChannelSource = null;
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
