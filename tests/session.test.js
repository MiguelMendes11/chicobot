import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MusicRegistry from '../src/services/music/registry.js';
import GuildMusicSession from '../src/services/music/session.js';
import { createHarness } from './helpers/harness.js';
import { createFakeConnection, createFakePlayer, createTrackStub, settle } from './helpers/fakes.js';

describe('GuildMusicSession — reprodução', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('add inicia a primeira faixa automaticamente', async () => {
    const { session, player, resources } = createHarness();

    const result = await session.add(createTrackStub());
    await settle();

    expect(result.started).toBe(true);
    expect(result.position).toBe(1);
    expect(resources).toHaveLength(1);
    expect(player.playCalls).toHaveLength(1);
    expect(session.state).toBe('playing');
    expect(session.current).toBeTruthy();
  });

  it('add com fila em andamento enfileira sem iniciar', async () => {
    const { session, resources } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await settle();
    const second = await session.add(createTrackStub({ id: 't2' }));

    expect(second.started).toBe(false);
    expect(second.position).toBe(1);
    expect(resources).toHaveLength(1);
    expect(session.queue).toHaveLength(1);

    await session.add(createTrackStub({ id: 't3' }));
    expect(session.queue).toHaveLength(2);
  });

  it('pause e resume alternam o estado', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub());
    await settle();
    player.startPlaying();

    await session.pause();
    expect(session.state).toBe('paused');
    expect(player.pauseCalls).toBe(1);

    await session.resume();
    expect(session.state).toBe('playing');
    expect(player.unpauseCalls).toBe(1);
  });

  it('skip para a faixa atual e avança para a próxima', async () => {
    const { session, player, resources } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await settle();
    await session.add(createTrackStub({ id: 't2' }));

    const skipResult = await session.skip();
    expect(skipResult.skipped).toBe(true);
    await settle();

    expect(player.stopCalls).toBe(1);
    expect(resources).toHaveLength(2);
    expect(session.current.id).toBe('t2');
    expect(session.state).toBe('playing');
  });

  it('fim da fila volta o estado para idle', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub());
    await settle();

    player.emitIdle();
    await settle();

    expect(session.state).toBe('idle');
    expect(session.current).toBeNull();
    expect(session.queue).toHaveLength(0);
  });

  it('guardas mantêm os mesmos códigos de erro (regressão)', async () => {
    const { session } = createHarness();

    const error = await session.pause().catch((e) => e);
    expect(error.code).toBe('NO_PLAYBACK');

    let capacityError = null;

    for (let i = 0; i < 60 && !capacityError; i += 1) {
      try {
        await session.add(createTrackStub({ id: `t${i}` }));
      } catch (e) {
        capacityError = e;
      }
    }

    expect(capacityError && capacityError.code).toBe('QUEUE_FULL');
  });
});

describe('GuildMusicSession — teardown e registry', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('destroy limpa fila, player, conexão e remove do registry', async () => {
    const { session, registry, player } = createHarness();
    const connection = createFakeConnection();
    session.attachConnection(connection);

    await session.add(createTrackStub());
    await settle();

    await session.destroy();

    expect(session.destroyed).toBe(true);
    expect(session.queue).toHaveLength(0);
    expect(session.current).toBeNull();
    expect(registry.get('g1')).toBeNull();
    expect(connection.destroyCount).toBe(1);
    expect(connection.listenerCount('stateChange')).toBe(0);
    expect(player.listenerCount('idle')).toBe(0);
    expect(player.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('teardown de uma sessão destruída não remove a nova sessão do registry (guarda de identidade)', async () => {
    const registry = new MusicRegistry();
    const makeSession = (id) =>
      new GuildMusicSession(id, {
        registry,
        player: createFakePlayer(),
        createResource: async () => ({ resource: {}, kill() {} }),
      });

    const first = registry.getOrCreate('g1', makeSession);
    const destroyPromise = first.destroy();

    expect(first.destroyed).toBe(true);

    const second = registry.getOrCreate('g1', makeSession);

    expect(second).not.toBe(first);

    await destroyPromise;

    expect(registry.get('g1')).toBe(second);
    expect(second.destroyed).toBe(false);
  });

  it('attachConnection em sessão destruída destrói a conexão recebida', async () => {
    const { session } = createHarness();
    await session.destroy();

    const connection = createFakeConnection();
    const result = session.attachConnection(connection);

    expect(result).toBeNull();
    expect(connection.destroyCount).toBe(1);
    expect(session.connection).toBeNull();
  });

  it('troca de conexão desvincula a antiga: destruí-la não derruba a sessão', () => {
    const { session } = createHarness();
    const first = createFakeConnection();
    const second = createFakeConnection({ channelId: 'vc2' });

    session.attachConnection(first);
    session.attachConnection(second);

    expect(first.destroyCount).toBe(1);
    expect(first.listenerCount('stateChange')).toBe(0);

    first.setStatus('destroyed');

    expect(session.destroyed).toBe(false);
    expect(session.connection).toBe(second);

    second.setStatus('ready');
    expect(session.destroyed).toBe(false);
  });

  it('destroy é idempotente (teardown único)', async () => {
    const { session, registry } = createHarness();

    await Promise.all([session.destroy(), session.destroy()]);
    await session.destroy();

    expect(registry.size).toBe(0);
    expect(session._tornDown).toBe(true);
  });
});
