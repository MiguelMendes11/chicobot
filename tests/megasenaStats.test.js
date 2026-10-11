import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import megasena from '../src/commands/megasena.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const statistics = nodeRequire('../src/services/megasena/statistics.js');
const embeds = nodeRequire('../src/utils/embeds.js');
const { MEGASENA_ERROR_MESSAGES, createMegaSenaError } = nodeRequire('../src/services/megasena/errors.js');
const { metadataCache } = nodeRequire('../src/services/music/source/cache.js');
const updateHistory = nodeRequire('../scripts/update-megasena-history.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'megasena-frequencias', name);
const realSnapshotPath = path.join(here, '..', 'data', 'megasena-frequencias.json');

const client = {
  user: {
    tag: 'ChicoBot#0001',
    displayAvatarURL: () => 'https://cdn.example/chicobot.png',
  },
};

function baseSnapshot() {
  const contagens = {};

  for (let dezena = 1; dezena <= 60; dezena += 1) {
    if (dezena <= 3) contagens[dezena] = 5;
    else if (dezena <= 8) contagens[dezena] = 4;
    else if (dezena <= 14) contagens[dezena] = 0;
    else if (dezena <= 39) contagens[dezena] = 1;
    else contagens[dezena] = 0;
  }

  return {
    fonte: 'Caixa Econômica Federal — API oficial (servicebus2.caixa.gov.br/portaldeloterias/api/megasena)',
    geradoEm: '2026-10-11T12:00:00.000Z',
    ateConcurso: 10,
    contagens,
  };
}

function createInteraction(subcommand = 'estatisticas') {
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

function expectRejectedSnapshot(snapshot) {
  expect(() => statistics.validateSnapshot(snapshot)).toThrowError(
    expect.objectContaining({ code: 'HISTORY_INVALID', name: 'MegaSenaError' })
  );
}

describe('validateSnapshot — validação rigorosa do snapshot', () => {
  it('normaliza um snapshot válido com 60 dezenas', () => {
    const snapshot = statistics.validateSnapshot(baseSnapshot());

    expect(snapshot.fonte).toContain('Caixa');
    expect(snapshot.geradoEm).toBe('2026-10-11T12:00:00.000Z');
    expect(snapshot.ateConcurso).toBe(10);
    expect(snapshot.totalAparicoes).toBe(60);
    expect(Object.keys(snapshot.contagens)).toHaveLength(60);
    expect(snapshot.contagens['1']).toBe(5);
    expect(snapshot.contagens['60']).toBe(0);
  });

  it('rejeita snapshot que não é um objeto', () => {
    for (const payload of [null, undefined, 'texto', 42, [], true]) {
      expectRejectedSnapshot(payload);
    }
  });

  it('rejeita arquivo com menos ou mais de 60 dezenas', () => {
    const semUma = baseSnapshot();
    delete semUma.contagens['60'];
    expectRejectedSnapshot(semUma);

    const comExtra = baseSnapshot();
    comExtra.contagens['61'] = 1;
    expectRejectedSnapshot(comExtra);

    const comFaixaErrada = baseSnapshot();
    delete comFaixaErrada.contagens['60'];
    comFaixaErrada.contagens['61'] = 0;
    expectRejectedSnapshot(comFaixaErrada);

    const vazio = baseSnapshot();
    vazio.contagens = {};
    expectRejectedSnapshot(vazio);
  });

  it('rejeita dezenas duplicadas mesmo com chaves normalizadas', () => {
    const snapshot = baseSnapshot();
    delete snapshot.contagens['60'];
    snapshot.contagens['01'] = 5;

    expect(Object.keys(snapshot.contagens)).toHaveLength(60);
    expectRejectedSnapshot(snapshot);
  });

  it('rejeita contagens negativas, fracionárias, textuais ou nulas', () => {
    for (const valor of [-1, -100, 1.5, Number.NaN, '12', null, undefined, {}]) {
      const snapshot = baseSnapshot();
      snapshot.contagens['7'] = valor;
      expectRejectedSnapshot(snapshot);
    }
  });

  it('rejeita soma inconsistente com o número de concursos', () => {
    const snapshot = baseSnapshot();
    snapshot.contagens['1'] = 1;

    expect(() => statistics.validateSnapshot(snapshot)).toThrowError(
      expect.objectContaining({ code: 'HISTORY_INVALID', details: expect.stringContaining('soma das contagens') })
    );
  });

  it('rejeita metadados ausentes ou inválidos', () => {
    for (const fonte of [undefined, null, '', '   ', 42]) {
      const snapshot = baseSnapshot();
      snapshot.fonte = fonte;
      expectRejectedSnapshot(snapshot);
    }

    for (const geradoEm of [undefined, null, '', 'ontem', '2026-13-45', 20261011]) {
      const snapshot = baseSnapshot();
      snapshot.geradoEm = geradoEm;
      expectRejectedSnapshot(snapshot);
    }

    for (const ateConcurso of [undefined, null, 0, -1, 2.5, '10']) {
      const snapshot = baseSnapshot();
      snapshot.ateConcurso = ateConcurso;
      expectRejectedSnapshot(snapshot);
    }

    expectRejectedSnapshot({ ...baseSnapshot(), fonte: undefined, geradoEm: undefined, ateConcurso: undefined });
  });

  it('rejeita contagens ausentes ou em formato errado', () => {
    for (const contagens of [undefined, null, '60', 60, []]) {
      expectRejectedSnapshot({ ...baseSnapshot(), contagens });
    }
  });
});

describe('loadSnapshot — leitura do arquivo local', () => {
  it('carrega a fixture válida sem nenhuma consulta externa', async () => {
    const snapshot = await statistics.loadSnapshot({ filePath: fixture('valido.json') });

    expect(snapshot.ateConcurso).toBe(10);
    expect(snapshot.totalAparicoes).toBe(60);
    expect(Object.keys(snapshot.contagens)).toHaveLength(60);
  });

  it('arquivo ausente vira HISTORY_UNAVAILABLE', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('nao-existe.json') })).rejects.toMatchObject({
      code: 'HISTORY_UNAVAILABLE',
      expected: true,
      userMessage: MEGASENA_ERROR_MESSAGES.HISTORY_UNAVAILABLE,
    });
    expect(MEGASENA_ERROR_MESSAGES.HISTORY_UNAVAILABLE).toContain('não está disponível');
    expect(MEGASENA_ERROR_MESSAGES.HISTORY_UNAVAILABLE).toContain('Nada é estimado ou inventado');
  });

  it('arquivo com JSON inválido vira HISTORY_INVALID', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('json-invalido.json') })).rejects.toMatchObject({
      code: 'HISTORY_INVALID',
      userMessage: MEGASENA_ERROR_MESSAGES.HISTORY_INVALID,
    });
  });

  it('arquivo incompleto (59 dezenas) é rejeitado', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('incompleto.json') })).rejects.toMatchObject({
      code: 'HISTORY_INVALID',
      details: expect.stringContaining('esperadas 60 dezenas'),
    });
  });

  it('arquivo com soma inconsistente é rejeitado', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('soma-inconsistente.json') })).rejects.toMatchObject({
      code: 'HISTORY_INVALID',
      details: expect.stringContaining('soma das contagens'),
    });
  });

  it('arquivo corrompido com contagem negativa é rejeitado', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('contagem-negativa.json') })).rejects.toMatchObject({
      code: 'HISTORY_INVALID',
      details: expect.stringContaining('contagem negativa'),
    });
  });

  it('arquivo sem os metadados obrigatórios é rejeitado', async () => {
    await expect(statistics.loadSnapshot({ filePath: fixture('sem-metadados.json') })).rejects.toMatchObject({
      code: 'HISTORY_INVALID',
      details: 'fonte ausente',
    });
  });

  it('propaga o erro inesperado sem mascarar', async () => {
    const fsImpl = { readFile: vi.fn(async () => { throw new Error('disco quebrado'); }) };

    await expect(statistics.loadSnapshot({ filePath: 'x.json', fsImpl })).rejects.toMatchObject({
      code: 'HISTORY_UNAVAILABLE',
    });
  });
});

