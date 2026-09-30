import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import music from '../src/services/music/index.js';
import { createMusicError } from '../src/services/music/errors.js';
import {
  createFakeConnection,
  createFakePlayer,
  createVoiceState,
  createTrackStub,
  fakeAdapterCreator,
  fakeClient,
  settle,
} from './helpers/fakes.js';

const waitForReadyReady = async (connection) => {
  connection.setStatus('ready');
};

function createJoinOverrides(overrides = {}) {
  return {
    player: createFakePlayer(),
    createResource: async () => ({ resource: {}, kill() {} }),
    waitForReady: waitForReadyReady,
    ...overrides,
  };
}

describe('music.join — espera por VoiceConnectionStatus.Ready', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(async () => {
    await music.destroyAll();
    music.registry.clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await music.destroyAll();
    music.registry.clear();
    vi.restoreAllMocks();
  });

  it('aguarda o Ready antes de resolver e registra a sessão', async () => {
    const connection = createFakeConnection({ status: 'signalling' });
    const waitForReady = vi.fn(async (conn) => {
      conn.setStatus('ready');
    });

    const session = await music.join({
      guildId: 'g1',
      channelId: 'vc1',
      adapterCreator: fakeAdapterCreator,
      textChannelId: 'text1',
      joinVoiceChannel: () => connection,
      waitForReady,
      ...createJoinOverrides({ waitForReady }),
    });

    expect(waitForReady).toHaveBeenCalledWith(connection);
    expect(session.connection).toBe(connection);
    expect(session.adapterCreator).toBe(fakeAdapterCreator);
    expect(session.targetChannelId).toBe('vc1');
    expect(session.textChannelId).toBe('text1');
    expect(music.registry.get('g1')).toBe(session);
    expect(connection.state.status).toBe('ready');
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('conexão de voz pronta'))).toBe(true);
  });

  it('timeout na espera destrói a sessão vazia e a conexão (registry limpo)', async () => {
    const connection = createFakeConnection({ status: 'signalling' });
    const waitForReady = vi.fn(async () => {
      throw createMusicError('CONNECTION_TIMEOUT');
    });

    const error = await music
      .join({
        guildId: 'g1',
        channelId: 'vc1',
        adapterCreator: fakeAdapterCreator,
        joinVoiceChannel: () => connection,
        ...createJoinOverrides({ waitForReady }),
      })
      .catch((e) => e);

    expect(error.code).toBe('CONNECTION_TIMEOUT');
    await settle();
    expect(music.registry.get('g1')).toBeNull();
    expect(connection.destroyCount).toBeGreaterThanOrEqual(1);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('encerrada após falha de conexão'))).toBe(true);
  });

  it('falha de conexão com faixas em andamento preserva a sessão', async () => {
    const session = music.getOrCreateSession('g1', {
      player: createFakePlayer(),
      createResource: async () => ({ resource: {}, kill() {} }),
    });
    await session.add(createTrackStub());
    await settle();

    const connection = createFakeConnection({ status: 'signalling' });
    const waitForReady = vi.fn(async () => {
      throw createMusicError('CONNECTION_TIMEOUT');
    });

    const error = await music
      .join({
        guildId: 'g1',
        channelId: 'vc1',
        adapterCreator: fakeAdapterCreator,
        joinVoiceChannel: () => connection,
        ...createJoinOverrides({ waitForReady }),
      })
      .catch((e) => e);

    expect(error.code).toBe('CONNECTION_TIMEOUT');
    expect(music.registry.get('g1')).toBe(session);
    expect(session.destroyed).toBe(false);
    expect(session.current).toBeTruthy();
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('mantendo sessão'))).toBe(true);
  });

  it('segundo join reutiliza a conexão existente sem destruí-la', async () => {
    const connection = createFakeConnection({ status: 'signalling' });

    const first = await music.join({
      guildId: 'g1',
      channelId: 'vc1',
      adapterCreator: fakeAdapterCreator,
      joinVoiceChannel: () => connection,
      ...createJoinOverrides(),
    });

    const second = await music.join({
      guildId: 'g1',
      channelId: 'vc1',
      adapterCreator: fakeAdapterCreator,
      joinVoiceChannel: () => connection,
      ...createJoinOverrides(),
    });

    expect(second).toBe(first);
    expect(second.connection).toBe(connection);
    expect(connection.destroyCount).toBe(0);
  });

  it('valida os argumentos obrigatórios', async () => {
    await expect(music.join({ guildId: 'g1', channelId: 'vc1' })).rejects.toThrow(TypeError);
  });
});

describe('music.onVoiceStateUpdate — roteamento', () => {
  beforeEach(async () => {
    await music.destroyAll();
    music.registry.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await music.destroyAll();
    music.registry.clear();
    vi.restoreAllMocks();
  });

  it('retorna null quando não há sessão', () => {
    const result = music.onVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: 'vc1' }),
      createVoiceState({ id: 'bot-1', channelId: null })
    );

    expect(result).toBeNull();
  });

  it('delega para a sessão do guild quando existe', async () => {
    await music.join({
      guildId: 'g1',
      channelId: 'vc1',
      adapterCreator: fakeAdapterCreator,
      joinVoiceChannel: () => createFakeConnection({ status: 'ready' }),
      ...createJoinOverrides(),
    });

    const session = music.getSession('g1');
    expect(session).toBeTruthy();

    music.onVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: 'vc1' }),
      createVoiceState({ id: 'bot-1', channelId: null })
    );
    await settle();
    await session._chain;
    await settle();

    expect(session.destroyed).toBe(true);
    expect(music.registry.get('g1')).toBeNull();
  });
});
