import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import play from '../src/commands/play.js';
import { settle } from './helpers/fakes.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const source = nodeRequire('../src/services/music/source/index.js');
const { createMetadataCache, metadataCache } = nodeRequire('../src/services/music/source/cache.js');
const ytdlp = nodeRequire('../src/services/music/source/ytdlp.js');
const timing = nodeRequire('../src/services/music/timing.js');
const music = nodeRequire('../src/services/music/index.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');
const { MUSIC_CONFIG } = nodeRequire('../src/services/music/constants.js');

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

function trackFile(track) {
  if (track && track.infoFile) createdFiles.push(track.infoFile);
  return track;
}

async function resolveTracked(query, options) {
  return trackFile(await source.resolveQuery(query, options));
}

function cleanupFiles() {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function timingLines(logSpy) {
  return logSpy.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('[timing]'));
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

describe('metadataCache — unidade (TTL, limite, LRU e in-flight)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    metadataCache.clear();
  });

  it('expira a entrada após o TTL e não renova o prazo nos hits', () => {
    vi.useFakeTimers();
    const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });

    cache.set('k', 'v');
    vi.advanceTimersByTime(900);

    expect(cache.get('k')).toBe('v');

    vi.advanceTimersByTime(200);

    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('respeita o limite máximo de entradas evicionando a mais antiga', () => {
    const cache = createMetadataCache({ ttlMs: 60000, maxEntries: 2 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('mantém a ordem LRU: a entrada mais recentemente lida sai por último', () => {
    const cache = createMetadataCache({ ttlMs: 60000, maxEntries: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);

    cache.set('d', 4);

    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('usa a configuração compartilhada: TTL de 5 minutos e 50 entradas', () => {
    expect(metadataCache.ttlMs).toBe(5 * 60 * 1000);
    expect(metadataCache.maxEntries).toBe(50);
    expect(metadataCache.ttlMs).toBe(MUSIC_CONFIG.RESOLVE_CACHE_TTL_MS);
    expect(metadataCache.maxEntries).toBe(MUSIC_CONFIG.RESOLVE_CACHE_MAX_ENTRIES);
  });

  it('mantém o estado de in-flight separado das entradas prontas', () => {
    const cache = createMetadataCache({ ttlMs: 60000, maxEntries: 10 });
    const pending = Promise.resolve('x');

    cache.setInflight('k', pending);

    expect(cache.getInflight('k')).toBe(pending);
    expect(cache.inflightSize).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.get('k')).toBeUndefined();

    cache.deleteInflight('k');

    expect(cache.getInflight('k')).toBeUndefined();
    expect(cache.inflightSize).toBe(0);
    expect(cache.clear()).toBeUndefined();
  });
});

describe('resolveQuery — cache de metadata', () => {
  let logSpy;

  beforeEach(() => {
    metadataCache.clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ytdlp, 'fetchMetadata').mockResolvedValue(sampleEntry());
  });

  afterEach(() => {
    metadataCache.clear();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanupFiles();
  });

  it('miss na primeira chamada busca metadados e reporta cache=miss', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    const track = await resolveTracked('lo-fi beats', { guildId: 'g1', requestedBy: 'tester#0001' });
    timing.finish('g1');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(ytdlp.fetchMetadata).toHaveBeenCalledWith('ytsearch1:lo-fi beats');
    expect(metadataCache.size).toBe(1);
    expect(track.title).toBe('Faixa de teste');

    const lines = timingLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cache=miss');
  });

  it('hit na segunda chamada usa a cache e reporta cache=hit', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    timing.begin('g1');
    const first = await resolveTracked('lo-fi beats', { guildId: 'g1' });
    timing.finish('g1');

    timing.begin('g1');
    const second = await resolveTracked('lo-fi beats', { guildId: 'g1' });
    timing.finish('g1');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(metadataCache.size).toBe(1);
    expect(second).not.toBe(first);
    expect(second.title).toBe(first.title);

    const lines = timingLines(logSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cache=miss');
    expect(lines[1]).toContain('cache=hit');
  });

  it('hit reduz o tempo de resolve quando o fetch é lento', async () => {
    ytdlp.fetchMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(sampleEntry()), 400);
        })
    );

    const missStart = Date.now();
    await resolveTracked('busca lenta');
    const missMs = Date.now() - missStart;

    const hitStart = Date.now();
    await resolveTracked('busca lenta');
    const hitMs = Date.now() - hitStart;

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(missMs).toBeGreaterThanOrEqual(350);
    expect(hitMs).toBeLessThan(350);
    expect(hitMs).toBeLessThan(missMs);
  });

  it('URLs do mesmo vídeo em formatos distintos compartilham a chave', async () => {
    await resolveTracked('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    await resolveTracked('https://youtu.be/dQw4w9WgXcQ');
    await resolveTracked('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
    await resolveTracked('https://www.youtube.com/shorts/dQw4w9WgXcQ');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(metadataCache.size).toBe(1);
    expect(metadataCache.get('v:dQw4w9WgXcQ')).toBeTruthy();
  });

  it('normaliza a chave de busca (caixa, espaços e zero-width)', async () => {
    expect(source.normalizeSearchKey('  Lo-Fi   Beats  ')).toBe('lo-fi beats');
    expect(source.normalizeSearchKey('ytsearch1:lo-fi beats')).toBe('ytsearch1:lo-fi beats');
    expect(source.buildCacheKey('search', 'ytsearch1:LO-FI beats')).toBe('s:ytsearch1:lo-fi beats');
    expect(source.buildCacheKey('search', 'ytsearch1:lo\u200B-fi beats')).toBe('s:ytsearch1:lo-fi beats');
    expect(
      source.buildCacheKey('search', source.classifyQuery('  Lo-Fi   Beats  ').target)
    ).toBe(source.buildCacheKey('search', source.classifyQuery('lo-fi beats').target));
    expect(source.buildCacheKey('url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('v:dQw4w9WgXcQ');
    expect(source.buildCacheKey('url', 'https://example.com/video')).toBeNull();

    await resolveTracked('  Lo-Fi   Beats  ');
    await resolveTracked('lo-fi beats');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(metadataCache.size).toBe(1);
  });

  it('expira após o TTL e volta a buscar metadados', async () => {
    vi.useFakeTimers();

    const first = await resolveTracked('busca ttl');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MUSIC_CONFIG.RESOLVE_CACHE_TTL_MS + 1000);

    const second = await resolveTracked('busca ttl');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(second.infoFile).not.toBe(first.infoFile);
    expect(metadataCache.size).toBe(1);
  });

  it('eviciona a entrada mais antiga quando o limite é atingido', async () => {
    const max = MUSIC_CONFIG.RESOLVE_CACHE_MAX_ENTRIES;

    for (let i = 0; i <= max; i += 1) {
      await resolveTracked(`busca ${i}`);
    }

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(max + 1);
    expect(metadataCache.size).toBe(max);
    expect(metadataCache.get(source.buildCacheKey('search', 'ytsearch1:busca 0'))).toBeUndefined();
    expect(metadataCache.get(source.buildCacheKey('search', `ytsearch1:busca ${max}`))).toBeTruthy();
  });

  it('vídeo ao vivo nunca entra na cache', async () => {
    ytdlp.fetchMetadata.mockResolvedValue(sampleEntry({ is_live: true, live_status: 'is_live' }));

    await expect(resolveTracked('https://www.youtube.com/watch?v=abc123')).rejects.toMatchObject({
      code: 'LIVE_NOT_SUPPORTED',
    });
    await expect(resolveTracked('https://www.youtube.com/watch?v=abc123')).rejects.toMatchObject({
      code: 'LIVE_NOT_SUPPORTED',
    });

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(metadataCache.size).toBe(0);
    expect(metadataCache.inflightSize).toBe(0);
  });

  it('vídeo ainda não publicado nunca entra na cache', async () => {
    ytdlp.fetchMetadata.mockResolvedValue(sampleEntry({ live_status: 'is_upcoming' }));

    await expect(resolveTracked('https://www.youtube.com/watch?v=abc123')).rejects.toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
    });
    await expect(resolveTracked('https://www.youtube.com/watch?v=abc123')).rejects.toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
    });

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(metadataCache.size).toBe(0);
  });

  it('erro de rede não entra na cache', async () => {
    ytdlp.fetchMetadata.mockRejectedValueOnce(createMusicError('NETWORK_ERROR'));

    await expect(resolveTracked('busca que falha')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(metadataCache.size).toBe(0);
    expect(metadataCache.inflightSize).toBe(0);

    await resolveTracked('busca que falha');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(metadataCache.size).toBe(1);
  });

  it('playlist e canal são rejeitados antes do fetch e fora da cache', async () => {
    await expect(resolveTracked('https://www.youtube.com/playlist?list=PL123')).rejects.toMatchObject({
      code: 'PLAYLIST_NOT_SUPPORTED',
    });
    await expect(resolveTracked('https://www.youtube.com/@canal')).rejects.toMatchObject({
      code: 'CHANNEL_NOT_SUPPORTED',
    });

    expect(ytdlp.fetchMetadata).not.toHaveBeenCalled();
    expect(metadataCache.size).toBe(0);
  });

  it('cada hit entrega um Track novo e independente', async () => {
    const first = await resolveTracked('busca independente', { requestedBy: 'tester#0001' });
    const second = await resolveTracked('busca independente', { requestedBy: 'outro#0002' });

    expect(second).not.toBe(first);
    expect(second.id).toBe(first.id);
    expect(first.requestedBy).toBe('tester#0001');
    expect(second.requestedBy).toBe('outro#0002');

    first.title = 'mutado';

    expect(second.title).toBe('Faixa de teste');
  });

  it('cada hit gera um infoFile novo, independente e válido', async () => {
    const first = await resolveTracked('busca infofile');
    const second = await resolveTracked('busca infofile');

    expect(typeof first.infoFile).toBe('string');
    expect(typeof second.infoFile).toBe('string');
    expect(second.infoFile).not.toBe(first.infoFile);
    expect(fs.existsSync(first.infoFile)).toBe(true);
    expect(fs.existsSync(second.infoFile)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(second.infoFile, 'utf8'));
    expect(parsed.id).toBe('abc123');
    expect(parsed.formats).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(second))).not.toHaveProperty('infoFile');
  });

  it('o cleanup de um track não derruba o infoFile do outro', async () => {
    const first = await resolveTracked('busca cleanup');
    const second = await resolveTracked('busca cleanup');

    const firstFile = first.infoFile;
    const secondFile = second.infoFile;

    await source.releaseTrackInfo(first);

    expect(first.infoFile).toBeNull();
    expect(fs.existsSync(firstFile)).toBe(false);
    expect(fs.existsSync(secondFile)).toBe(true);

    await source.releaseTrackInfo(second);

    expect(second.infoFile).toBeNull();
    expect(fs.existsSync(secondFile)).toBe(false);
  });

  it('duas requisições simultâneas compartilham um único fetch', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    let release;
    ytdlp.fetchMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(sampleEntry());
        })
    );

    timing.begin('g1');
    timing.begin('g2');

    const first = source.resolveQuery('busca paralela', { guildId: 'g1', requestedBy: 'tester#0001' });
    const second = source.resolveQuery('busca paralela', { guildId: 'g2', requestedBy: 'outro#0002' });

    await settle();

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(metadataCache.inflightSize).toBe(1);

    release();

    const [a, b] = await Promise.all([first, second]);
    trackFile(a);
    trackFile(b);
    timing.finish('g1');
    timing.finish('g2');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(metadataCache.inflightSize).toBe(0);
    expect(metadataCache.size).toBe(1);
    expect(a).not.toBe(b);
    expect(a.infoFile).not.toBe(b.infoFile);
    expect(a.requestedBy).toBe('tester#0001');
    expect(b.requestedBy).toBe('outro#0002');

    const lines = timingLines(logSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('guild=g1');
    expect(lines[0]).toContain('cache=miss');
    expect(lines[1]).toContain('guild=g2');
    expect(lines[1]).toContain('cache=inflight');
  });

  it('falha durante o in-flight não deixa entrada nem Promise presa', async () => {
    let reject;
    ytdlp.fetchMetadata.mockImplementation(
      () =>
        new Promise((resolvePromise, rejectPromise) => {
          reject = rejectPromise;
          void resolvePromise;
        })
    );

    const first = source.resolveQuery('busca falha', { guildId: 'g1' });
    const second = source.resolveQuery('busca falha', { guildId: 'g1' });

    await settle();

    expect(metadataCache.inflightSize).toBe(1);

    reject(createMusicError('NETWORK_ERROR'));

    await expect(first).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(second).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(metadataCache.inflightSize).toBe(0);
    expect(metadataCache.size).toBe(0);

    ytdlp.fetchMetadata.mockResolvedValue(sampleEntry());

    await resolveTracked('busca falha');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(metadataCache.size).toBe(1);
  });

  it('funciona com MUSIC_DEBUG_TIMING desligado sem escrever linha de timing', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'false');

    const first = await resolveTracked('busca sem debug');
    const second = await resolveTracked('busca sem debug');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(timingLines(logSpy)).toEqual([]);
  });
});

