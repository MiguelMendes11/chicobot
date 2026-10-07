import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHarness } from './helpers/harness.js';
import { createTrackStub, settle } from './helpers/fakes.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const ytdlp = nodeRequire('../src/services/music/source/ytdlp.js');

const createdFiles = [];

function sampleEntry(id) {
  return {
    id,
    title: `Faixa ${id}`,
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
    duration: 200,
    is_live: false,
    live_status: 'not_live',
    formats: [],
  };
}

function makeInfoFile(id) {
  const file = ytdlp.createInfoFile(sampleEntry(id));
  createdFiles.push(file);
  return file;
}

function queueIds(session) {
  return session.queue.map((track) => track.id);
}

async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await settle();
  }
}

describe('Stage 9 — /shuffle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  it('embaralha somente as próximas e mantém a atual intacta', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await session.add(createTrackStub({ id: 't4' }));
    await flush();

    const before = session.current;
    const result = await session.shuffle();

    expect(result.shuffled).toBe(3);
    expect(result.queueLength).toBe(3);
    expect(session.current).toBe(before);
    expect(session.current.id).toBe('t1');
    expect(queueIds(session).sort()).toEqual(['t2', 't3', 't4']);
    expect(session.queue).toHaveLength(3);
  });

  it('é determinística com a função random injetada', async () => {
    const { session } = createHarness({ random: () => 0 });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await session.add(createTrackStub({ id: 't4' }));
    await flush();

    await session.shuffle();

    expect(queueIds(session)).toEqual(['t3', 't4', 't2']);
    expect(session.current.id).toBe('t1');
  });

  it('preserva os objetos Track e seus infoFiles', async () => {
    const file2 = makeInfoFile('t2');
    const file3 = makeInfoFile('t3');
    const { session } = createHarness();

    const t2 = createTrackStub({ id: 't2', infoFile: file2 });
    const t3 = createTrackStub({ id: 't3', infoFile: file3 });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(t2);
    await session.add(t3);
    await flush();

    await session.shuffle();

    expect(session.queue).toHaveLength(2);
    expect(session.queue).toContain(t2);
    expect(session.queue).toContain(t3);
    expect(t2.infoFile).toBe(file2);
    expect(t3.infoFile).toBe(file3);
    expect(fs.existsSync(file2)).toBe(true);
    expect(fs.existsSync(file3)).toBe(true);

    await session.destroy();
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file3)).toBe(false);
  });

  it('sem próximas músicas responde NO_NEXT_TRACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();

    const error = await session.shuffle().catch((caught) => caught);

    expect(error.code).toBe('NO_NEXT_TRACK');
    expect(session.current.id).toBe('t1');
  });

  it('com uma única próxima música não altera o tamanho da fila', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();

    const result = await session.shuffle();

    expect(result.shuffled).toBe(1);
    expect(queueIds(session)).toEqual(['t2']);
  });

  it('emite onQueueChange', async () => {
    const onQueueChange = vi.fn();
    const { session } = createHarness({ hooks: { onQueueChange } });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    onQueueChange.mockClear();

    await session.shuffle();

    expect(onQueueChange).toHaveBeenCalledTimes(1);
    expect(onQueueChange.mock.calls[0][0]).toBe(session);
  });
});

