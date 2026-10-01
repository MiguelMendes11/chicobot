import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';
import queue from '../src/commands/queue.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const music = nodeRequire('../src/services/music/index.js');

function createInteraction() {
  return {
    deferred: false,
    replied: false,
    inGuild: () => true,
    guildId: 'g1',
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    guild: { name: 'Servidor Chico' },
    client: {
      user: {
        tag: 'ChicoBot#0001',
        displayAvatarURL: () => 'https://cdn.example/chicobot.png',
      },
    },
    reply: vi.fn(async () => {}),
  };
}

const currentTrack = {
  id: 'now',
  title: 'Tocando agora',
  url: 'https://www.youtube.com/watch?v=now',
  duration: 200,
  requestedBy: 'pedidor#0001',
  thumbnail: 'https://i.ytimg.com/vi/now/hqdefault.jpg',
};

function createUpcoming(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`,
    title: `Próxima ${index + 1}`,
    url: `https://www.youtube.com/watch?v=q${index + 1}`,
    duration: 100 + index,
    requestedBy: 'outro#0002',
  }));
}

function createSessionStub({
  state = 'playing',
  current = currentTrack,
  queue = [],
  queueLength = queue.length,
  progress = { positionSeconds: 20, durationSeconds: 200, percent: 10 },
} = {}) {
  return {
    guildId: 'g1',
    destroyed: false,
    state,
    current,
    queue,
    queueLength,
    snapshot: vi.fn(() => ({
      guildId: 'g1',
      state,
      current,
      queue,
      queueLength,
      channelId: 'vc1',
      textChannelId: 'text-1',
      destroyed: false,
      progress,
    })),
  };
}

describe('/queue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(music, 'getSession').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sem sessão responde NO_PLAYBACK de forma efêmera', async () => {
    const interaction = createInteraction();
    await queue.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Nada está tocando neste servidor.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('sessão destruída também responde NO_PLAYBACK efêmero', async () => {
    music.getSession.mockImplementation(() => ({ destroyed: true, snapshot: vi.fn() }));

    const interaction = createInteraction();
    await queue.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Nada está tocando neste servidor.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('responde com embed público destacando atual, próximas e rodapé', async () => {
    const upcoming = createUpcoming(12);
    music.getSession.mockImplementation(() => createSessionStub({ queue: upcoming, queueLength: 12 }));

    const interaction = createInteraction();
    await queue.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();

    const data = payload.embeds[0].toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.author.name).toBe('ChicoBot • Fila — Servidor Chico');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.thumbnail.url).toBe('https://i.ytimg.com/vi/now/hqdefault.jpg');
    expect(data.footer.text).toBe('ChicoBot • 12 na fila • mostrando 10');
    expect(data.description).toContain('▶️ **Tocando agora**');
    expect(data.description).toContain('**[Tocando agora](https://www.youtube.com/watch?v=now)** (3:20)');
    expect(data.description).toContain('Pedido por **pedidor#0001**');
    expect(data.description).toContain('0:20 / 3:20 • 10%');
    expect(data.description).toContain('**📋 Próximas**');
    expect(data.description).toContain('1. **[Próxima 1](');
    expect(data.description).toContain('10. **[Próxima 10](');
    expect(data.description).not.toContain('11. **[Próxima 11](');
    expect(data.description).toContain('… e mais 2 na fila.');
  });

  it('fila vazia sem música atual não lança (regressão do crash)', async () => {
    music.getSession.mockImplementation(() =>
      createSessionStub({ state: 'idle', current: null, queue: [], queueLength: 0, progress: null })
    );

    const interaction = createInteraction();

    await expect(queue.execute(interaction)).resolves.not.toThrow();

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();

    expect(data.description).toContain('⏹️ **Nada tocando**');
    expect(data.description).toContain('*Nada na fila.*');
    expect(data.footer.text).toBe('ChicoBot • 0 na fila • mostrando 0');
    expect(data.thumbnail).toBeUndefined();
  });

  it('sessão com fila mas nada tocando ainda lista as próximas', async () => {
    music.getSession.mockImplementation(() =>
      createSessionStub({
        state: 'idle',
        current: null,
        queue: createUpcoming(2),
        queueLength: 2,
        progress: null,
      })
    );

    const interaction = createInteraction();
    await queue.execute(interaction);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();

    expect(data.description).toContain('1. **[Próxima 1](');
    expect(data.description).toContain('2. **[Próxima 2](');
    expect(data.description).not.toContain('… e mais');
  });

  it('estado pausado usa a cor cinza', async () => {
    music.getSession.mockImplementation(() => createSessionStub({ state: 'paused' }));

    const interaction = createInteraction();
    await queue.execute(interaction);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();

    expect(data.color).toBe(0x9aa0a6);
    expect(data.description).toContain('⏸️ **Pausado**');
  });

  it('erro inesperado não é engolido pelo handler', async () => {
    music.getSession.mockImplementation(() => {
      throw new Error('boom');
    });

    const interaction = createInteraction();
    const error = await queue.execute(interaction).catch((caught) => caught);

    expect(error.message).toBe('boom');
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('sem guild não quebra o autor do embed', async () => {
    music.getSession.mockImplementation(() => createSessionStub());
    const interaction = createInteraction();
    interaction.guild = null;

    await queue.execute(interaction);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(data.author.name).toBe('ChicoBot • Fila');
  });
});
