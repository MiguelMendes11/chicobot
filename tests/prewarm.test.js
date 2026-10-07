import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const cp = nodeRequire('node:child_process');
const ytdlp = nodeRequire('../src/services/music/source/ytdlp.js');
const ready = nodeRequire('../src/events/ready.js');
const presence = nodeRequire('../src/services/presence.js');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  return child;
}

describe('prewarm do yt-dlp', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    presence.reset();
  });

  it('não rejeita quando o yt-dlp não existe (ENOENT)', async () => {
    vi.spyOn(cp, 'spawn').mockImplementation(() => {
      const child = makeFakeChild();
      process.nextTick(() => {
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    });

    const result = await ytdlp.prewarmYtDlp();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('YT_DLP_NOT_FOUND');
    expect(console.warn).toHaveBeenCalled();
  });

  it('mata o processo no timeout e não deixa órfão', async () => {
    vi.useFakeTimers();

    const child = makeFakeChild();
    const spawnSpy = vi.spyOn(cp, 'spawn').mockImplementation(() => child);

    const pending = ytdlp.prewarmYtDlp();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15000);

    const result = await pending;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('YT_DLP_TIMEOUT');
  });

  it('aquece apenas com --version e sem tocar nos arquivos de informação', async () => {
    let captured = null;
    const child = makeFakeChild();
    const createInfoSpy = vi.spyOn(ytdlp, 'createInfoFile');

    vi.spyOn(cp, 'spawn').mockImplementation((command, args) => {
      captured = { command, args };
      process.nextTick(() => {
        child.stdout.write('2026.01.01\n');
        child.emit('close', 0);
      });
      return child;
    });

    const result = await ytdlp.prewarmYtDlp();

    expect(result.ok).toBe(true);
    expect(captured.args).toEqual(['--ignore-config', '--version']);
    expect(createInfoSpy).not.toHaveBeenCalled();
  });

  it('ready dispara o prewarm e inicia a presença', () => {
    const prewarmSpy = vi.spyOn(ytdlp, 'prewarmYtDlp').mockReturnValue({ ok: true });
    const setPresence = vi.fn();

    ready.execute({ user: { tag: 'ChicoBot#0001', setPresence } });

    expect(prewarmSpy).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenCalledTimes(1);
  });

  it('ready não propaga exceção do prewarm', () => {
    vi.spyOn(ytdlp, 'prewarmYtDlp').mockImplementation(() => {
      throw new Error('boom');
    });
    const setPresence = vi.fn();

    expect(() => ready.execute({ user: { tag: 'ChicoBot#0001', setPresence } })).not.toThrow();
    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  });
});
