import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarness } from './helpers/harness.js';
import { createTrackStub, settle } from './helpers/fakes.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const { createMusicError } = nodeRequire('../src/services/music/errors.js');

async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await settle();
  }
}

function queueIds(session) {
  return session.queue.map((track) => track.id);
}

describe('Stage 9 — /loop: modo e snapshot', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setLoop alterna entre off, track e queue com previous/changed', async () => {
    const { session } = createHarness();

    expect(await session.setLoop('track')).toEqual({ mode: 'track', previous: 'off', changed: true });
    expect(await session.setLoop('queue')).toEqual({ mode: 'queue', previous: 'track', changed: true });
    expect(await session.setLoop('off')).toEqual({ mode: 'off', previous: 'queue', changed: true });
    expect(await session.setLoop('off')).toEqual({ mode: 'off', previous: 'off', changed: false });

    expect(session.loopMode).toBe('off');
  });

  it('setLoop com modo inválido rejeita e não altera o modo atual', async () => {
    const { session } = createHarness();
    await session.setLoop('queue');

    const error = await session.setLoop('banana').catch((caught) => caught);

    expect(error.code).toBe('INVALID_LOOP_MODE');
    expect(session.loopMode).toBe('queue');
  });

  it('setLoop aceita variação de caixa e espaços', async () => {
    const { session } = createHarness();

    await session.setLoop('  Track ');

    expect(session.loopMode).toBe('track');
  });

  it('snapshot expõe loopMode e o padrão é off', async () => {
    const { session } = createHarness();

    expect(session.snapshot().loopMode).toBe('off');

    await session.setLoop('track');

    expect(session.snapshot().loopMode).toBe('track');
  });
});

describe('Stage 9 — loop track', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('término natural reinicia a mesma faixa sem tocar na fila', async () => {
    const { session, player, resources } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    expect(session.current.id).toBe('t1');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t1');
    expect(session.state).toBe('playing');
    expect(queueIds(session)).toEqual(['t2']);
    expect(resources).toHaveLength(2);
    expect(player.playCalls).toHaveLength(2);
    expect(player.stopCalls).toBe(0);
  });

  it('reemit onTrackStart a cada repetição (presença continua funcionando)', async () => {
    const onTrackStart = vi.fn();
    const { session, player } = createHarness({ hooks: { onTrackStart } });

    await session.add(createTrackStub({ id: 't1' }));
    await flush();
    await session.setLoop('track');

    player.emitIdle();
    await flush();

    expect(onTrackStart).toHaveBeenCalledTimes(2);
    expect(onTrackStart.mock.calls[1][1].id).toBe('t1');
  });

  it('/skip pula de verdade e vai para a próxima', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    await session.skip();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(queueIds(session)).toEqual([]);
    expect(player.stopCalls).toBe(1);
  });

  it('/skip sem próxima música encerra a reprodução mesmo com loop ativo', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();
    await session.setLoop('track');

    await session.skip();
    await flush();

    expect(session.state).toBe('idle');
    expect(session.current).toBeNull();
    expect(queueIds(session)).toEqual([]);
    expect(player.playCalls).toHaveLength(1);
  });

  it('erro do player seguido de Idle não repete a faixa', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    player.emit('error', new Error('boom'));
    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(player.playCalls).toHaveLength(2);
  });

  it('falha ao recriar o resource avança sem transformar erro em loop', async () => {
    let calls = 0;
    const { session, player } = createHarness({
      createResource: async (track) => {
        calls += 1;
        if (calls === 2) throw createMusicError('STREAM_UNAVAILABLE');
        return { resource: { trackId: track.id }, kill() {} };
      },
    });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(session.state).toBe('playing');
    expect(queueIds(session)).toEqual([]);
    expect(calls).toBe(3);
  });

  it('reprodução longa mantém o loop ativo sem acionar a guarda', async () => {
    const { session, player } = createHarness({
      createResource: async (track) => ({
        resource: { trackId: track.id, playbackDuration: 200000 },
        kill() {},
      }),
    });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    for (let i = 0; i < 4; i += 1) {
      player.emitIdle();
      await flush();
      expect(session.current.id).toBe('t1');
    }

    expect(queueIds(session)).toEqual(['t2']);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('abortado'));
  });

  it('guarda de término instantâneo interrompe o loop após 3 reinícios', async () => {
    const { session, player } = createHarness({
      createResource: async (track) => ({
        resource: { trackId: track.id, playbackDuration: 0 },
        kill() {},
      }),
    });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    player.emitIdle();
    await flush();
    expect(session.current.id).toBe('t1');

    player.emitIdle();
    await flush();
    expect(session.current.id).toBe('t1');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(player.playCalls).toHaveLength(4);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('loop track abortado'));
  });

  it('modo de loop sobrevive ao fim da fila e é zerado com a destruição', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();
    await session.setLoop('track');

    await session.skip();
    await flush();

    expect(session.state).toBe('idle');
    expect(session.loopMode).toBe('track');

    await session.add(createTrackStub({ id: 't2' }));
    await flush();

    expect(session.loopMode).toBe('track');
    expect(session.current.id).toBe('t2');

    await session.destroy();

    expect(session.destroyed).toBe(true);
    expect(session.queue).toHaveLength(0);
    expect(session.current).toBeNull();
  });

  it('/stop encerra a sessão mesmo com loop track ativo', async () => {
    const { session, player, registry } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('track');

    await session.stop();
    await flush();

    expect(session.destroyed).toBe(true);
    expect(registry.get('g1')).toBeNull();
    expect(session.state).toBe('idle');
    expect(queueIds(session)).toEqual([]);
    expect(player.listenerCount('idle')).toBe(0);
    expect(player.playCalls).toHaveLength(1);
  });
});

