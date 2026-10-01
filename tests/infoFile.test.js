import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHarness } from './helpers/harness.js';
import { createTrackStub, settle } from './helpers/fakes.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const source = nodeRequire('../src/services/music/source/index.js');
const ytdlp = nodeRequire('../src/services/music/source/ytdlp.js');
const streamService = nodeRequire('../src/services/music/stream.js');
const music = nodeRequire('../src/services/music/index.js');
const play = nodeRequire('../src/commands/play.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');
const { MUSIC_CONFIG } = nodeRequire('../src/services/music/constants.js');
const cp = nodeRequire('node:child_process');

const createdFiles = [];

function sampleEntry(overrides = {}) {
  return {
    id: 'abc123',
    title: 'Faixa de teste',
    webpage_url: 'https://www.youtube.com/watch?v=abc123',
    duration: 210,
    is_live: false,
    live_status: 'not_live',
    formats: [{ format_id: '251', ext: 'webm', acodec: 'opus', url: 'https://rr0---sn-x.googlevideo.com/videoplayback?x=1' }],
    ...overrides,
  };
}

function makeInfoFile(entry = sampleEntry()) {
  const file = ytdlp.createInfoFile(entry);
  createdFiles.push(file);
  return file;
}

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

function makeAudioStream() {
  const readable = new PassThrough();
  readable.write(Buffer.alloc(1500, 0));
  return readable;
}

function makeHandle() {
  const kill = vi.fn();
  return { child: { kill }, stream: makeAudioStream(), getStderr: () => '', kill };
}

