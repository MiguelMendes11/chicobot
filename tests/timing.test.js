import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import timing from '../src/services/music/timing.js';

describe('timing (MUSIC_DEBUG_TIMING)', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    logSpy.mockRestore();
  });

  function timingLines() {
    return logSpy.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('[timing]'));
  }

  it('não emite nada quando MUSIC_DEBUG_TIMING está ausente', () => {
    timing.begin('g1');
    timing.mark('g1', 'resolve.begin');
    vi.advanceTimersByTime(1500);
    timing.mark('g1', 'resolve.end');
    timing.finish('g1');

    expect(timingLines()).toEqual([]);
  });

  it('não emite nada quando MUSIC_DEBUG_TIMING é diferente de true', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'false');

    timing.begin('g1');
    timing.finish('g1');

    expect(timingLines()).toEqual([]);
  });

  it('emite uma única linha com os deltas quando habilitado', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    vi.advanceTimersByTime(100);
    timing.mark('g1', 'resolve.begin');
    vi.advanceTimersByTime(1500);
    timing.mark('g1', 'resolve.end');
    timing.mark('g1', 'join.begin');
    timing.mark('g1', 'ready.begin');
    vi.advanceTimersByTime(200);
    timing.mark('g1', 'ready.end');
    timing.mark('g1', 'join.end');
    vi.advanceTimersByTime(2200);
    timing.mark('g1', 'resource.begin');
    vi.advanceTimersByTime(900);
    timing.mark('g1', 'resource.end');
    timing.mark('g1', 'play.call');
    vi.advanceTimersByTime(400);
    timing.mark('g1', 'play.audio');
    vi.advanceTimersByTime(100);
    timing.finish('g1');

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('guild=g1');
    expect(emitted[0]).toContain('resolve=1500ms');
    expect(emitted[0]).toContain('join=200ms');
    expect(emitted[0]).toContain('ready=200ms');
    expect(emitted[0]).toContain('resource=900ms');
    expect(emitted[0]).toContain('play→audio=400ms');
    expect(emitted[0]).toMatch(/total=\d+ms/);
  });

  it('marca fases ausentes como n/a', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    timing.finish('g1');

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('resolve=n/a');
    expect(emitted[0]).toContain('resource=n/a');
    expect(emitted[0]).toMatch(/total=\d+ms/);
  });

  it('com pending=true, adia a emissão até play.audio', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    timing.mark('g1', 'play.call');
    timing.finish('g1', { pending: true });

    expect(timingLines()).toEqual([]);

    vi.advanceTimersByTime(500);
    timing.mark('g1', 'play.audio');

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('play→audio=500ms');
  });

  it('com pending=true, emite após o tempo limite quando o áudio nunca inicia', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    timing.finish('g1', { pending: true });

    expect(timingLines()).toEqual([]);

    vi.advanceTimersByTime(30000);

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('play→audio=n/a');
  });

  it('com pending=true, emite na hora se o áudio já começou antes do finish', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    timing.mark('g1', 'play.call');
    vi.advanceTimersByTime(300);
    timing.mark('g1', 'play.audio');
    timing.finish('g1', { pending: true });

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('play→audio=300ms');
  });

  it('emite uma vez só mesmo com finish repetido', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    timing.finish('g1');
    timing.finish('g1');

    expect(timingLines()).toHaveLength(1);
  });

  it('ignora marks sem contexto de begin', () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.mark('desconhecida', 'resolve.begin');
    timing.finish('desconhecida');

    expect(timingLines()).toEqual([]);
  });
});