describe('buildRankings — rankings determinísticos', () => {
  function contagensFrom(entries, fallback = 1) {
    const contagens = {};
    for (let dezena = 1; dezena <= 60; dezena += 1) contagens[dezena] = fallback;
    for (const [dezena, contagem] of entries) contagens[dezena] = contagem;
    return contagens;
  }

  it('ranking das 6 mais sorteadas ordena por contagem decrescente', () => {
    const contagens = contagensFrom(
      [[10, 359], [53, 350], [5, 334], [37, 331], [27, 329], [33, 329], [1, 100]],
      50
    );

    const { maisSorteadas } = statistics.buildRankings(contagens);

    expect(maisSorteadas).toEqual([
      { dezena: 10, contagem: 359 },
      { dezena: 53, contagem: 350 },
      { dezena: 5, contagem: 334 },
      { dezena: 37, contagem: 331 },
      { dezena: 27, contagem: 329 },
      { dezena: 33, contagem: 329 },
    ]);
  });

  it('ranking das 6 menos sorteadas ordena por contagem crescente', () => {
    const contagens = contagensFrom(
      [[26, 250], [21, 261], [55, 264], [22, 275], [15, 276], [3, 282], [10, 359]],
      400
    );

    const { menosSorteadas } = statistics.buildRankings(contagens);

    expect(menosSorteadas).toEqual([
      { dezena: 26, contagem: 250 },
      { dezena: 21, contagem: 261 },
      { dezena: 55, contagem: 264 },
      { dezena: 22, contagem: 275 },
      { dezena: 15, contagem: 276 },
      { dezena: 3, contagem: 282 },
    ]);
  });

  it('desempata por dezena crescente nos dois sentidos', () => {
    const empatadas = contagensFrom([[60, 5], [40, 5], [1, 5], [2, 0], [59, 0], [3, 0]], 1);

    const { maisSorteadas, menosSorteadas } = statistics.buildRankings(empatadas);

    expect(maisSorteadas.slice(0, 3)).toEqual([
      { dezena: 1, contagem: 5 },
      { dezena: 40, contagem: 5 },
      { dezena: 60, contagem: 5 },
    ]);
    expect(menosSorteadas.slice(0, 3)).toEqual([
      { dezena: 2, contagem: 0 },
      { dezena: 3, contagem: 0 },
      { dezena: 59, contagem: 0 },
    ]);
  });

  it('com contagens iguais, ambos os rankings começam pelas dezenas menores', () => {
    const contagens = contagensFrom([], 0);
    const { maisSorteadas, menosSorteadas } = statistics.buildRankings(contagens);

    expect(maisSorteadas.map((item) => item.dezena)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(menosSorteadas.map((item) => item.dezena)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('é determinístico em execuções repetidas', () => {
    const contagens = contagensFrom([[60, 5], [1, 5], [30, 5], [15, 0], [45, 0], [2, 0]], 1);

    const primeira = statistics.buildRankings(contagens);
    const segunda = statistics.buildRankings(contagens);
    const terceira = statistics.buildRankings({ ...contagens });

    expect(primeira).toEqual(segunda);
    expect(primeira).toEqual(terceira);
  });

  it('respeita o limite informado', () => {
    const contagens = contagensFrom([[1, 10], [2, 9], [3, 8]], 0);

    const { maisSorteadas, menosSorteadas } = statistics.buildRankings(contagens, 2);

    expect(maisSorteadas).toHaveLength(2);
    expect(menosSorteadas).toHaveLength(2);
    expect(statistics.buildRankings(contagens).maisSorteadas).toHaveLength(6);
  });
});

describe('getStatistics — snapshot real do repositório', () => {
  it('carrega data/megasena-frequencias.json com dados oficiais', async () => {
    const stats = await statistics.getStatistics({ filePath: realSnapshotPath });

    expect(stats.fonte).toContain('Caixa');
    expect(stats.ateConcurso).toBeGreaterThanOrEqual(1);
    expect(stats.geradoEm).not.toBeNull();
    expect(Object.keys(stats.contagens)).toHaveLength(60);
    expect(stats.totalAparicoes).toBe(stats.ateConcurso * 6);
    expect(stats.maisSorteadas).toHaveLength(6);
    expect(stats.menosSorteadas).toHaveLength(6);
    expect(stats.maisSorteadas[0].contagem).toBeGreaterThanOrEqual(stats.menosSorteadas[0].contagem);
  });

  it('mantém os rankings em ordem determinística', async () => {
    const stats = await statistics.getStatistics({ filePath: realSnapshotPath });

    for (let index = 1; index < stats.maisSorteadas.length; index += 1) {
      const previous = stats.maisSorteadas[index - 1];
      const current = stats.maisSorteadas[index];

      expect(previous.contagem).toBeGreaterThanOrEqual(current.contagem);
      if (previous.contagem === current.contagem) {
        expect(previous.dezena).toBeLessThan(current.dezena);
      }
    }

    for (let index = 1; index < stats.menosSorteadas.length; index += 1) {
      const previous = stats.menosSorteadas[index - 1];
      const current = stats.menosSorteadas[index];

      expect(previous.contagem).toBeLessThanOrEqual(current.contagem);
      if (previous.contagem === current.contagem) {
        expect(previous.dezena).toBeLessThan(current.dezena);
      }
    }
  });
});

describe('buildMegaSenaStatsEmbed — embed azul do ChicoBot', () => {
  let stats;

  beforeEach(async () => {
    stats = await statistics.getStatistics({ filePath: fixture('valido.json') });
  });

  it('exibe cor, autor, título e o aviso de independência dos sorteios', () => {
    const data = embeds.buildMegaSenaStatsEmbed({ stats, client }).toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.author.name).toBe('ChicoBot • Mega-Sena');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.title).toBe('📊 Estatísticas da Mega-Sena');
    expect(data.description).toContain('não aumentam');
    expect(data.description).toContain('chances de uma dezena sair no próximo sorteio');
    expect(data.description).toContain('cada sorteio é independente');
  });

  it('lista as 6 dezenas mais e menos sorteadas com a contagem de aparições', () => {
    const data = embeds.buildMegaSenaStatsEmbed({ stats, client }).toJSON();
    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('mais sorteadas').value).toBe(
      ['**01** — 5 aparições', '**02** — 5 aparições', '**03** — 5 aparições', '**04** — 4 aparições', '**05** — 4 aparições', '**06** — 4 aparições'].join('\n')
    );
    expect(field('menos sorteadas').value).toBe(
      ['**09** — 0 aparições', '**10** — 0 aparições', '**11** — 0 aparições', '**12** — 0 aparições', '**13** — 0 aparições', '**14** — 0 aparições'].join('\n')
    );
  });

  it('usa o singular quando a dezena apareceu uma única vez', () => {
    const data = embeds.buildMegaSenaStatsEmbed({
      stats: { ...stats, maisSorteadas: [{ dezena: 7, contagem: 1 }], menosSorteadas: [{ dezena: 8, contagem: 0 }] },
      client,
    }).toJSON();

    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('mais sorteadas').value).toBe('**07** — 1 aparição');
    expect(field('menos sorteadas').value).toBe('**08** — 0 aparições');
  });

  it('informa último concurso, data de atualização e fonte dos dados', () => {
    const data = embeds.buildMegaSenaStatsEmbed({ stats, client }).toJSON();
    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('Último concurso').value).toBe('#10');
    expect(field('Atualizado em').value).toBe('11/10/2026 às 12:00 UTC');
    expect(field('Fonte dos dados').value).toContain('Caixa Econômica Federal');
    expect(field('Fonte dos dados').value).toContain('servicebus2.caixa.gov.br');
  });

  it('termina com o rodapé de marca e sem promessa de previsão', () => {
    const data = embeds.buildMegaSenaStatsEmbed({ stats, client }).toJSON();

    expect(data.footer.text).toContain('ChicoBot');
    expect(data.footer.text).toContain('frequências históricas');
    expect(data.footer.text).toContain('não representa previsão de sorteios futuros');
  });

  it('sem dados exibe marcadores em vez de quebrar o embed', () => {
    const data = embeds.buildMegaSenaStatsEmbed({ stats: {}, client }).toJSON();
    const field = (name) => data.fields.find((item) => item.name.includes(name));

    expect(field('mais sorteadas').value).toBe('*Sem dados.*');
    expect(field('Último concurso').value).toBe('—');
    expect(field('Fonte dos dados').value).toBe('—');
    expect(embeds.formatMegaSenaSnapshotDate('data invalida')).toBe('—');
  });
});