function createInteraction() {
  const interaction = {
    deferred: false,
    replied: false,
    inGuild: () => true,
    guildId: 'g1',
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    options: { getString: () => 'música qualquer' },
    member: {
      voice: {
        channel: {
          id: 'vc1',
          type: 2,
          permissionsFor: () => ({ has: () => true }),
        },
      },
    },
    guild: {
      voiceAdapterCreator: () => ({ send: () => {}, destroy: () => {} }),
      members: { me: { id: 'bot-1' } },
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };

  return interaction;
}

describe('infoFile — resolveQuery', () => {
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

  it('cria infoFile com o entry após os guards e anexa ao track sem vazar no toJSON', async () => {
    vi.spyOn(ytdlp, 'fetchMetadata').mockResolvedValue(sampleEntry());

    const track = await source.resolveQuery('https://www.youtube.com/watch?v=abc123', {
      requestedBy: 'tester#0001',
    });

    expect(typeof track.infoFile).toBe('string');
    createdFiles.push(track.infoFile);
    expect(fs.existsSync(track.infoFile)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(track.infoFile, 'utf8'));
    expect(parsed.id).toBe('abc123');
    expect(parsed.formats).toHaveLength(1);

    expect(JSON.parse(JSON.stringify(track))).not.toHaveProperty('infoFile');

    const file = track.infoFile;
    await source.releaseTrackInfo(track);

    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('falha de guard de live rejeita sem criar infoFile', async () => {
    vi.spyOn(ytdlp, 'fetchMetadata').mockResolvedValue(
      sampleEntry({ is_live: true, live_status: 'is_live' })
    );
    const createSpy = vi.spyOn(ytdlp, 'createInfoFile');

    const error = await source.resolveQuery('https://www.youtube.com/watch?v=abc123').catch((e) => e);

    expect(error.code).toBe('LIVE_NOT_SUPPORTED');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('busca sem resultados não cria infoFile', async () => {
    vi.spyOn(ytdlp, 'fetchMetadata').mockResolvedValue({ _type: 'playlist', entries: [] });
    const createSpy = vi.spyOn(ytdlp, 'createInfoFile');

    const error = await source.resolveQuery('ytsearch1:xyzzyqqq').catch((e) => e);

    expect(error.code).toBe('NO_RESULTS');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('falha de rede no resolve não cria infoFile', async () => {
    vi.spyOn(ytdlp, 'fetchMetadata').mockRejectedValue(createMusicError('NETWORK_ERROR'));
    const createSpy = vi.spyOn(ytdlp, 'createInfoFile');

    const error = await source.resolveQuery('https://www.youtube.com/watch?v=abc123').catch((e) => e);

    expect(error.code).toBe('NETWORK_ERROR');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('falha de playlist/classify rejeita antes de buscar metadados', async () => {
    const fetchSpy = vi.spyOn(ytdlp, 'fetchMetadata');

    const error = await source
      .resolveQuery('https://www.youtube.com/playlist?list=PL123')
      .catch((e) => e);

    expect(error.code).toBe('PLAYLIST_NOT_SUPPORTED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('infoFile — releaseTrackInfo', () => {
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

  it('é idempotente: segunda chamada é no-op e não lança', async () => {
    const file = makeInfoFile();
    const track = { infoFile: file };

    const first = await ytdlp.releaseTrackInfo(track);
    const second = await ytdlp.releaseTrackInfo(track);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('tolera caminho inexistente (ENOENT) sem lançar', async () => {
    const track = { infoFile: path.join(os.tmpdir(), 'chicobot-info-nao-existe-xyz.json') };

    await expect(ytdlp.releaseTrackInfo(track)).resolves.toBe(true);
    expect(track.infoFile).toBeNull();
  });

  it('tolera EBUSY do Windows com retry até o unlink funcionar', async () => {
    const file = makeInfoFile();
    const track = { infoFile: file };
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    );

    await ytdlp.releaseTrackInfo(track);

    expect(unlinkSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('track sem infoFile é no-op sem tocar no filesystem', async () => {
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink');

    await expect(ytdlp.releaseTrackInfo(createTrackStub())).resolves.toBe(false);
    await expect(ytdlp.releaseTrackInfo(null)).resolves.toBe(false);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('cleanupStaleInfoFiles remove apenas arquivos antigos', () => {
    fs.mkdirSync(ytdlp.INFO_DIR, { recursive: true });

    const oldFile = path.join(ytdlp.INFO_DIR, 'chicobot-info-sweep-old.json');
    const freshFile = path.join(ytdlp.INFO_DIR, 'chicobot-info-sweep-fresh.json');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(freshFile, '{}');
    createdFiles.push(oldFile, freshFile);

    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    ytdlp.cleanupStaleInfoFiles({ olderThanMs: 60 * 1000 });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });
});

describe('infoFile — openStream com --load-info-json', () => {
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

  it('injeta --load-info-json com o arquivo e mantém o alvo por último', async () => {
    let captured = null;
    const child = makeFakeChild();
    vi.spyOn(cp, 'spawn').mockImplementation((command, args) => {
      captured = { command, args };
      process.nextTick(() => child.emit('spawn'));
      return child;
    });

    const infoFile = 'C:/tmp/chicobot-info-exemplo.json';
    const handle = await ytdlp.openStream('https://www.youtube.com/watch?v=abc123', { infoFile });

    const i = captured.args.indexOf('--load-info-json');
    expect(i).toBeGreaterThan(-1);
    expect(captured.args[i + 1]).toBe(infoFile);
    expect(captured.args.at(-1)).toBe('https://www.youtube.com/watch?v=abc123');
    expect(captured.args).toContain('--no-playlist');
    expect(handle.child).toBe(child);
  });

  it('sem infoFile os argumentos permanecem idênticos ao fluxo atual (regressão)', async () => {
    let captured = null;
    const child = makeFakeChild();
    vi.spyOn(cp, 'spawn').mockImplementation((command, args) => {
      captured = args;
      process.nextTick(() => child.emit('spawn'));
      return child;
    });

    await ytdlp.openStream('https://www.youtube.com/watch?v=abc123');
    expect(captured).toEqual([
      '--ignore-config',
      '-f',
      MUSIC_CONFIG.YT_DLP_AUDIO_FORMAT,
      '-o',
      '-',
      '--no-warnings',
      '--no-part',
      '--no-playlist',
      'https://www.youtube.com/watch?v=abc123',
    ]);

    await ytdlp.openStream('ytsearch1:never gonna give you up');
    expect(captured).not.toContain('--load-info-json');
    expect(captured).not.toContain('--no-playlist');
    expect(captured.at(-1)).toBe('ytsearch1:never gonna give you up');
  });

  it('propaga erro mapeado quando o processo falha antes de iniciar', async () => {
    vi.spyOn(cp, 'spawn').mockImplementation(() => {
      const child = makeFakeChild();
      process.nextTick(() => {
        child.stderr.write('ERROR: Video unavailable\n');
        child.emit('close', 1);
      });
      return child;
    });

    await expect(ytdlp.openStream('https://www.youtube.com/watch?v=abc123')).rejects.toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
    });
  });
});

describe('infoFile — createTrackResource e fallback único', () => {
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

  it('usa infoFile no openStream e libera o arquivo após o probe', async () => {
    const file = makeInfoFile();
    const track = createTrackStub({ infoFile: file });
    const handle = makeHandle();
    const openSpy = vi.spyOn(ytdlp, 'openStream').mockResolvedValue(handle);

    const playback = await streamService.createTrackResource(track);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][1].infoFile).toBe(file);
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(playback.resource).toBeTruthy();

    handle.kill();
    if (playback.resource.playStream && typeof playback.resource.playStream.destroy === 'function') {
      playback.resource.playStream.destroy();
    }
  });

  it('falha com infoFile dispara exatamente um fallback sem --load-info-json', async () => {
    const file = makeInfoFile();
    const track = createTrackStub({ infoFile: file });
    const goodHandle = makeHandle();
    const openSpy = vi
      .spyOn(ytdlp, 'openStream')
      .mockRejectedValueOnce(createMusicError('STREAM_UNAVAILABLE'))
      .mockResolvedValueOnce(goodHandle);

    const playback = await streamService.createTrackResource(track);

    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(openSpy.mock.calls[0][1].infoFile).toBe(file);
    expect(openSpy.mock.calls[1][1].infoFile ?? null).toBeNull();
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(playback.resource).toBeTruthy();

    goodHandle.kill();
    if (playback.resource.playStream && typeof playback.resource.playStream.destroy === 'function') {
      playback.resource.playStream.destroy();
    }
  });

  it('sem infoFile não há retry e o erro original propaga', async () => {
    const track = createTrackStub();
    const openSpy = vi.spyOn(ytdlp, 'openStream').mockRejectedValue(createMusicError('STREAM_UNAVAILABLE'));

    const error = await streamService.createTrackResource(track).catch((e) => e);

    expect(error.code).toBe('STREAM_UNAVAILABLE');
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('fallback que também falha propaga o erro da nova tentativa e libera o arquivo', async () => {
    const file = makeInfoFile();
    const track = createTrackStub({ infoFile: file });
    vi.spyOn(ytdlp, 'openStream')
      .mockRejectedValueOnce(createMusicError('STREAM_UNAVAILABLE'))
      .mockRejectedValueOnce(createMusicError('VIDEO_UNAVAILABLE'));

    const error = await streamService.createTrackResource(track).catch((e) => e);

    expect(error.code).toBe('VIDEO_UNAVAILABLE');
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('YT_DLP_NOT_FOUND não tenta de novo e ainda libera o arquivo', async () => {
    const file = makeInfoFile();
    const track = createTrackStub({ infoFile: file });
    const openSpy = vi.spyOn(ytdlp, 'openStream').mockRejectedValue(createMusicError('YT_DLP_NOT_FOUND'));

    const error = await streamService.createTrackResource(track).catch((e) => e);

    expect(error.code).toBe('YT_DLP_NOT_FOUND');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('infoFile — sessão descarta faixas sem órfãos', () => {
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

  it('destroy libera infoFile do current e de toda a fila', async () => {
    const { session } = createHarness();

    const file1 = makeInfoFile();
    const file2 = makeInfoFile();
    const file3 = makeInfoFile();
    const t1 = createTrackStub({ id: 't1', infoFile: file1 });
    const t2 = createTrackStub({ id: 't2', infoFile: file2 });
    const t3 = createTrackStub({ id: 't3', infoFile: file3 });

    await session.add(t1);
    await settle();
    await session.add(t2);
    await session.add(t3);

    expect(session.queue).toHaveLength(2);
    expect(fs.existsSync(file1)).toBe(true);

    await session.destroy();

    expect(t1.infoFile).toBeNull();
    expect(t2.infoFile).toBeNull();
    expect(t3.infoFile).toBeNull();
    expect(fs.existsSync(file1)).toBe(false);
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file3)).toBe(false);
  });

  it('faixa descartada por skip na fila é liberada', async () => {
    const { session } = createHarness();

    const file1 = makeInfoFile();
    const dropped = createTrackStub({ id: 'dropped', infoFile: file1 });
    const next = createTrackStub({ id: 'next' });

    session.current = createTrackStub({ id: 'current' });
    session.state = 'playing';
    session.queue.push(dropped, next);
    session._pendingSkips = 1;

    await session._advance('player-idle');

    expect(dropped.infoFile).toBeNull();
    expect(fs.existsSync(file1)).toBe(false);
    expect(session.current.id).toBe('next');

    await session.destroy();
  });

  it('falha na criação do resource libera o infoFile da faixa', async () => {
    const { session } = createHarness({
      createResource: async () => {
        throw createMusicError('STREAM_UNAVAILABLE');
      },
    });

    const file = makeInfoFile();
    const track = createTrackStub({ infoFile: file });

    await session.add(track);
    await settle();

    expect(track.infoFile).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(session.state).toBe('idle');
    expect(session.current).toBeNull();

    await session.destroy();
  });
});

describe('infoFile — /play transfere ownership para a sessão', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(music, 'getSession').mockImplementation(() => null);
    vi.spyOn(music, 'join').mockImplementation(async () => {});
    vi.spyOn(music, 'add').mockImplementation(async () => ({ started: true, position: 1, queueLength: 1 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  function stubResolveWithInfoFile() {
    const file = makeInfoFile();
    vi.spyOn(source, 'resolveQuery').mockImplementation(async () => ({
      id: 'track-1',
      title: 'Música de teste',
      url: 'https://www.youtube.com/watch?v=track-1',
      duration: 180,
      source: 'youtube',
      requestedBy: 'tester#0001',
      infoFile: file,
    }));
    return file;
  }

  it('join falha após resolve: infoFile é liberado e add não é chamado', async () => {
    const file = stubResolveWithInfoFile();
    music.join.mockImplementationOnce(async () => {
      throw createMusicError('CONNECTION_TIMEOUT');
    });

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(music.add).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);

    const lastReply = interaction.editReply.mock.calls.at(-1)[0];
    expect(lastReply.content).toBe(createMusicError('CONNECTION_TIMEOUT').userMessage);
  });

  it('add falha após resolve: infoFile é liberado', async () => {
    const file = stubResolveWithInfoFile();
    music.add.mockImplementationOnce(async () => {
      throw createMusicError('QUEUE_FULL');
    });

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(fs.existsSync(file)).toBe(false);

    const lastReply = interaction.editReply.mock.calls.at(-1)[0];
    expect(lastReply.content).toBe(createMusicError('QUEUE_FULL').userMessage);
  });

  it('add inicia a faixa: arquivo permanece para o stream da sessão', async () => {
    const file = stubResolveWithInfoFile();

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(music.add).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(true);

    await ytdlp.releaseTrackInfo({ infoFile: file });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('add enfileira: arquivo permanece com a faixa na fila da sessão', async () => {
    const file = stubResolveWithInfoFile();
    music.add.mockImplementationOnce(async () => ({ started: false, position: 3, queueLength: 5 }));

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(music.add).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(true);

    await ytdlp.releaseTrackInfo({ infoFile: file });
  });
});
