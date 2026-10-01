import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHarness } from './helpers/harness.js';
import { createTrackStub, settle } from './helpers/fakes.js';

describe('progresso de reprodução', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acumula a partir do playbackDuration do player', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ duration: 180 }));
    await settle();

    player.advancePlayback(45000);

    expect(session.getProgress()).toEqual({ positionSeconds: 45, durationSeconds: 180, percent: 25 });
  });

  it('pausa preserva o progresso e a retomada continua de onde parou', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ duration: 180 }));
    await settle();
    player.startPlaying();
    player.advancePlayback(45000);

    await session.pause();
    expect(session.getProgress().positionSeconds).toBe(45);

    await session.resume();
    expect(session.getProgress().positionSeconds).toBe(45);

    player.advancePlayback(15000);
    expect(session.getProgress()).toEqual({ positionSeconds: 60, durationSeconds: 180, percent: 33 });
  });

  it('limita o progresso à duração da faixa', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ duration: 180 }));
    await settle();

    player.advancePlayback(9999999);

    expect(session.getProgress()).toEqual({ positionSeconds: 180, durationSeconds: 180, percent: 100 });
  });

  it('zera ao iniciar a próxima faixa', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ id: 't1', duration: 180 }));
    await settle();
    player.advancePlayback(60000);

    await session.add(createTrackStub({ id: 't2', duration: 120 }));
    await session.skip();
    await settle();

    expect(session.current.id).toBe('t2');
    expect(session.getProgress()).toEqual({ positionSeconds: 0, durationSeconds: 120, percent: 0 });
  });

  it('sem faixa atual devolve zeros', () => {
    const { session } = createHarness();

    expect(session.getProgress()).toEqual({ positionSeconds: 0, durationSeconds: null, percent: null });
  });

  it('duração desconhecida mantém a posição sem percentual', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ duration: null }));
    await settle();

    player.advancePlayback(30000);

    expect(session.getProgress()).toEqual({ positionSeconds: 30, durationSeconds: null, percent: null });
  });

  it('snapshot expõe o progresso junto do estado da sessão', async () => {
    const { session, player } = createHarness();

    await session.add(createTrackStub({ duration: 200 }));
    await settle();

    player.advancePlayback(50000);

    const snapshot = session.snapshot();

    expect(snapshot.progress).toEqual({ positionSeconds: 50, durationSeconds: 200, percent: 25 });
    expect(snapshot.state).toBe('playing');
    expect(snapshot.current.id).toBe('track-1');
  });
});
