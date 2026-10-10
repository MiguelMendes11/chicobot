class MegaSenaError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.name = 'MegaSenaError';
    this.code = code;
    this.userMessage = userMessage;
    this.expected = true;
  }
}

const MEGASENA_ERROR_MESSAGES = Object.freeze({
  TIMEOUT: 'A Caixa demorou demais para responder. Tente novamente em instantes.',
  UNAVAILABLE: 'Não foi possível consultar o resultado agora. Tente novamente em alguns minutos.',
  FORBIDDEN: 'O serviço da Caixa bloqueou esta consulta (HTTP 403). Tente novamente mais tarde.',
  RATE_LIMITED: 'Muitas consultas em pouco tempo (HTTP 429). Aguarde um instante e tente de novo.',
  SERVER_ERROR: 'O servidor da Caixa está instável neste momento. Tente novamente em alguns minutos.',
  INVALID_RESPONSE: 'A Caixa retornou uma resposta que não pôde ser lida. Tente novamente mais tarde.',
  INVALID_PAYLOAD: 'O resultado recebido não tem os dados esperados. Tente novamente mais tarde.',
});

function createMegaSenaError(code, context = {}) {
  const base = MEGASENA_ERROR_MESSAGES[code] || MEGASENA_ERROR_MESSAGES.UNAVAILABLE;
  const details = typeof context === 'string' ? context : context.details;
  const error = new MegaSenaError(code, base);

  if (details) error.details = details;
  if (context && typeof context === 'object' && context.cause) error.cause = context.cause;

  return error;
}

module.exports = { MegaSenaError, MEGASENA_ERROR_MESSAGES, createMegaSenaError };
