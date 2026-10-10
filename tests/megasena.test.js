import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import megasena from '../src/commands/megasena.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const generator = nodeRequire('../src/services/megasena/generator.js');

function createInteraction({ subcommand = 'jogo' } = {}) {
  return {
    deferred: false,
    replied: false,
    inGuild: () => true,
    guildId: 'g1',
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    client: {
      user: {
        tag: 'ChicoBot#0001',
        displayAvatarURL: () => 'https://cdn.example/chicobot.png',
      },
    },
    options: {
      getSubcommand: vi.fn(() => subcommand),
    },
    reply: vi.fn(async () => {}),
  };
}

describe('megasena generator', () => {
  it('gera exatamente 6 dezenas únicas entre 1 e 60', () => {
    const dezenas = generator.generateDezenas();

    expect(dezenas).toHaveLength(6);
    expect(new Set(dezenas).size).toBe(6);
    for (const dezena of dezenas) {
      expect(Number.isInteger(dezena)).toBe(true);
      expect(dezena).toBeGreaterThanOrEqual(1);
      expect(dezena).toBeLessThanOrEqual(60);
    }
  });

  it('retorna as dezenas em ordem crescente', () => {
    const dezenas = generator.generateDezenas();

    const sorted = [...dezenas].sort((a, b) => a - b);
    expect(dezenas).toEqual(sorted);
  });

  it('mantém invariantes em múltiplas gerações', () => {
    for (let i = 0; i < 100; i += 1) {
      const dezenas = generator.generateDezenas();

      expect(dezenas).toHaveLength(6);
      expect(new Set(dezenas).size).toBe(6);
      expect(dezenas.every((d) => Number.isInteger(d) && d >= 1 && d <= 60)).toBe(true);
      expect(dezenas).toEqual([...dezenas].sort((a, b) => a - b));
    }
  });

  it('usa a função injetada de forma determinística (RNG sempre no início)', () => {
    const fakeRandomInt = vi.fn(() => 0);
    const dezenas = generator.generateDezenas(fakeRandomInt);

    expect(fakeRandomInt).toHaveBeenCalledTimes(6);
    expect(dezenas).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('RNG sempre no fim move o último elemento para a frente do sorteio', () => {
    const fakeRandomInt = vi.fn((max) => max - 1);
    const dezenas = generator.generateDezenas(fakeRandomInt);

    expect(dezenas).toEqual([1, 2, 3, 4, 5, 60]);
  });
});

describe('/megasena jogo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expõe o comando com os subcomandos jogo e resultado', () => {
    const json = megasena.data.toJSON();

    expect(json.name).toBe('megasena');
    expect(json.options).toHaveLength(2);
    expect(json.options[0].name).toBe('jogo');
    expect(json.options[0].type).toBe(1);
    expect(json.options[1].name).toBe('resultado');
    expect(json.options[1].type).toBe(1);
  });

  it('responde com embed público contendo as 6 dezenas, cor, autor e aviso', async () => {
    const spy = vi.spyOn(generator, 'generateDezenas').mockReturnValue([1, 7, 22, 35, 48, 60]);

    const interaction = createInteraction();
    await megasena.execute(interaction);

    expect(interaction.options.getSubcommand).toHaveBeenCalledWith();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledTimes(1);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.content).toBeUndefined();

    const data = payload.embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.author.name).toBe('ChicoBot • Mega-Sena');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.description).toContain('01  07  22  35  48  60');
    expect(data.footer.text).toContain('diversão apenas');
    expect(data.footer.text).toContain('números aleatórios');
    expect(data.footer.text).toContain('sem garantia de prêmio');
  });

  it('sem subcomando jogo não responde nada', async () => {
    const spy = vi.spyOn(generator, 'generateDezenas');

    const interaction = createInteraction({ subcommand: 'outro' });
    await megasena.execute(interaction);

    expect(spy).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