describe('/megasena estatisticas — comando', () => {
  let fetchSpy;

  beforeEach(() => {
    metadataCache.clear();
    fetchSpy = vi.fn(async () => {
      throw new Error('a fase de estatísticas não deve acessar a internet');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    metadataCache.clear();
  });

  it('registra o subcomando estatisticas ao lado de jogo e resultado', () => {
    const json = megasena.data.toJSON();

    expect(json.options.map((option) => option.name)).toEqual(['jogo', 'resultado', 'estatisticas']);
    expect(json.options[2].type).toBe(1);
    expect(json.options[2].description).toContain('menos sorteadas');
  });

  it('faz deferReply e responde com o embed do snapshot local, sem rede', async () => {
    const snapshot = JSON.parse(
      nodeRequire('node:fs').readFileSync(realSnapshotPath, 'utf8')
    );
    const interaction = createInteraction('estatisticas');

    await megasena.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls[0][0];
    const data = payload.embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.title).toBe('📊 Estatísticas da Mega-Sena');
    expect(data.description).toContain('não aumentam');
    expect(data.fields.some((field) => field.name.includes('mais sorteadas'))).toBe(true);
    expect(data.fields.some((field) => field.name.includes('menos sorteadas'))).toBe(true);
    expect(data.fields.some((field) => field.value === `#${snapshot.ateConcurso}`)).toBe(true);
    expect(data.footer.text).toContain('não representa previsão de sorteios futuros');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(metadataCache.size).toBe(0);
    expect(metadataCache.inflightSize).toBe(0);
  });

  it('histórico indisponível responde mensagem amigável sem embed', async () => {
    vi.spyOn(statistics, 'getStatistics').mockRejectedValue(
      createMegaSenaError('HISTORY_UNAVAILABLE')
    );

    const interaction = createInteraction('estatisticas');
    await megasena.execute(interaction);

    const payload = interaction.editReply.mock.calls[0][0];

    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toBe(MEGASENA_ERROR_MESSAGES.HISTORY_UNAVAILABLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('snapshot corrompido responde mensagem amigável sem embed', async () => {
    vi.spyOn(statistics, 'getStatistics').mockRejectedValue(createMegaSenaError('HISTORY_INVALID'));

    const interaction = createInteraction('estatisticas');
    await megasena.execute(interaction);

    const payload = interaction.editReply.mock.calls[0][0];

    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toBe(MEGASENA_ERROR_MESSAGES.HISTORY_INVALID);
  });

  it('erro inesperado é propagado para o handler de interação', async () => {
    vi.spyOn(statistics, 'getStatistics').mockRejectedValue(new Error('erro desconhecido'));

    const interaction = createInteraction('estatisticas');

    await expect(megasena.execute(interaction)).rejects.toThrowError('erro desconhecido');
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('subcomandos jogo e resultado continuam intactos', async () => {
    const jogo = createInteraction('jogo');
    await megasena.execute(jogo);

    expect(jogo.reply).toHaveBeenCalledTimes(1);
    expect(jogo.deferReply).not.toHaveBeenCalled();

    const desconhecido = createInteraction('outro');
    await megasena.execute(desconhecido);

    expect(desconhecido.reply).not.toHaveBeenCalled();
    expect(desconhecido.deferReply).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('scripts/update-megasena-history.js — gerador do snapshot', () => {
  it('usa a API oficial da Caixa como fonte', () => {
    expect(updateHistory.API_BASE).toBe('https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena');
    expect(updateHistory.FONT).toContain('Caixa Econômica Federal');
    expect(updateHistory.FONT).toContain('API oficial');
  });

  it('parseArgs reconhece as opções e rejeita argumentos desconhecidos', () => {
    const options = updateHistory.parseArgs(['--limit=10', '--rps=2', '--dry-run', '--out=tmp.json']);

    expect(options.limit).toBe(10);
    expect(options.rps).toBe(2);
    expect(options.dryRun).toBe(true);
    expect(options.out).toContain('tmp.json');

    expect(() => updateHistory.parseArgs(['--banana'])).toThrowError('argumento desconhecido');
    expect(() => updateHistory.parseArgs(['--limit=abc'])).toThrowError('--limit espera um inteiro positivo');
    expect(() => updateHistory.parseArgs(['--limit=0'])).toThrowError('--limit espera um inteiro positivo');
  });

  it('extractDezenas valida o payload de cada concurso', () => {
    const payload = { numero: 1, listaDezenas: ['04', '05', '30', '33', '41', '52'] };

    expect(updateHistory.extractDezenas(payload, 1)).toEqual([4, 5, 30, 33, 41, 52]);

    expect(() => updateHistory.extractDezenas(payload, 2)).toThrowError('a API devolveu o concurso 1');
    expect(() => updateHistory.extractDezenas({ numero: 1, listaDezenas: ['04', '05'] }, 1)).toThrowError('lista de dezenas inválida');
    expect(() => updateHistory.extractDezenas({ numero: 1, listaDezenas: ['04', '05', '30', '33', '41', '61'] }, 1)).toThrowError('fora de 1 a 60');
    expect(() => updateHistory.extractDezenas({ numero: 1, listaDezenas: ['04', '05', '30', '33', '41', '41'] }, 1)).toThrowError('dezenas repetidas');
    expect(() => updateHistory.extractDezenas({ numero: 1, listaDezenas: ['04', '05', '30', '33', '41', 'AB'] }, 1)).toThrowError('dezena não numérica');
    expect(() => updateHistory.extractDezenas(null, 1)).toThrowError('resposta sem dados');
  });

  it('buildSnapshot monta 60 contagens que passam na validação', () => {
    const counts = new Array(61).fill(0);
    for (let dezena = 1; dezena <= 60; dezena += 1) counts[dezena] = 1;

    const snapshot = updateHistory.buildSnapshot({ counts, ateConcurso: 10, geradoEm: '2026-10-11T12:00:00.000Z' });

    expect(snapshot.ateConcurso).toBe(10);
    expect(Object.keys(snapshot.contagens)).toHaveLength(60);
    expect(statistics.validateSnapshot(snapshot).totalAparicoes).toBe(60);
  });

  it('fetchHistory acumula as contagens usando o fetch injetado (sem internet)', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const concurso = Number(url.split('/').pop());
      return {
        ok: true,
        status: 200,
        json: async () => ({
          numero: concurso,
          listaDezenas: ['01', '02', '03', '04', '05', '06'],
        }),
      };
    });

    const onChunk = vi.fn();
    const result = await updateHistory.fetchHistory({
      ateConcurso: 12,
      chunk: 5,
      rps: 0,
      concurrency: 3,
      fetchImpl,
      onChunk,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(result.concluidoAte).toBe(12);
    expect(result.counts[1]).toBe(12);
    expect(result.counts[6]).toBe(12);
    expect(result.counts[7]).toBe(0);
    expect(result.counts.slice(1).reduce((total, count) => total + count, 0)).toBe(72);
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls.map(([concluidoAte]) => concluidoAte)).toEqual([5, 10, 12]);
  });

  it('retoma de onde parou quando existe checkpoint parcial', async () => {
    const fs = nodeRequire('node:fs');
    const os = nodeRequire('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicobot-freq-'));
    const out = path.join(dir, 'megasena-frequencias.json');
    const partial = `${out}.partial.json`;

    try {
      const counts = new Array(61).fill(0);
      for (let dezena = 1; dezena <= 6; dezena += 1) counts[dezena] = 4;

      fs.writeFileSync(partial, JSON.stringify({ ateConcurso: 8, concluidoAte: 4, contagensParciais: counts }));

      const fetchImpl = vi.fn(async (url) => {
        const tail = url.split('/').pop();
        const concurso = /^\d+$/.test(tail) ? Number(tail) : 8;
        return { ok: true, status: 200, json: async () => ({ numero: concurso, listaDezenas: ['01', '02', '03', '04', '05', '06'] }) };
      });

      const snapshot = await updateHistory.main(['--ate=8', `--out=${out}`, '--rps=0', '--chunk=4'], {
        fetchImpl,
        log: () => {},
      });

      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(snapshot.ateConcurso).toBe(8);
      expect(snapshot.contagens['1']).toBe(8);
      expect(statistics.validateSnapshot(snapshot).totalAparicoes).toBe(48);
      expect(fs.existsSync(partial)).toBe(false);
      expect(JSON.parse(fs.readFileSync(out, 'utf8')).ateConcurso).toBe(8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
