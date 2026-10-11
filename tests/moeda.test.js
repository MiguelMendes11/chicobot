import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import moedaCommand from '../src/commands/moeda.js';
import { buildMoedaEmbed } from '../src/utils/embeds.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const moedaService = nodeRequire('../src/services/moeda.js');

function createInteraction() {
  return {
    deferred: false,
    replied: false,
    inGuild: () => true,
    user: { tag: 'tester#0001' },
    client: {
      user: {
        tag: 'ChicoBot#0001',
        displayAvatarURL: () => 'https://cdn.example/chicobot.png',
      },
    },
    reply: vi.fn(async () => {}),
  };
}

describe('serviço moeda', () => {
  it('retorna somente "cara" ou "coroa"', () => {
    for (let i = 0; i < 100; i += 1) {
      const result = moedaService.flip();

      expect(['cara', 'coroa']).toContain(result);
    }
  });

  it('gerador injetado 0 retorna "cara"', () => {
    const fakeRandomInt = vi.fn(() => 0);

    expect(moedaService.flip(fakeRandomInt)).toBe('cara');
    expect(fakeRandomInt).toHaveBeenCalledWith(2);
  });

  it('gerador injetado 1 retorna "coroa"', () => {
    const fakeRandomInt = vi.fn(() => 1);

    expect(moedaService.flip(fakeRandomInt)).toBe('coroa');
    expect(fakeRandomInt).toHaveBeenCalledWith(2);
  });

  it('usa crypto.randomInt(2) por padrão', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/services/moeda.js', import.meta.url)),
      'utf8'
    );

    expect(source).toMatch(/require\('node:crypto'\)/);
    expect(source).toMatch(/randomIntImpl\(2\)/);
    expect(source).toMatch(/randomIntImpl = randomInt/);
  });
});

describe('/moeda', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expõe o comando com nome e descrição', () => {
    const json = moedaCommand.data.toJSON();

    expect(json.name).toBe('moeda');
    expect(json.description).toBe('Sorteia cara ou coroa com 50% de chance para cada lado.');
    expect(json.options ?? []).toHaveLength(0);
  });

  it('responde publicamente com o embed de cara, sem defer', async () => {
    const spy = vi.spyOn(moedaService, 'flip').mockReturnValue('cara');

    const interaction = createInteraction();
    await moedaCommand.execute(interaction);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledTimes(1);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.content).toBeUndefined();

    const data = payload.embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.title).toBe('🪙 Cara ou Coroa');
    expect(data.author.name).toBe('ChicoBot • Diversão');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.description).toContain('Cara');
    expect(data.description).toContain('DEU CARA, PAE! O destino escolheu! 🐸');
    expect(data.footer.text).toContain('ChicoBot');
    expect(data.footer.text).toContain('50%');
  });

  it('responde publicamente com o embed de coroa', async () => {
    const spy = vi.spyOn(moedaService, 'flip').mockReturnValue('coroa');

    const interaction = createInteraction();
    await moedaCommand.execute(interaction);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledTimes(1);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.title).toBe('🪙 Cara ou Coroa');
    expect(data.description).toContain('Coroa');
    expect(data.description).toContain('DEU COROA! O Chico não erra... só sorteia! KKKKK');
  });

  it('executa sem chamadas de rede, banco ou APIs externas', async () => {
    vi.spyOn(moedaService, 'flip').mockReturnValue('cara');

    const interaction = createInteraction();
    await moedaCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(Object.keys(interaction.reply.mock.calls[0][0])).toEqual(['embeds']);
  });
});

describe('buildMoedaEmbed', () => {
  it('resultado desconhecido cai para "cara"', () => {
    const embed = buildMoedaEmbed({ result: 'invalido' });
    const data = embed.toJSON();

    expect(data.description).toContain('Cara');
  });

  it('funciona sem client (sem ícone do autor)', () => {
    const embed = buildMoedaEmbed({ result: 'coroa' });
    const data = embed.toJSON();

    expect(data.author.name).toBe('ChicoBot • Diversão');
    expect(data.author.icon_url).toBeUndefined();
  });
});
