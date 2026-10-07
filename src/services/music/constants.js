const LOOP_MODES = Object.freeze(['off', 'track', 'queue']);

const MUSIC_CONFIG = Object.freeze({
  MAX_QUEUE_SIZE: 50,
  MAX_QUEUE_PREVIEW: 10,
  LOOP_MODES,
  LOOP_MIN_PLAYBACK_MS: 1000,
  LOOP_MAX_INSTANT_ENDS: 3,
  RESOLVE_TIMEOUT_MS: 20000,
  STREAM_SPAWN_TIMEOUT_MS: 20000,
  CONNECTION_READY_TIMEOUT_MS: 20000,
  DISCONNECT_GRACE_MS: 5000,
  RECONNECT_MAX_ATTEMPTS: 3,
  RECONNECT_BACKOFF_MS: Object.freeze([1000, 3000, 5000]),
  EMPTY_CHANNEL_GRACE_MS: 60000,
  METADATA_MAX_BYTES: 16 * 1024 * 1024,
  RESOLVE_CACHE_TTL_MS: 5 * 60 * 1000,
  RESOLVE_CACHE_MAX_ENTRIES: 50,
  SEARCH_PREFIX: 'ytsearch1:',
  YT_DLP_AUDIO_FORMAT: 'bestaudio[ext=webm][acodec=opus]/bestaudio',
  YOUTUBE_HOSTS: Object.freeze([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
  ]),
  PLAYLIST_URL_HINTS: Object.freeze(['/playlist', '/videos', '/streams']),
});

module.exports = { MUSIC_CONFIG };
