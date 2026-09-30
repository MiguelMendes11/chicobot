class MusicError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.name = 'MusicError';
    this.code = code;
    this.userMessage = userMessage;
    this.expected = true;
  }
}

const MUSIC_ERROR_MESSAGES = Object.freeze({
  NOT_IN_GUILD: 'Este comando só pode ser usado dentro de um servidor.',
  NOT_IN_VOICE: 'Você precisa estar conectado a um canal de voz.',
  STAGE_CHANNEL: 'Canais de palco ainda não são suportados. Entre em um canal de voz comum.',
  WRONG_VOICE_CHANNEL: 'Você precisa estar no mesmo canal de voz que o bot.',
  BOT_NOT_IN_VOICE: 'O bot não está conectado a nenhum canal de voz.',
  BOT_NO_CONNECT: 'O bot não tem permissão para entrar neste canal de voz (Conectar).',
  BOT_NO_SPEAK: 'O bot não tem permissão para falar neste canal de voz (Falar).',
  NO_PLAYBACK: 'Nada está tocando neste servidor.',
  ALREADY_PAUSED: 'A música já está pausada.',
  NOT_PAUSED: 'Nenhuma música está pausada.',
  NO_CURRENT_TRACK: 'Não há nenhuma música tocando no momento.',
  NO_NEXT_TRACK: 'A fila está vazia; não existe próxima música.',
  QUEUE_FULL: 'A fila deste servidor atingiu o limite máximo.',
  EMPTY_QUERY: 'Informe uma busca ou um link do YouTube.',
  UNSUPPORTED_URL: 'Esta fase aceita apenas links do YouTube.',
  PLAYLIST_NOT_SUPPORTED: 'Playlists não são suportadas nesta fase. Envie o link de um vídeo específico.',
  CHANNEL_NOT_SUPPORTED: 'Links de canais não são suportados. Envie o link de um vídeo específico.',
  LIVE_NOT_SUPPORTED: 'Transmissões ao vivo não são suportadas nesta fase.',
  VIDEO_UNAVAILABLE: 'O vídeo não está disponível (removido, privado ou restrito).',
  NO_RESULTS: 'Nenhum resultado encontrado para essa busca.',
  NETWORK_ERROR: 'Não foi possível acessar o YouTube. Verifique a conexão do servidor.',
  YT_BOT_CHECK: 'O YouTube pediu verificação de navegador. Atualize o yt-dlp e tente novamente.',
  YT_DLP_NOT_FOUND: 'yt-dlp não encontrado. Instale com "winget install yt-dlp.yt-dlp" ou defina YT_DLP_PATH no .env.',
  YT_DLP_TIMEOUT: 'O yt-dlp demorou demais para responder. Tente novamente.',
  YT_DLP_FAILED: 'Falha ao consultar o yt-dlp. Atualize o yt-dlp e tente novamente.',
  CONNECTION_TIMEOUT: 'Não foi possível conectar ao canal de voz a tempo. Tente novamente.',
  STREAM_UNAVAILABLE: 'Não foi possível abrir o stream de áudio dessa música.',
  METADATA_INVALID: 'O yt-dlp retornou dados inválidos para essa mídia.',
});

function createMusicError(code, context = {}) {
  const base = MUSIC_ERROR_MESSAGES[code] || MUSIC_ERROR_MESSAGES.YT_DLP_FAILED;
  const details = typeof context === 'string' ? context : context.details;
  const error = new MusicError(code, details ? `${base} (${details})` : base);

  if (details) error.details = details;
  if (context && typeof context === 'object' && context.cause) error.cause = context.cause;

  return error;
}

module.exports = { MusicError, MUSIC_ERROR_MESSAGES, createMusicError };
