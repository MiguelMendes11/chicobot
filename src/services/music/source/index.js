const { createMusicError } = require('../errors');
const { MUSIC_CONFIG } = require('../constants');
const Track = require('../track');
const timing = require('../timing');
const ytdlp = require('./ytdlp');
const { metadataCache } = require('./cache');

const URL_PATTERN = /^https?:\/\//i;
const VIDEO_PATH_PATTERN = /^\/(shorts|embed|live|v)\/[^/]+/i;
const CHANNEL_PATH_PATTERN = /^\/(@|channel\/|c\/|user\/)/i;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLAYLIST_PATHS = ['/playlist', '/videos', '/streams'];

function isUrl(query) {
  return URL_PATTERN.test(query);
}

function parseUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw createMusicError('UNSUPPORTED_URL', { cause: error });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createMusicError('UNSUPPORTED_URL');
  }

  return parsed;
}

function isYouTubeUrl(parsed) {
  const hostname = parsed.hostname.toLowerCase();

  return MUSIC_CONFIG.YOUTUBE_HOSTS.includes(hostname);
}

function isChannelUrl(parsed) {
  return CHANNEL_PATH_PATTERN.test(parsed.pathname);
}

function isPlaylistUrl(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const pathIsPlaylist = PLAYLIST_PATHS.some((hint) => pathname === hint || pathname.startsWith(`${hint}/`));

  if (pathIsPlaylist) return true;

  const hasVideoId = hostname.endsWith('youtu.be')
    ? pathname.length > 1
    : parsed.searchParams.has('v') || VIDEO_PATH_PATTERN.test(pathname);

  return parsed.searchParams.has('list') && !hasVideoId;
}

function classifyQuery(query) {
  const trimmed = typeof query === 'string' ? query.trim() : '';

  if (!trimmed) throw createMusicError('EMPTY_QUERY');

  if (isUrl(trimmed)) {
    const parsed = parseUrl(trimmed);

    if (!isYouTubeUrl(parsed)) throw createMusicError('UNSUPPORTED_URL');
    if (isChannelUrl(parsed)) throw createMusicError('CHANNEL_NOT_SUPPORTED');
    if (isPlaylistUrl(parsed)) throw createMusicError('PLAYLIST_NOT_SUPPORTED');

    return { kind: 'url', target: trimmed };
  }

  return { kind: 'search', target: `${MUSIC_CONFIG.SEARCH_PREFIX}${trimmed}` };
}

function normalizeSearchKey(target) {
  return String(target)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVideoId(parsed) {
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
    const candidate = parsed.pathname.split('/').filter(Boolean)[0];
    return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
  }

  const fromQuery = parsed.searchParams.get('v');
  if (fromQuery && VIDEO_ID_PATTERN.test(fromQuery)) return fromQuery;

  const match = parsed.pathname.match(VIDEO_PATH_PATTERN);
  const candidate = match ? match[0].split('/')[2] : null;

  return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

function buildCacheKey(kind, target) {
  if (kind === 'search') return `s:${normalizeSearchKey(target)}`;
  if (kind !== 'url') return null;

  try {
    const id = extractVideoId(parseUrl(target));
    return id ? `v:${id}` : null;
  } catch (error) {
    return null;
  }
}

function pickEntry(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload.entries)) {
    return payload.entries.find((entry) => entry && typeof entry === 'object') || null;
  }

  return payload;
}

function pickThumbnail(entry) {
  if (typeof entry.thumbnail === 'string' && entry.thumbnail) return entry.thumbnail;

  if (Array.isArray(entry.thumbnails)) {
    const last = entry.thumbnails.filter((item) => item && typeof item.url === 'string' && item.url).pop();
    if (last) return last.url;
  }

  return null;
}

function buildTrack(entry, requestedBy) {
  if (!entry || typeof entry !== 'object') throw createMusicError('METADATA_INVALID');

  const type = entry._type;

  if (type === 'playlist' || type === 'multi_video' || (entry.playlist_count && entry.playlist_count > 1)) {
    throw createMusicError('PLAYLIST_NOT_SUPPORTED');
  }

  if (type === 'channel') throw createMusicError('CHANNEL_NOT_SUPPORTED');

  if (entry.is_live === true || entry.live_status === 'is_live') {
    throw createMusicError('LIVE_NOT_SUPPORTED');
  }

  if (entry.live_status === 'is_upcoming') throw createMusicError('VIDEO_UNAVAILABLE', { details: 'vídeo ainda não publicado' });

  const url = entry.webpage_url || entry.original_url;

  if (!entry.id || !entry.title || !url) throw createMusicError('METADATA_INVALID');

  const duration = Number.isFinite(entry.duration) ? entry.duration : null;

  return new Track({
    id: String(entry.id),
    title: String(entry.title),
    url: String(url),
    duration,
    source: 'youtube',
    requestedBy: requestedBy || null,
    thumbnail: pickThumbnail(entry),
  });
}

function pickEntryOrThrow(payload) {
  const entry = pickEntry(payload);

  if (!entry) throw createMusicError('NO_RESULTS');

  return entry;
}

async function fetchEntry(target) {
  const payload = await ytdlp.fetchMetadata(target);
  return pickEntryOrThrow(payload);
}

async function fetchEntryShared(key, target) {
  const pending = ytdlp.fetchMetadata(target).then(pickEntryOrThrow);

  metadataCache.setInflight(key, pending);

  try {
    return await pending;
  } finally {
    metadataCache.deleteInflight(key);
  }
}

function createTrackFromEntry(entry, requestedBy, key) {
  const track = buildTrack(entry, requestedBy || null);

  if (key) metadataCache.set(key, entry);

  const infoFile = ytdlp.createInfoFile(entry);

  if (infoFile) track.infoFile = infoFile;

  return track;
}

async function resolveQuery(query, options = {}) {
  const { kind, target } = classifyQuery(query);
  const key = buildCacheKey(kind, target);
  const guildId = options.guildId || null;

  if (key) {
    const cached = metadataCache.get(key);

    if (cached) {
      timing.mark(guildId, 'cache.hit');
      return createTrackFromEntry(cached, options.requestedBy, key);
    }
  }

  const shared = key ? metadataCache.getInflight(key) : undefined;

  if (key) timing.mark(guildId, shared ? 'cache.inflight' : 'cache.miss');

  let entry;

  if (shared) {
    entry = await shared;
  } else if (key) {
    entry = await fetchEntryShared(key, target);
  } else {
    entry = await fetchEntry(target);
  }

  return createTrackFromEntry(entry, options.requestedBy, key);
}

module.exports = {
  classifyQuery,
  isUrl,
  isYouTubeUrl,
  parseUrl,
  isChannelUrl,
  isPlaylistUrl,
  buildTrack,
  buildCacheKey,
  normalizeSearchKey,
  resolveQuery,
  releaseTrackInfo: ytdlp.releaseTrackInfo,
};
