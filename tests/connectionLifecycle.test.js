import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  waitForConnectionReady,
  computeBackoff,
  shouldReconnect,
} from '../src/services/music/connectionLifecycle.js';
import { createFakeConnection } from './helpers/fakes.js';

describe('waitForConnectionReady', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolve imediatamente quando a conexão já está pronta', async () => {
    const connection = createFakeConnection({ status: 'ready' });
    const entersState = vi.fn(() => new Promise(() => {}));

    await expect(waitForConnectionReady(connection, { entersState })).resolves.toBe(connection);
    expect(entersState).not.toHaveBeenCalled();
  });

  it('resolve quando a conexão atinge Ready durante a espera', async () => {
    const connection = createFakeConnection({ status: 'signalling' });
    const entersState = vi.fn(() => new Promise(() => {}));

    const promise = waitForConnectionReady(connection, { entersState, timeoutMs: 60000 });
    connection.setStatus('ready');

    await expect(promise).resolves.toBe(connection);
    expect(connection.listenerCount('stateChange')).toBe(0);
  });

  it('rejeita CONNECTION_TIMEOUT quando entersState rejeita', async () => {
    const connection = createFakeConnection();
    const entersState = vi.fn(() => Promise.reject(new Error('timeout')));

    const error = await waitForConnectionReady(connection, { entersState }).catch((e) => e);

    expect(error.code).toBe('CONNECTION_TIMEOUT');
    expect(connection.listenerCount('stateChange')).toBe(0);
  });

  it('rejeita CONNECTION_TIMEOUT rapidamente se a conexão for destruída durante a espera', async () => {
    const connection = createFakeConnection({ status: 'connecting' });
    const entersState = vi.fn(() => new Promise(() => {}));

    const promise = waitForConnectionReady(connection, { entersState, timeoutMs: 120000 });
    connection.setStatus('destroyed');

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('CONNECTION_TIMEOUT');
    expect(connection.listenerCount('stateChange')).toBe(0);
  });

  it('rejeita CONNECTION_TIMEOUT quando o timeout expira', async () => {
    vi.useFakeTimers();

    const connection = createFakeConnection({ status: 'signalling' });
    const entersState = vi.fn(() => new Promise(() => {}));

    const promise = waitForConnectionReady(connection, { entersState, timeoutMs: 20000 });
    const expectation = expect(promise).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(20000);
    await expectation;
  });

  it('rejeita CONNECTION_TIMEOUT para conexão nula ou sem eventos', async () => {
    await expect(waitForConnectionReady(null)).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await expect(waitForConnectionReady({})).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
  });
});

describe('computeBackoff', () => {
  it('usa a tabela de backoff com limite superior', () => {
    expect(computeBackoff(1)).toBe(1000);
    expect(computeBackoff(2)).toBe(3000);
    expect(computeBackoff(3)).toBe(5000);
    expect(computeBackoff(10)).toBe(5000);
    expect(computeBackoff(0)).toBe(1000);
  });
});

describe('shouldReconnect', () => {
  it('só permite reconexão quando não há destruição, remoção manual ou parada', () => {
    expect(shouldReconnect({})).toBe(true);
    expect(shouldReconnect({ destroyed: true })).toBe(false);
    expect(shouldReconnect({ manualRemoval: true })).toBe(false);
    expect(shouldReconnect({ stopping: true })).toBe(false);
  });
});
