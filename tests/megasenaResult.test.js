import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import megasena from '../src/commands/megasena.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const { MEGASENA_CONFIG } = nodeRequire('../src/services/megasena/constants.js');
const { MEGASENA_ERROR_MESSAGES } = nodeRequire('../src/services/megasena/errors.js');
const { createMegaSenaCache, megaSenaCache } = nodeRequire('../src/services/megasena/cache.js');
const { fetchLatestResult } = nodeRequire('../src/services/megasena/http.js');
const { validateResult } = nodeRequire('../src/services/megasena/validate.js');
const results = nodeRequire('../src/services/megasena/results.js');
const embeds = nodeRequire('../src/utils/embeds.js');
const { metadataCache } = nodeRequire('../src/services/music/source/cache.js');

const client = {
  user: {
    tag: 'ChicoBot#0001',
    displayAvatarURL: () => 'https://cdn.example/chicobot.png',
  },
};

function validPayload(overrides = {}) {
  return {
    tipo: 'Megasena',
    numero: 2800,
    dataApuracao: '26/11/2024',
    acumulado: true,
    listaDezenas: ['01', '13', '19', '46', '50', '57'],
    valorEstimadoProximoConcurso: 60000000,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function fetchMockFor(payload = validPayload(), status = 200) {
  return vi.fn(async () => jsonResponse(payload, status));
}

function abortError() {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function hangingFetch() {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      void url;
      void resolve;
      signal.addEventListener('abort', () => reject(abortError()));
    });
}

function createInteraction(subcommand = 'resultado') {
  const interaction = {
    deferred: false,
    replied: false,
    inGuild: () => true,
    guildId: 'g1',
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    client,
    options: {
      getSubcommand: vi.fn(() => subcommand),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {
      interaction.replied = true;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
  };

  return interaction;
}

describe('config do serviço de resultado', () => {
  it('usa timeout de 8 segundos e cache de 10 minutos', () => {
    expect(MEGASENA_CONFIG.TIMEOUT_MS).toBe(8000);
    expect(MEGASENA_CONFIG.CACHE_TTL_MS).toBe(10 * 60 * 1000);
    expect(MEGASENA_CONFIG.API_URL).toBe('https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena');
  });
});

describe('validateResult — validação rigorosa do payload', () => {
  it('normaliza um payload válido', () => {
    expect(validateResult(validPayload())).toEqual({
      concurso: 2800,
      dataSorteio: '26/11/2024',
      dezenas: [1, 13, 19, 46, 50, 57],
      acumulou: true,
      estimativaProximoPremio: 60000000,
    });
  });

  it('aceita dezenas como números inteiros', () => {
    const result = validateResult(validPayload({ listaDezenas: [1, 13, 19, 46, 50, 57] }));

    expect(result.dezenas).toEqual([1, 13, 19, 46, 50, 57]);
  });

  it('aceita data em formato ISO e normaliza para dd/mm/aaaa', () => {
    const result = validateResult(validPayload({ dataApuracao: '2024-11-26T00:00:00' }));

    expect(result.dataSorteio).toBe('26/11/2024');
  });

  it('aceita número do concurso como texto numérico', () => {
    expect(validateResult(validPayload({ numero: '2800' })).concurso).toBe(2800);
  });

  it('descarta estimativa ausente, zero, negativa ou não numérica', () => {
    expect(validateResult(validPayload({ valorEstimadoProximoConcurso: undefined })).estimativaProximoPremio).toBeNull();
    expect(validateResult(validPayload({ valorEstimadoProximoConcurso: 0 })).estimativaProximoPremio).toBeNull();
    expect(validateResult(validPayload({ valorEstimadoProximoConcurso: -5 })).estimativaProximoPremio).toBeNull();
    expect(validateResult(validPayload({ valorEstimadoProximoConcurso: 'abc' })).estimativaProximoPremio).toBeNull();
    expect(validateResult(validPayload({ valorEstimadoProximoConcurso: null })).estimativaProximoPremio).toBeNull();
  });

  it('descarta payload que não é objeto', () => {
    for (const payload of [null, undefined, 'texto', 42, [], true]) {
      expect(() => validateResult(payload)).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });

  it('rejeita concurso ausente, não numérico ou menor que 1', () => {
    for (const numero of [undefined, 'abc', 0, -1, 2.5, null]) {
      expect(() => validateResult(validPayload({ numero }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });

  it('rejeita data ausente, malformada ou impossível', () => {
    for (const dataApuracao of [undefined, null, 'ontem', '31/02/2024', '26/13/2024', '2024-99-01', 26112024]) {
      expect(() => validateResult(validPayload({ dataApuracao }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });

  it('rejeita lista de dezenas ausente ou com quantidade diferente de 6', () => {
    for (const listaDezenas of [undefined, null, [], ['01', '13', '19', '46', '50'], ['01', '13', '19', '46', '50', '57', '59']]) {
      expect(() => validateResult(validPayload({ listaDezenas }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });

  it('rejeita dezena fora de 1 a 60, não numérica ou repetida', () => {
    const invalidLists = [
      ['01', '13', '19', '46', '50', '61'],
      ['00', '13', '19', '46', '50', '57'],
      ['01', '13', '19', '46', '50', 'AB'],
      ['01', '13', '19', '46', '50', '50'],
      [1.5, 13, 19, 46, 50, 57],
    ];

    for (const listaDezenas of invalidLists) {
      expect(() => validateResult(validPayload({ listaDezenas }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });

  it('rejeita acumulado que não é booleano', () => {
    for (const acumulado of [undefined, null, 'sim', 1, 0]) {
      expect(() => validateResult(validPayload({ acumulado }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_PAYLOAD' })
      );
    }
  });
});

describe('fetchLatestResult — cliente HTTP da Caixa', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retorna o payload bruto em HTTP 200', async () => {
    const fetchImpl = fetchMockFor();

    const payload = await fetchLatestResult({ fetchImpl });

    expect(payload).toEqual(validPayload());
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(MEGASENA_CONFIG.API_URL);
    expect(options.method).toBe('GET');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers.Accept).toBe('application/json');
  });

  it('limpa o timer de timeout após o sucesso', async () => {
    vi.useFakeTimers();

    await fetchLatestResult({ fetchImpl: fetchMockFor() });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('HTTP 403 vira FORBIDDEN com mensagem amigável', async () => {
    await expect(fetchLatestResult({ fetchImpl: fetchMockFor({}, 403) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      userMessage: MEGASENA_ERROR_MESSAGES.FORBIDDEN,
    });
    expect(MEGASENA_ERROR_MESSAGES.FORBIDDEN).toContain('403');
  });

  it('HTTP 429 vira RATE_LIMITED com mensagem amigável', async () => {
    await expect(fetchLatestResult({ fetchImpl: fetchMockFor({}, 429) })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      userMessage: MEGASENA_ERROR_MESSAGES.RATE_LIMITED,
    });
    expect(MEGASENA_ERROR_MESSAGES.RATE_LIMITED).toContain('429');
  });

  it('HTTP 500 e 503 viram SERVER_ERROR com o status no detalhe', async () => {
    await expect(fetchLatestResult({ fetchImpl: fetchMockFor({}, 500) })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      details: 'HTTP 500',
    });
    await expect(fetchLatestResult({ fetchImpl: fetchMockFor({}, 503) })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      details: 'HTTP 503',
    });
    expect(MEGASENA_ERROR_MESSAGES.SERVER_ERROR).toContain('instável');
  });

  it('HTTP 404 vira indisponibilidade genérica', async () => {
    await expect(fetchLatestResult({ fetchImpl: fetchMockFor({}, 404) })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: 'HTTP 404',
    });
  });

  it('erro de rede vira indisponibilidade', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(fetchLatestResult({ fetchImpl })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('corpo não JSON vira resposta inválida', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));

    await expect(fetchLatestResult({ fetchImpl })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('resposta sem json() vira resposta inválida', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));

    await expect(fetchLatestResult({ fetchImpl })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('resposta não objeto vira indisponibilidade', async () => {
    const fetchImpl = vi.fn(async () => null);

    await expect(fetchLatestResult({ fetchImpl })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('aborta e reporta TIMEOUT após os 8 segundos configurados', async () => {
    vi.useFakeTimers();

    const promise = fetchLatestResult({ fetchImpl: hangingFetch() });
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(MEGASENA_CONFIG.TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await promise.then(
      () => null,
      (err) => err
    );

    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(error.userMessage).toBe(MEGASENA_ERROR_MESSAGES.TIMEOUT);
  });

  it('respeita timeout injetado e não deixa timer pendurado', async () => {
    await expect(fetchLatestResult({ fetchImpl: hangingFetch(), timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      details: '20ms',
    });
  });
});

describe('getLatestResult — cache própria da Mega-Sena', () => {
  beforeEach(() => {
    results.clearResultCache();
    metadataCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    results.clearResultCache();
    metadataCache.clear();
  });

  it('miss na primeira consulta e hit na segunda', async () => {
    const fetchImpl = fetchMockFor();

    const first = await results.getLatestResult({ fetchImpl });
    const second = await results.getLatestResult({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      concurso: 2800,
      dataSorteio: '26/11/2024',
      dezenas: [1, 13, 19, 46, 50, 57],
      acumulou: true,
      estimativaProximoPremio: 60000000,
    });
    expect(second).toEqual(first);
    expect(megaSenaCache.size).toBe(1);
  });

  it('expira após 10 minutos e volta a consultar a API', async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchMockFor();

    await results.getLatestResult({ fetchImpl });
    await vi.advanceTimersByTimeAsync(MEGASENA_CONFIG.CACHE_TTL_MS - 1);
    await results.getLatestResult({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await results.getLatestResult({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(megaSenaCache.size).toBe(1);
  });

  it('deduplica consultas simultâneas em uma única requisição', async () => {
    let release;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(jsonResponse(validPayload()));
        })
    );

    const first = results.getLatestResult({ fetchImpl });
    const second = results.getLatestResult({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(megaSenaCache.inflightSize).toBe(1);

    release();

    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(megaSenaCache.inflightSize).toBe(0);
    expect(megaSenaCache.size).toBe(1);
  });

  it('falha não entra na cache nem deixa in-flight preso', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(results.getLatestResult({ fetchImpl: failing })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });

    expect(megaSenaCache.size).toBe(0);
    expect(megaSenaCache.inflightSize).toBe(0);

    await results.getLatestResult({ fetchImpl: fetchMockFor() });

    expect(megaSenaCache.size).toBe(1);
  });

  it('erro HTTP 5xx também fica fora da cache', async () => {
    const failing = fetchMockFor({}, 503);

    await expect(results.getLatestResult({ fetchImpl: failing })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });

    expect(megaSenaCache.size).toBe(0);
    expect(megaSenaCache.inflightSize).toBe(0);
  });

  it('resposta inválida fica fora da cache', async () => {
    const invalid = fetchMockFor({ qualquer: 'coisa' });

    await expect(results.getLatestResult({ fetchImpl: invalid })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });

    expect(megaSenaCache.size).toBe(0);
    expect(megaSenaCache.inflightSize).toBe(0);
  });

  it('consultas simultâneas que falham liberam o in-flight para as próximas', async () => {
    let reject;
    const failing = vi.fn(
      () =>
        new Promise((resolve, rejectPromise) => {
          reject = rejectPromise;
          void resolve;
        })
    );

    const first = results.getLatestResult({ fetchImpl: failing });
    const second = results.getLatestResult({ fetchImpl: failing });

    expect(megaSenaCache.inflightSize).toBe(1);

    reject(new TypeError('fetch failed'));

    await expect(first).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(second).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    expect(megaSenaCache.inflightSize).toBe(0);
    expect(megaSenaCache.size).toBe(0);

    await results.getLatestResult({ fetchImpl: fetchMockFor() });

    expect(megaSenaCache.size).toBe(1);
  });

  it('usa TTL próprio de 10 minutos, independente do cache de música', () => {
    expect(megaSenaCache.ttlMs).toBe(10 * 60 * 1000);
    expect(megaSenaCache).not.toBe(metadataCache);

    const isolada = createMegaSenaCache();
    expect(isolada.ttlMs).toBe(MEGASENA_CONFIG.CACHE_TTL_MS);
    expect(isolada).not.toBe(megaSenaCache);
  });

  it('não escreve nada no cache de música', async () => {
    metadataCache.clear();

    await results.getLatestResult({ fetchImpl: fetchMockFor() });

    expect(megaSenaCache.size).toBe(1);
    expect(metadataCache.size).toBe(0);
    expect(metadataCache.inflightSize).toBe(0);
    expect(metadataCache.get('s:qualquer')).toBeUndefined();
  });
});

describe('buildMegaSenaResultEmbed — embed azul do ChicoBot', () => {
  const result = {
    concurso: 2800,
    dataSorteio: '26/11/2024',
    dezenas: [1, 13, 19, 46, 50, 57],
    acumulou: true,
    estimativaProximoPremio: 60000000,
  };

  it('exibe concurso, data, dezenas, acumulação, estimativa e aviso', () => {
    const data = embeds.buildMegaSenaResultEmbed({ result, client }).toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.author.name).toBe('ChicoBot • Mega-Sena');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.title).toBe('🎯 Resultado da Mega-Sena');
    expect(data.description).toBe('**01  13  19  46  50  57**');

    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('Concurso').value).toBe('#2800');
    expect(field('Data').value).toBe('26/11/2024');
    expect(field('Acumulou').value).toContain('Sim');
    expect(field('Estimativa').value).toBe('R$ 60.000.000,00');

    expect(data.footer.text).toContain('ChicoBot');
    expect(data.footer.text).toContain('resultado informativo');
    expect(data.footer.text).toContain('não representa previsão de sorteios futuros');
  });

  it('sem acumulação mostra que houve ganhador', () => {
    const data = embeds.buildMegaSenaResultEmbed({
      result: { ...result, acumulou: false, estimativaProximoPremio: null },
      client,
    }).toJSON();

    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('Acumulou').value).toContain('Não');
    expect(field('Estimativa')).toBeUndefined();
  });

  it('não exibe estimativa quando ela é inválida ou ausente', () => {
    for (const estimativaProximoPremio of [null, undefined, 0, -1, Number.NaN]) {
      const data = embeds.buildMegaSenaResultEmbed({
        result: { ...result, estimativaProximoPremio },
        client,
      }).toJSON();

      expect(data.fields.some((item) => item.name.includes('Estimativa'))).toBe(false);
    }
  });

  it('formata valores em reais com separadores brasileiros', () => {
    expect(embeds.formatMegaSenaBRL(3500000)).toBe('R$ 3.500.000,00');
    expect(embeds.formatMegaSenaBRL(1234.5)).toBe('R$ 1.234,50');
    expect(embeds.formatMegaSenaBRL(0)).toBeNull();
    expect(embeds.formatMegaSenaBRL(Number.NaN)).toBeNull();
    expect(embeds.formatMegaSenaBRL(-10)).toBeNull();
  });
});

describe('/megasena resultado — comando', () => {
  let fetchMock;

  beforeEach(() => {
    results.clearResultCache();
    metadataCache.clear();
    fetchMock = vi.fn(async () => jsonResponse(validPayload()));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    results.clearResultCache();
    metadataCache.clear();
  });

  it('registra os dois subcomandos', () => {
    const json = megasena.data.toJSON();

    expect(json.options.map((option) => option.name)).toEqual(['jogo', 'resultado']);
    expect(json.options[1].description).toContain('resultado oficial');
  });

  it('faz deferReply e responde com o embed do último resultado', async () => {
    const interaction = createInteraction('resultado');

    await megasena.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls[0][0];
    const data = payload.embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.description).toBe('**01  13  19  46  50  57**');
    expect(data.fields.some((field) => field.value === '#2800')).toBe(true);
    expect(data.footer.text).toContain('não representa previsão de sorteios futuros');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('segunda consulta no mesmo minuto usa a cache', async () => {
    await megasena.execute(createInteraction('resultado'));
    await megasena.execute(createInteraction('resultado'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 403 responde mensagem amigável sem embed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 403));

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);

    const payload = interaction.editReply.mock.calls[0][0];

    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toBe(MEGASENA_ERROR_MESSAGES.FORBIDDEN);
  });

  it('HTTP 429 responde mensagem amigável sem embed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 429));

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(interaction.editReply.mock.calls[0][0].content).toBe(MEGASENA_ERROR_MESSAGES.RATE_LIMITED);
  });

  it('HTTP 5xx responde mensagem amigável sem embed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 503));

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(interaction.editReply.mock.calls[0][0].content).toBe(MEGASENA_ERROR_MESSAGES.SERVER_ERROR);
  });

  it('timeout responde mensagem amigável sem embed', async () => {
    fetchMock.mockImplementation(async () => {
      throw abortError();
    });

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(interaction.editReply.mock.calls[0][0].content).toBe(MEGASENA_ERROR_MESSAGES.TIMEOUT);
  });

  it('payload inválido responde mensagem amigável sem embed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ qualquer: 'coisa' }));

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(interaction.editReply.mock.calls[0][0].content).toBe(MEGASENA_ERROR_MESSAGES.INVALID_PAYLOAD);
  });

  it('falha não é cacheada: nova tentativa consulta a API de novo', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 403));

    await megasena.execute(createInteraction('resultado'));
    await megasena.execute(createInteraction('resultado'));

    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(async () => jsonResponse(validPayload()));

    const interaction = createInteraction('resultado');
    await megasena.execute(interaction);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(interaction.editReply.mock.calls[0][0].embeds).toBeDefined();
  });

  it('erro inesperado é propagado para o handler de interação', async () => {
    const spy = vi.spyOn(results, 'getLatestResult').mockRejectedValue(new Error('erro desconhecido'));

    const interaction = createInteraction('resultado');

    await expect(megasena.execute(interaction)).rejects.toThrowError('erro desconhecido');
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('/megasena jogo continua funcionando sem consultar a API', async () => {
    const interaction = createInteraction('jogo');

    await megasena.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(data.title).toBe('🎯 Jogo da Mega-Sena');
    expect(data.footer.text).toContain('diversão apenas');
  });
});