describe('Stage 9 — loop queue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('término natural leva a faixa para o final da fila', async () => {
    const { session, player, resources } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();
    await session.setLoop('queue');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(queueIds(session)).toEqual(['t3', 't1']);
    expect(resources).toHaveLength(2);
  });

  it('com apenas a faixa atual o término natural a reproduz novamente', async () => {
    const { session, player, resources } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();
    await session.setLoop('queue');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t1');
    expect(session.state).toBe('playing');
    expect(queueIds(session)).toEqual([]);
    expect(resources).toHaveLength(2);
    expect(player.playCalls).toHaveLength(2);

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t1');
    expect(resources).toHaveLength(3);
  });

  it('/skip descarta a faixa e não a re-enfileira', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();
    await session.setLoop('queue');

    await session.skip();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(queueIds(session)).toEqual(['t3']);
  });

  it('falha de resource não re-enfileira a faixa que falhou', async () => {
    let calls = 0;
    const { session, player } = createHarness({
      createResource: async (track) => {
        calls += 1;
        if (calls === 2) throw createMusicError('STREAM_UNAVAILABLE');
        return { resource: { trackId: track.id }, kill() {} };
      },
    });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('queue');

    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t1');
    expect(queueIds(session)).toEqual([]);
    expect(calls).toBe(3);
  });

  it('erro do player não devolve a faixa para o final', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();
    await session.setLoop('queue');

    player.emit('error', new Error('boom'));
    player.emitIdle();
    await flush();

    expect(session.current.id).toBe('t2');
    expect(queueIds(session)).toEqual(['t3']);
  });

  it('/stop com loop queue limpa a fila e desconecta', async () => {
    const { session, registry } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    await session.setLoop('queue');

    await session.destroy();
    await flush();

    expect(registry.get('g1')).toBeNull();
    expect(queueIds(session)).toEqual([]);
    expect(session.current).toBeNull();
    expect(session.state).toBe('idle');
  });
});

describe('Stage 9 — concorrência das operações de loop', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setLoop, shuffle e skip disparados juntos são serializados pela _enqueue', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();

    player.emitIdle();

    const results = await Promise.all([
      session.setLoop('queue'),
      session.shuffle(),
      session.skip(),
      session.setLoop('off'),
    ]);

    await flush();

    expect(results[0]).toEqual({ mode: 'queue', previous: 'off', changed: true });
    expect(results[1]).toHaveProperty('shuffled');
    expect(results[2]).toMatchObject({ skipped: true });
    expect(results[3]).toEqual({ mode: 'off', previous: 'queue', changed: true });
    expect(session.loopMode).toBe('off');
    expect(session.queue.length).toBeLessThanOrEqual(2);
    expect(session.current).toBeTruthy();
  });

  it('mutação após /stop responde NO_PLAYBACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();
    await session.stop();

    const error = await session.removeAt(1).catch((caught) => caught);

    expect(error.code).toBe('NO_PLAYBACK');
    expect(session.queue).toHaveLength(0);
  });

  it('loop pode ser trocado durante o carregamento de uma faixa', async () => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const { session, player } = createHarness({
      createResource: async (track) => {
        await gate;
        return { resource: { trackId: track.id }, kill() {} };
      },
    });

    const addFirst = session.add(createTrackStub({ id: 't1' }));
    const addSecond = session.add(createTrackStub({ id: 't2' }));

    await Promise.all([addFirst, addSecond]);
    await flush();

    const pending = session.add(createTrackStub({ id: 't3' }));
    const loopChange = session.setLoop('track');

    release();
    await Promise.all([pending, loopChange]);
    await flush();

    expect(session.loopMode).toBe('track');
    expect(session.queue.map((track) => track.id)).toEqual(['t2', 't3']);
    expect(session.current.id).toBe('t1');
    expect(player.playCalls).toHaveLength(1);
  });
});
