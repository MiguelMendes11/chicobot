import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHarness } from './helpers/harness.js';
import { createFakeConnection, createTrackStub, settle } from './helpers/fakes.js';

async function flush(session) {
  await settle();
  await session._chain;
  await settle();
}

function createReconnectHarness() {
  const connections = [];
  const joinVoiceChannel = vi.fn((options) => {
    const connection = createFakeConnection({
      guildId: options.guildId,
      channelId: options.channelId,
    });
    connections.push(connection);
    return connection;
  });

  const harness = createHarness({ joinVoiceChannel });
  harness.connections = connections;
  harness.joinMock = joinVoiceChannel;
  harness.initialConnection = createFakeConnection({ status: 'ready' });
  harness.session.attachConnection(harness.initialConnection);

  return harness;
}

describe('ciclo de vida da conexão — reconexão', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Disconnected transitório: grace + reconexão + Ready restaura a sessão', async () => {
    const { session, registry, joinMock, connections, initialConnection } = createReconnectHarness();

    initialConnection.setStatus('disconnected');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(joinMock).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
    expect(session.connection).toBe(connections[0]);

    connections[0].setStatus('ready');
    expect(session.destroyed).toBe(false);
    expect(session._reconnectAttempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    connections[0].setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);

    expect(joinMock).toHaveBeenCalledTimes(2);
    expect(registry.get('g1')).toBe(session);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('conexão restaurada'))).toBe(true);
  });

  it('esgota tentativas com backoff e faz cleanup completo', async () => {
    const { session, registry, joinMock, connections, initialConnection } = createReconnectHarness();

    initialConnection.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(joinMock).toHaveBeenCalledTimes(1);

    connections[0].setStatus('disconnected');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(joinMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(joinMock).toHaveBeenCalledTimes(2);

    connections[1].setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    expect(joinMock).toHaveBeenCalledTimes(3);

    connections[2].setStatus('disconnected');
    await flush(session);

    expect(session.destroyed).toBe(true);
    expect(registry.get('g1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('reconexão abortada'))).toBe(true);
  });

  it('destroy durante o backoff cancela as tentativas seguintes', async () => {
    const { session, registry, joinMock, connections, initialConnection } = createReconnectHarness();

    initialConnection.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(joinMock).toHaveBeenCalledTimes(1);

    connections[0].setStatus('disconnected');
    expect(vi.getTimerCount()).toBe(1);

    await session.destroy();

    expect(registry.get('g1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60000);
    expect(joinMock).toHaveBeenCalledTimes(1);
  });

  it('sem adapterCreator a reconexão desiste imediatamente', async () => {
    const joinMock = vi.fn(() => {
      throw new Error('não deveria ser chamado');
    });

    const { session, registry } = createHarness({ adapterCreator: null, joinVoiceChannel: joinMock });
    const connection = createFakeConnection({ status: 'ready' });
    session.attachConnection(connection);

    connection.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    await flush(session);

    expect(joinMock).toHaveBeenCalledTimes(0);
    expect(registry.get('g1')).toBeNull();
    expect(session.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falha ao chamar joinVoiceChannel agenda nova tentativa', async () => {
    let shouldFail = true;
    const joinCalls = [];

    const joinVoiceChannel = vi.fn((options) => {
      joinCalls.push(options);
      if (shouldFail) {
        shouldFail = false;
        throw new Error('adapter quebrou');
      }
      return createFakeConnection({ guildId: options.guildId, channelId: options.channelId });
    });

    const { session, registry } = createHarness({ joinVoiceChannel });
    const initialConnection = createFakeConnection({ status: 'ready' });
    session.attachConnection(initialConnection);
    initialConnection.setStatus('disconnected');

    await vi.advanceTimersByTimeAsync(5000);
    expect(joinCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(joinCalls).toHaveLength(2);

    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('falha ao tentar reconectar'))).toBe(true);
    expect(session.destroyed).toBe(false);
    expect(registry.get('g1')).toBe(session);
  });

  it('reconexão preserva a fila', async () => {
    const { session, joinMock, initialConnection } = createReconnectHarness();

    await session.add(createTrackStub());
    await settle();

    initialConnection.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(5000);

    expect(joinMock).toHaveBeenCalledTimes(1);
    expect(session.destroyed).toBe(false);
    expect(session.state).toBe('playing');
  });
});