describe('/play — comando com cache de metadata', () => {
  let logSpy;
  const addedTracks = [];

  beforeEach(() => {
    metadataCache.clear();
    addedTracks.length = 0;

    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ytdlp, 'fetchMetadata').mockResolvedValue(sampleEntry());
    vi.spyOn(music, 'getSession').mockImplementation(() => null);
    vi.spyOn(music, 'join').mockImplementation(async () => {});
    vi.spyOn(music, 'add').mockImplementation(async (guildId, track) => {
      addedTracks.push(track);
      return { started: true, position: 1, queueLength: 1 };
    });
  });

  afterEach(() => {
    metadataCache.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanupFiles();
  });

  it('dois /play seguidos usam miss + hit mantendo o fluxo da Fase 1', async () => {
    const first = createInteraction();
    await play.execute(first);
    timing.finish('g1');

    const second = createInteraction();
    await play.execute(second);
    timing.finish('g1');

    expect(ytdlp.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(music.join).toHaveBeenCalledTimes(2);
    expect(music.add).toHaveBeenCalledTimes(2);

    expect(first.deferReply).toHaveBeenCalledTimes(1);
    expect(first.editReply).toHaveBeenNthCalledWith(1, { content: '🔍 Buscando música no YouTube…' });
    expect(second.deferReply).toHaveBeenCalledTimes(1);
    expect(second.editReply).toHaveBeenNthCalledWith(1, { content: '🔍 Buscando música no YouTube…' });

    for (const interaction of [first, second]) {
      const last = interaction.editReply.mock.calls.at(-1)[0];
      const embed = last.embeds[0].toJSON();

      expect(last.content).toBe('');
      expect(embed.title).toBe('Faixa de teste');
      expect(embed.url).toBe('https://www.youtube.com/watch?v=abc123');
    }

    addedTracks.forEach((track) => trackFile(track));

    expect(addedTracks).toHaveLength(2);
    expect(addedTracks[0]).not.toBe(addedTracks[1]);
    expect(addedTracks[0].infoFile).not.toBe(addedTracks[1].infoFile);

    const lines = timingLines(logSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('guild=g1');
    expect(lines[0]).toContain('cache=miss');
    expect(lines[1]).toContain('cache=hit');
    expect(lines[0]).toMatch(/ack=\d+ms/);
    expect(lines[0]).toMatch(/status=\d+ms/);
    expect(lines[0]).toMatch(/resolve=\d+ms/);
    expect(lines[1]).toMatch(/resolve=\d+ms/);
    expect(lines[0]).toMatch(/total=\d+ms/);
    expect(lines[1]).toMatch(/total=\d+ms/);
  });
});