describe('Stage 9 — /remove', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  it('posição 1 remove a primeira música depois da atual e libera o infoFile', async () => {
    const file2 = makeInfoFile('t2');
    const file3 = makeInfoFile('t3');
    const { session } = createHarness();

    const t2 = createTrackStub({ id: 't2', infoFile: file2 });
    const t3 = createTrackStub({ id: 't3', infoFile: file3 });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(t2);
    await session.add(t3);
    await flush();

    const result = await session.removeAt(1);

    expect(result.track).toBe(t2);
    expect(result.position).toBe(1);
    expect(result.queueLength).toBe(1);
    expect(queueIds(session)).toEqual(['t3']);
    expect(session.current.id).toBe('t1');
    expect(t2.infoFile).toBeNull();
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file3)).toBe(true);
  });

  it('posição inexistente responde INVALID_POSITION sem alterar a fila', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();

    const error = await session.removeAt(9).catch((caught) => caught);

    expect(error.code).toBe('INVALID_POSITION');
    expect(error.userMessage).toContain('a fila tem 2 música(s)');
    expect(queueIds(session)).toEqual(['t2', 't3']);
  });

  it('posição 0 ou negativa não atinge a música atual', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();

    const zero = await session.removeAt(0).catch((caught) => caught);
    const negative = await session.removeAt(-1).catch((caught) => caught);

    expect(zero.code).toBe('INVALID_POSITION');
    expect(zero.userMessage).toContain('use /skip');
    expect(negative.code).toBe('INVALID_POSITION');
    expect(session.current.id).toBe('t1');
    expect(queueIds(session)).toEqual(['t2']);
  });

  it('sem próximas músicas responde NO_NEXT_TRACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();

    const error = await session.removeAt(1).catch((caught) => caught);

    expect(error.code).toBe('NO_NEXT_TRACK');
    expect(session.current.id).toBe('t1');
  });

  it('remove sucessivas mantêm a atual e a reprodução', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();

    await session.removeAt(1);
    await session.removeAt(1);

    expect(session.current.id).toBe('t1');
    expect(queueIds(session)).toEqual([]);
    expect(player.playCalls).toHaveLength(1);
    expect(session.state).toBe('playing');
  });

  it('emite onQueueChange ao remover', async () => {
    const onQueueChange = vi.fn();
    const { session } = createHarness({ hooks: { onQueueChange } });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    onQueueChange.mockClear();

    await session.removeAt(1);

    expect(onQueueChange).toHaveBeenCalledTimes(1);
  });
});

describe('Stage 9 — /clear', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  it('remove todas as próximas, mantém a atual e libera os infoFiles', async () => {
    const file2 = makeInfoFile('t2');
    const file3 = makeInfoFile('t3');
    const { session, player } = createHarness();

    const t2 = createTrackStub({ id: 't2', infoFile: file2 });
    const t3 = createTrackStub({ id: 't3', infoFile: file3 });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(t2);
    await session.add(t3);
    await flush();

    const result = await session.clearUpcoming();

    expect(result.removed).toBe(2);
    expect(result.queueLength).toBe(0);
    expect(queueIds(session)).toEqual([]);
    expect(session.current.id).toBe('t1');
    expect(session.state).toBe('playing');
    expect(player.playCalls).toHaveLength(1);
    expect(t2.infoFile).toBeNull();
    expect(t3.infoFile).toBeNull();
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file3)).toBe(false);
  });

  it('sem próximas músicas responde NO_NEXT_TRACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();

    const error = await session.clearUpcoming().catch((caught) => caught);

    expect(error.code).toBe('NO_NEXT_TRACK');
    expect(session.current.id).toBe('t1');
    expect(queueIds(session)).toEqual([]);
  });

  it('emite onQueueChange ao limpar', async () => {
    const onQueueChange = vi.fn();
    const { session } = createHarness({ hooks: { onQueueChange } });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();
    onQueueChange.mockClear();

    await session.clearUpcoming();

    expect(onQueueChange).toHaveBeenCalledTimes(1);
  });
});

