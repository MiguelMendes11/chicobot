import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import music from '../src/services/music/index.js';
import {
  createFakeConnection,
  createFakePlayer,
  createTrackStub,
  fakeAdapterCreator,
  settle,
} from './helpers/fakes.js';

const waitForReadyReady = async (connection) => {
  connection.setStatus('ready');
};

describe('/stop — comportamento preservado (serviço)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await music.destroyAll();
    music.registry.clear();
  });

  afterEach(async () => {
    await music.destroyAll();
    music.registry.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function joinParams(overrides = {}) {
    const connection = createFakeConnection({ status: 'signalling' });

    return {
      connection,
      params: {
        guildId: 'g1',
        channelId: 'vc1',
        adapterCreator: fakeAdapterCreator,
        joinVoiceChannel: () => connection,
        player: createFakePlayer(),
        createResource: async () => ({ resource: {}, kill() {} }),
        waitForReady: waitForReadyReady,
        ...overrides,
      },
    };
  }

  it('destroy limpa fila, destrói conexão, remove do registry e retorna true', async () => {
    const { connection, params } = joinParams();

    const session = await music.join(params);
    await session.add(createTrackStub());
    await settle();

    expect(music.registry.get('g1')).toBe(session);

    const stopped = await music.stop('g1');

    expect(stopped).toBe(true);
    expect(session.destroyed).toBe(true);
    expect(session.queue).toHaveLength(0);
    expect(music.registry.get('g1')).toBeNull();
    expect(connection.destroyCount).toBe(1);
  });

  it('stop repetido retorna false quando não há sessão', async () => {
    expect(await music.stop('g1')).toBe(false);

    const { params } = joinParams();
    await music.join(params);

    expect(await music.stop('g1')).toBe(true);
    expect(await music.stop('g1')).toBe(false);
  });

  it('stop durante backoff de reconexão cancela tentativas seguintes', async () => {
    const reconnections = [];
    const joinVoiceChannel = vi.fn((options) => {
      if (joinVoiceChannel.mock.calls.length === 1) return initialConnection;
      const connection = createFakeConnection({ guildId: options.guildId, channelId: options.channelId });
      reconnections.push(connection);
      return connection;
    });

    const initialConnection = createFakeConnection({ status: 'ready' });

    const session = await music.join({
      guildId: 'g1',
      channelId: 'vc1',
      adapterCreator: fakeAdapterCreator,
      joinVoiceChannel,
      player: createFakePlayer(),
      createResource: async () => ({ resource: {}, kill() {} }),
      waitForReady: waitForReadyReady,
    });

    await session.add(createTrackStub());
    await settle();

    initialConnection.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(joinVoiceChannel).toHaveBeenCalledTimes(2);
    expect(reconnections).toHaveLength(1);

    reconnections[0].setStatus('disconnected');
    expect(vi.getTimerCount()).toBe(1);

    const stopped = await music.stop('g1');
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60000);
    expect(joinVoiceChannel).toHaveBeenCalledTimes(2);
    expect(music.registry.get('g1')).toBeNull();
  });
});
