const MUSIC_CONFIG = Object.freeze({
  MAX_QUEUE_SIZE: 50,
  MAX_QUEUE_PREVIEW: 10,
  RESOLVE_TIMEOUT_MS: 20000,
  STREAM_SPAWN_TIMEOUT_MS: 20000,
  METADATA_MAX_BYTES: 16 * 1024 * 1024,
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