describe('Stage 9 — /move', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  async function setupFour() {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    for (const id of ['t2', 't3', 't4', 't5']) {
      await session.add(createTrackStub({ id }));
    }
    await flush();

    return session;
  }

  it('move 4 para 1 leva a quarta música para a primeira posição', async () => {
    const session = await setupFour();

    const result = await session.moveTrack(4, 1);

    expect(result.from).toBe(4);
    expect(result.to).toBe(1);
    expect(result.track.id).toBe('t5');
    expect(queueIds(session)).toEqual(['t5', 't2', 't3', 't4']);
    expect(session.current.id).toBe('t1');
  });

  it('move 1 para 4 leva a primeira música para o final', async () => {
    const session = await setupFour();

    const result = await session.moveTrack(1, 4);

    expect(result.from).toBe(1);
    expect(result.to).toBe(4);
    expect(result.track.id).toBe('t2');
    expect(queueIds(session)).toEqual(['t3', 't4', 't5', 't2']);
  });

  it('mover para a mesma posição preserva a ordem', async () => {
    const session = await setupFour();

    await session.moveTrack(2, 2);

    expect(queueIds(session)).toEqual(['t2', 't3', 't4', 't5']);
  });

  it('posições inválidas respondem INVALID_POSITION', async () => {
    const session = await setupFour();

    const low = await session.moveTrack(0, 1).catch((caught) => caught);
    const high = await session.moveTrack(1, 9).catch((caught) => caught);

    expect(low.code).toBe('INVALID_POSITION');
    expect(high.code).toBe('INVALID_POSITION');
    expect(queueIds(session)).toEqual(['t2', 't3', 't4', 't5']);
  });

  it('sem próximas músicas responde NO_NEXT_TRACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await flush();

    const error = await session.moveTrack(1, 2).catch((caught) => caught);

    expect(error.code).toBe('NO_NEXT_TRACK');
  });

  it('move apenas reorganiza: nenhum infoFile é liberado', async () => {
    const file2 = makeInfoFile('t2');
    const file5 = makeInfoFile('t5');
    const { session } = createHarness();

    const t2 = createTrackStub({ id: 't2', infoFile: file2 });
    const t5 = createTrackStub({ id: 't5', infoFile: file5 });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(t2);
    await session.add(createTrackStub({ id: 't3' }));
    await session.add(createTrackStub({ id: 't4' }));
    await session.add(t5);
    await flush();

    await session.moveTrack(4, 1);

    expect(queueIds(session)).toEqual(['t5', 't2', 't3', 't4']);
    expect(t2.infoFile).toBe(file2);
    expect(t5.infoFile).toBe(file5);
    expect(fs.existsSync(file2)).toBe(true);
    expect(fs.existsSync(file5)).toBe(true);

    await session.destroy();
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file5)).toBe(false);
  });

  it('emite onQueueChange ao mover', async () => {
    const onQueueChange = vi.fn();
    const { session } = createHarness({ hooks: { onQueueChange } });

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();
    onQueueChange.mockClear();

    await session.moveTrack(1, 2);

    expect(onQueueChange).toHaveBeenCalledTimes(1);
    expect(queueIds(session)).toEqual(['t3', 't2']);
  });
});

describe('Stage 9 — concorrência das mutações de fila', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  it('remove e clear disparados junto com o avanço ficam serializados', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await session.add(createTrackStub({ id: 't4' }));
    await flush();

    player.emitIdle();

    const [removed, cleared] = await Promise.all([
      session.removeAt(1),
      session.clearUpcoming(),
    ]);

    await flush();

    expect(removed.track.id).toBe('t3');
    expect(cleared.removed).toBe(1);
    expect(queueIds(session)).toEqual([]);
    expect(session.current.id).toBe('t2');
    expect(session.state).toBe('playing');
  });

  it('adicionar músicas durante o shuffle não quebra a fila', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await session.add(createTrackStub({ id: 't3' }));
    await flush();

    const [shuffled, added] = await Promise.all([
      session.shuffle(),
      session.add(createTrackStub({ id: 't4' })),
    ]);

    expect(shuffled.shuffled).toBeGreaterThanOrEqual(2);
    expect(added.started).toBe(false);
    expect(session.queue).toHaveLength(3);
    expect(queueIds(session).sort()).toEqual(['t2', 't3', 't4']);
    expect(session.current.id).toBe('t1');
  });

  it('operação após stop responde NO_PLAYBACK', async () => {
    const { session } = createHarness();

    await session.add(createTrackStub({ id: 't1' }));
    await session.add(createTrackStub({ id: 't2' }));
    await flush();

    await session.stop();

    const results = await Promise.all([
      session.shuffle().catch((caught) => caught),
      session.clearUpcoming().catch((caught) => caught),
      session.moveTrack(1, 2).catch((caught) => caught),
      session.removeAt(1).catch((caught) => caught),
    ]);

    expect(results.map((result) => result.code)).toEqual([
      'NO_PLAYBACK',
      'NO_PLAYBACK',
      'NO_PLAYBACK',
      'NO_PLAYBACK',
    ]);
  });
});
