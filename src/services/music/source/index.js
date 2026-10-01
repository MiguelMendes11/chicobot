const { createMusicError } = require('../errors');
const { MUSIC_CONFIG } = require('../constants');
const Track = require('../track');
const ytdlp = require('./ytdlp');

const URL_PATTERN = /^https?:\/\//i;
const VIDEO_PATH_PATTERN = /^\/(shorts|embed|live|v)\/[^/]+/i;
const CHANNEL_PATH_PATTERN = /^\/(@|channel\/|c\/|user\/)/i;
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

function pickEntry(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload.entries)) {
    return payload.entries.find((entry) => entry && typeof entry === 'object') || null;
  }

  return payload;
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
  });
}

async function resolveQuery(query, options = {}) {
  const { target } = classifyQuery(query);
  const payload = await ytdlp.fetchMetadata(target);
  const entry = pickEntry(payload);

  if (!entry) throw createMusicError('NO_RESULTS');

  const track = buildTrack(entry, options.requestedBy || null);
  const infoFile = ytdlp.createInfoFile(entry);

  if (infoFile) track.infoFile = infoFile;

  return track;
}

module.exports = {
  classifyQuery,
  isUrl,
  isYouTubeUrl,
  parseUrl,
  isChannelUrl,
  isPlaylistUrl,
  buildTrack,
  resolveQuery,
  releaseTrackInfo: ytdlp.releaseTrackInfo,
};
