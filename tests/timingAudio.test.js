import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarness } from './helpers/harness.js';
import { createFakePlayer, createTrackStub, settle } from './helpers/fakes.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const timing = nodeRequire('../src/services/music/timing.js');

describe('timing — play→audio (transição para AudioPlayerStatus.Playing)', () => {
  let logSpy;

  beforeEach(() => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function timingLines() {
    return logSpy.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('[timing]'));
  }

  it('captura a transição síncrona para Playing feita dentro de player.play()', async () => {
    const player = createFakePlayer({ playStatus: 'playing' });
    const { session } = createHarness({ player });

    timing.begin('g1');
    await session.add(createTrackStub());
    await settle();
    timing.finish('g1', { pending: true });

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatch(/play→audio=\d+ms/);
    expect(emitted[0]).not.toContain('play→audio=n/a');
    expect(emitted[0]).toMatch(/total→audio=\d+ms/);
    expect(emitted[0]).not.toContain('total→audio=n/a');
    expect(emitted[0]).toMatch(/resource=\d+ms/);
    expect(emitted[0]).toContain('fallback=n/a');
  });

  it('captura a transição assíncrona para Playing depois de player.play()', async () => {
    const player = createFakePlayer();
    const originalPlay = player.play;

    player.play = (resource) => {
      originalPlay(resource);
      setTimeout(() => player.setState('playing'), 5);
      return player;
    };

    const { session } = createHarness({ player });

    timing.begin('g1');
    await session.add(createTrackStub());
    await settle();
    timing.finish('g1', { pending: true });

    expect(timingLines()).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatch(/play→audio=\d+ms/);
    expect(emitted[0]).not.toContain('play→audio=n/a');
  });

  it('desarma o probe quando player.play lança exceção', async () => {
    const player = createFakePlayer();
    player.play = () => {
      throw new Error('boom');
    };

    const { session } = createHarness({ player });

    timing.begin('g1');
    await session.add(createTrackStub());
    await settle();
    timing.finish('g1');

    expect(player.listenerCount('stateChange')).toBe(0);

    const emitted = timingLines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('play→audio=n/a');
  });

  it('não anexa o probe quando MUSIC_DEBUG_TIMING está ausente', async () => {
    vi.unstubAllEnvs();

    const player = createFakePlayer();
    const { session } = createHarness({ player });

    await session.add(createTrackStub());
    await settle();

    expect(player.listenerCount('stateChange')).toBe(0);
    expect(timingLines()).toEqual([]);
  });

  it('libera o probe quando a sessão é destruída', async () => {
    const player = createFakePlayer();
    const { session } = createHarness({ player });

    timing.begin('g1');
    await session.add(createTrackStub());
    await settle();

    expect(player.listenerCount('stateChange')).toBe(1);

    await session.destroy();

    expect(player.listenerCount('stateChange')).toBe(0);
    timing.finish('g1');
  });
});
