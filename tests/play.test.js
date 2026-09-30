import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { settle } from './helpers/fakes.js';
import play from '../src/commands/play.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const music = nodeRequire('../src/services/music/index.js');
const source = nodeRequire('../src/services/music/source/index.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');

function createInteraction() {
  const interaction = {
    deferred: false,
    replied: false,
    inGuild: () => true,
    guildId: 'g1',
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    options: { getString: () => 'música qualquer' },
    member: {
      voice: {
        channel: {
          id: 'vc1',
          type: 2,
          permissionsFor: () => ({ has: () => true }),
        },
      },
    },
    guild: {
      voiceAdapterCreator: () => ({ send: () => {}, destroy: () => {} }),
      members: { me: { id: 'bot-1' } },
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };

  return interaction;
}

describe('/play', () => {
  let order;

  beforeEach(() => {
    order = [];

    vi.spyOn(music, 'getSession').mockImplementation(() => null);
    vi.spyOn(music, 'join').mockImplementation(async () => {
      order.push('join');
    });
    vi.spyOn(music, 'add').mockImplementation(async () => {
      order.push('add');
      return { started: true, position: 1, queueLength: 1 };
    });
    vi.spyOn(source, 'resolveQuery').mockImplementation(async () => {
      order.push('resolve');
      return {
        id: 'track-1',
        title: 'Música de teste',
        url: 'https://www.youtube.com/watch?v=track-1',
        duration: 180,
        source: 'youtube',
        requestedBy: 'tester#0001',
      };
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolve → join → add, com as mensagens originais', async () => {
    const interaction = createInteraction();

    await play.execute(interaction);

    expect(order).toEqual(['resolve', 'join', 'add']);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenNthCalledWith(1, { content: '🔍 Buscando música no YouTube…' });
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('▶️ Tocando agora:') })
    );
    expect(console.log.mock.calls.some((args) => String(args[0]).includes('[timing]'))).toBe(false);
  });

  it('não entra no canal quando a busca falha', async () => {
    source.resolveQuery.mockImplementationOnce(async () => {
      throw createMusicError('NO_RESULTS');
    });

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(music.join).not.toHaveBeenCalled();
    expect(music.add).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: 'Nenhum resultado encontrado para essa busca.',
    });
  });

  it('falha de conexão não chama add e reporta CONNECTION_TIMEOUT', async () => {
    music.join.mockImplementationOnce(async () => {
      order.push('join');
      throw createMusicError('CONNECTION_TIMEOUT');
    });

    const interaction = createInteraction();
    await play.execute(interaction);

    expect(order).toEqual(['resolve', 'join']);
    expect(music.add).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: 'Não foi possível conectar ao canal de voz a tempo. Tente novamente.',
    });
  });

  it('aguarda o join concluir antes de chamar add', async () => {
    let releaseJoin;
    music.join.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseJoin = () => {
            order.push('join');
            resolve();
          };
        })
    );

    const interaction = createInteraction();
    const execution = play.execute(interaction);

    await settle();
    expect(order).toEqual(['resolve']);
    expect(music.add).not.toHaveBeenCalled();

    releaseJoin();
    await execution;

    expect(order).toEqual(['resolve', 'join', 'add']);
  });

  it('faixa enfileirada responde com a posição na fila (regressão)', async () => {
    music.add.mockImplementationOnce(async () => {
      order.push('add');
      return { started: false, position: 3, queueLength: 5 };
    });

    const interaction = createInteraction();
    await play.execute(interaction);

    const lastCall = interaction.editReply.mock.calls.at(-1)[0];
    expect(lastCall.content).toContain('Adicionada na fila na posição **3**');
    expect(lastCall.content).toContain('fila com 5 música(s)');
  });

  it('MUSIC_DEBUG_TIMING=true emite a linha de timing no console', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');
    music.add.mockImplementationOnce(async () => {
      order.push('add');
      return { started: false, position: 1, queueLength: 1 };
    });

    const interaction = createInteraction();
    await play.execute(interaction);
    await settle();

    const timingLines = console.log.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('[timing]'));

    expect(timingLines).toHaveLength(1);
    expect(timingLines[0]).toContain('guild=g1');
    expect(timingLines[0]).toMatch(/resolve=\d+ms/);
    expect(timingLines[0]).toContain('join=n/a');
    expect(timingLines[0]).toMatch(/total=\d+ms/);
  });
});
