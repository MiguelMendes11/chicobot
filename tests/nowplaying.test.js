import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';
import nowplaying from '../src/commands/nowplaying.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const music = nodeRequire('../src/services/music/index.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');

function createInteraction({ inGuild = true } = {}) {
  return {
    deferred: false,
    replied: false,
    inGuild: () => inGuild,
    guildId: inGuild ? 'g1' : null,
    channelId: 'text-1',
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

function createSessionStub({
  state = 'playing',
  current = {
    id: 'track-1',
    title: 'Faixa de teste',
    url: 'https://www.youtube.com/watch?v=abc123',
    duration: 180,
    requestedBy: 'tester#0001',
    thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
  },
  queue = [],
  queueLength = 0,
  progress = { positionSeconds: 0, durationSeconds: 180, percent: 0 },
} = {}) {
  const snapshotValue = {
    guildId: 'g1',
    state,
    current,
    queue,
    queueLength,
    channelId: 'vc1',
    textChannelId: 'text-1',
    destroyed: false,
    progress,
  };

  return {
    guildId: 'g1',
    destroyed: false,
    state,
    current,
    queue,
    queueLength,
    snapshot: vi.fn(() => ({ ...snapshotValue })),
  };
}

describe('/nowplaying', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(music, 'requireSession').mockImplementation(() => {
      throw createMusicError('NO_PLAYBACK');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sem sessão responde NO_PLAYBACK de forma efêmera', async () => {
    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Nada está tocando neste servidor.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('fora de um servidor responde de forma efêmera', async () => {
    const interaction = createInteraction({ inGuild: false });
    await nowplaying.execute(interaction);

    expect(music.requireSession).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Este comando só pode ser usado dentro de um servidor.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('responde com embed público contendo título, link, thumbnail e progresso', async () => {
    const session = createSessionStub({
      queueLength: 2,
      progress: { positionSeconds: 45, durationSeconds: 180, percent: 25 },
    });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.content).toBeUndefined();

    const data = payload.embeds[0].toJSON();

    expect(data.title).toBe('Faixa de teste');
    expect(data.url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(data.color).toBe(0x3b82f6);
    expect(data.thumbnail.url).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
    expect(data.author.name).toBe('ChicoBot • Tocando agora');
    expect(data.author.icon_url).toBe('https://cdn.example/chicobot.png');
    expect(data.footer.text).toBe('ChicoBot • 2 na fila');

    const progressField = data.fields.find((field) => field.name === '⏱️ Progresso');
    expect(progressField.value).toContain('0:45 / 3:00 • 25%');
    expect(progressField.value.split('\n')[1]).toBe('▬▬▬○○○○○○○○○');

    expect(data.fields.find((field) => field.name === '🎧 Pedido por').value).toBe('tester#0001');
    expect(data.fields.find((field) => field.name === '📋 Fila').value).toBe('2 música(s)');
  });

  it('estado pausado usa a cor cinza e o rótulo Pausado', async () => {
    music.requireSession.mockImplementation(() =>
      createSessionStub({
        state: 'paused',
        progress: { positionSeconds: 90, durationSeconds: 180, percent: 50 },
      })
    );

    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();

    expect(data.color).toBe(0x9aa0a6);
    expect(data.author.name).toBe('ChicoBot • Pausado');
  });

  it('duração desconhecida mostra tempo sem barra de progresso', async () => {
    music.requireSession.mockImplementation(() =>
      createSessionStub({
        current: {
          id: 'track-1',
          title: 'Faixa sem duração',
          url: 'https://www.youtube.com/watch?v=abc123',
          duration: null,
          requestedBy: null,
          thumbnail: null,
        },
        progress: { positionSeconds: 12, durationSeconds: null, percent: null },
      })
    );

    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    const data = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    const value = data.fields.find((field) => field.name === '⏱️ Progresso').value;

    expect(value).toBe('0:12 / —');
    expect(value.split('\n')).toHaveLength(1);
    expect(data.thumbnail).toBeUndefined();
    expect(data.fields.find((field) => field.name === '🎧 Pedido por').value).toBe('—');
  });

  it('erro inesperado não é engolido pelo handler', async () => {
    music.requireSession.mockImplementation(() => {
      throw new Error('boom');
    });

    const interaction = createInteraction();
    const error = await nowplaying.execute(interaction).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
