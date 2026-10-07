import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));

const music = nodeRequire('../src/services/music/index.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');
const loop = nodeRequire('../src/commands/loop.js');
const shuffle = nodeRequire('../src/commands/shuffle.js');
const remove = nodeRequire('../src/commands/remove.js');
const clear = nodeRequire('../src/commands/clear.js');
const move = nodeRequire('../src/commands/move.js');
const queue = nodeRequire('../src/commands/queue.js');
const nowplaying = nodeRequire('../src/commands/nowplaying.js');

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

function createInteraction({ inGuild = true, options = {}, memberChannelId = 'vc1' } = {}) {
  return {
    deferred: false,
    replied: false,
    inGuild: () => inGuild,
    guildId: inGuild ? 'g1' : null,
    channelId: 'text-1',
    user: { tag: 'tester#0001' },
    guild: { name: 'Servidor Chico' },
    client: {
      user: {
        tag: 'ChicoBot#0001',
        displayAvatarURL: () => 'https://cdn.example/chicobot.png',
      },
    },
    member: { voice: { channel: { id: memberChannelId, type: 2 } } },
    options: {
      getString: vi.fn((name) => (name in options ? options[name] : null)),
      getInteger: vi.fn((name) => (name in options ? options[name] : null)),
    },
    reply: vi.fn(async () => {}),
  };
}

function createSessionStub({
  loopMode = 'off',
  state = 'playing',
  current = currentTrack,
  queue = createUpcoming(3),
  snapshotLoopMode = undefined,
} = {}) {
  const session = {
    guildId: 'g1',
    destroyed: false,
    state,
    channelId: 'vc1',
    textChannelId: 'text-1',
    loopMode,
    current,
    queue,
    queueLength: queue.length,
    snapshot: vi.fn(() => ({
      guildId: 'g1',
      state,
      current,
      queue,
      queueLength: queue.length,
      channelId: 'vc1',
      textChannelId: 'text-1',
      destroyed: false,
      loopMode: snapshotLoopMode === undefined ? session.loopMode : snapshotLoopMode,
      progress: { positionSeconds: 20, durationSeconds: 200, percent: 10 },
    })),
  };

  session.setLoop = vi.fn(async (mode) => {
    const previous = session.loopMode;
    session.loopMode = mode;
    return { mode, previous, changed: mode !== previous };
  });
  session.shuffle = vi.fn(async () => {
    if (queue.length === 0) throw createMusicError('NO_NEXT_TRACK');
    return { shuffled: queue.length, queueLength: queue.length };
  });
  session.removeAt = vi.fn(async (position) => {
    if (queue.length === 0) throw createMusicError('NO_NEXT_TRACK');
    if (!Number.isInteger(position) || position < 1 || position > queue.length) {
      throw createMusicError('INVALID_POSITION', { details: `a fila tem ${queue.length} música(s)` });
    }
    return { track: queue[position - 1], position, queueLength: queue.length - 1 };
  });
  session.clearUpcoming = vi.fn(async () => {
    if (queue.length === 0) throw createMusicError('NO_NEXT_TRACK');
    return { removed: queue.length, queueLength: 0 };
  });
  session.moveTrack = vi.fn(async (from, to) => {
    if (queue.length === 0) throw createMusicError('NO_NEXT_TRACK');
    if (!Number.isInteger(from) || from < 1 || from > queue.length) {
      throw createMusicError('INVALID_POSITION', { details: `a fila tem ${queue.length} música(s)` });
    }
    if (!Number.isInteger(to) || to < 1 || to > queue.length) {
      throw createMusicError('INVALID_POSITION', { details: `a fila tem ${queue.length} música(s)` });
    }
    return { track: queue[from - 1], from, to, queueLength: queue.length };
  });

  return session;
}

function lastReply(interaction) {
  return interaction.reply.mock.calls.at(-1)[0];
}

describe('Stage 9 — /loop', () => {
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
    await loop.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Nada está tocando neste servidor.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('sessão destruída também responde NO_PLAYBACK efêmero', async () => {
    music.getSession.mockImplementation(() => ({ destroyed: true }));

    const interaction = createInteraction();
    await loop.execute(interaction);

    expect(lastReply(interaction).content).toBe('Nada está tocando neste servidor.');
  });

  it('fora de um servidor responde NOT_IN_GUILD efêmero', async () => {
    const interaction = createInteraction({ inGuild: false });
    await loop.execute(interaction);

    expect(music.getSession).not.toHaveBeenCalled();
    expect(lastReply(interaction).content).toBe('Este comando só pode ser usado dentro de um servidor.');
  });

  it('sem mode cicla off → track → queue → off', async () => {
    const session = createSessionStub({ loopMode: 'off' });
    music.getSession.mockImplementation(() => session);

    const first = createInteraction();
    await loop.execute(first);
    expect(session.setLoop).toHaveBeenNthCalledWith(1, 'track');
    expect(lastReply(first).content).toContain('Loop: música');
    expect(lastReply(first).flags).toBe(MessageFlags.Ephemeral);

    const second = createInteraction();
    await loop.execute(second);
    expect(session.setLoop).toHaveBeenNthCalledWith(2, 'queue');
    expect(lastReply(second).content).toContain('Loop: fila');

    const third = createInteraction();
    await loop.execute(third);
    expect(session.setLoop).toHaveBeenNthCalledWith(3, 'off');
    expect(lastReply(third).content).toContain('Loop desligado');

    const fourth = createInteraction();
    await loop.execute(fourth);
    expect(session.setLoop).toHaveBeenNthCalledWith(4, 'track');
  });

  it('com mode explícito define o modo pedido sem ciclar', async () => {
    const session = createSessionStub({ loopMode: 'track' });
    music.getSession.mockImplementation(() => session);

    const interaction = createInteraction({ options: { mode: 'queue' } });
    await loop.execute(interaction);

    expect(session.setLoop).toHaveBeenCalledWith('queue');
    expect(lastReply(interaction).content).toContain('Loop: fila');
  });

  it('em canal de voz diferente responde WRONG_VOICE_CHANNEL efêmero', async () => {
    const session = createSessionStub();
    music.getSession.mockImplementation(() => session);

    const interaction = createInteraction({ memberChannelId: 'vc2' });
    await loop.execute(interaction);

    expect(session.setLoop).not.toHaveBeenCalled();
    expect(lastReply(interaction).content).toBe('Você precisa estar no mesmo canal de voz que o bot.');
  });

  it('erro inesperado não é engolido pelo handler', async () => {
    music.getSession.mockImplementation(() => {
      throw new Error('boom');
    });

    const interaction = createInteraction();
    const error = await loop.execute(interaction).catch((caught) => caught);

    expect(error.message).toBe('boom');
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('Stage 9 — /shuffle', () => {
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

  it('responde efêmero informando quantas músicas foram embaralhadas', async () => {
    const session = createSessionStub({ queue: createUpcoming(4) });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction();
    await shuffle.execute(interaction);

    expect(session.shuffle).toHaveBeenCalledTimes(1);
    expect(lastReply(interaction).content).toBe(
      '🔀 **Fila embaralhada.** 4 música(s) reordenadas (a música atual não mudou).'
    );
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });

  it('fila vazia responde NO_NEXT_TRACK efêmero', async () => {
    const session = createSessionStub();
    session.shuffle.mockImplementation(async () => {
      throw createMusicError('NO_NEXT_TRACK');
    });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction();
    await shuffle.execute(interaction);

    expect(lastReply(interaction).content).toBe('A fila está vazia; não existe próxima música.');
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });
});

describe('Stage 9 — /remove', () => {
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

  it('responde efêmero com a faixa removida e o total restante', async () => {
    const session = createSessionStub({ queue: createUpcoming(3) });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction({ options: { position: 2 } });
    await remove.execute(interaction);

    expect(session.removeAt).toHaveBeenCalledWith(2);

    const payload = lastReply(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain('🗑️ Removida');
    expect(payload.content).toContain('Próxima 2');
    expect(payload.content).toContain('posição 2');
    expect(payload.content).toContain('Restam 2 na fila.');
  });

  it('posição inválida responde INVALID_POSITION efêmero', async () => {
    const session = createSessionStub();
    session.removeAt.mockImplementation(async () => {
      throw createMusicError('INVALID_POSITION', { details: 'a fila tem 3 música(s)' });
    });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction({ options: { position: 9 } });
    await remove.execute(interaction);

    expect(lastReply(interaction).content).toBe('Posição inválida na fila. (a fila tem 3 música(s))');
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });
});

describe('Stage 9 — /clear', () => {
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

  it('responde efêmero com a quantidade removida', async () => {
    const session = createSessionStub({ queue: createUpcoming(5) });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction();
    await clear.execute(interaction);

    expect(session.clearUpcoming).toHaveBeenCalledTimes(1);
    expect(lastReply(interaction).content).toBe(
      '🧹 **Fila limpa.** 5 música(s) removida(s); a música atual continua tocando.'
    );
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });

  it('fila vazia responde NO_NEXT_TRACK efêmero', async () => {
    const session = createSessionStub({ queue: [] });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction();
    await clear.execute(interaction);

    expect(lastReply(interaction).content).toBe('A fila está vazia; não existe próxima música.');
  });
});

describe('Stage 9 — /move', () => {
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

  it('responde efêmero com origem e destino', async () => {
    const session = createSessionStub({ queue: createUpcoming(5) });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction({ options: { from: 4, to: 1 } });
    await move.execute(interaction);

    expect(session.moveTrack).toHaveBeenCalledWith(4, 1);
    expect(lastReply(interaction).content).toBe(
      '↕️ **[Próxima 4](https://www.youtube.com/watch?v=q4)** (1:43) movida da posição 4 para 1.'
    );
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });

  it('posições inválidas respondem INVALID_POSITION efêmero', async () => {
    const session = createSessionStub({ queue: createUpcoming(2) });
    session.moveTrack.mockImplementation(async () => {
      throw createMusicError('INVALID_POSITION', { details: 'a fila tem 2 música(s)' });
    });
    music.requireSession.mockImplementation(() => session);

    const interaction = createInteraction({ options: { from: 1, to: 9 } });
    await move.execute(interaction);

    expect(lastReply(interaction).content).toBe('Posição inválida na fila. (a fila tem 2 música(s))');
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });

  it('sem sessão responde NO_PLAYBACK efêmero', async () => {
    const interaction = createInteraction({ options: { from: 1, to: 2 } });
    await move.execute(interaction);

    expect(lastReply(interaction).content).toBe('Nada está tocando neste servidor.');
    expect(lastReply(interaction).flags).toBe(MessageFlags.Ephemeral);
  });
});

describe('Stage 9 — /queue e /nowplaying exibem o modo de loop', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(music, 'getSession').mockImplementation(() => null);
    vi.spyOn(music, 'requireSession').mockImplementation(() => {
      throw createMusicError('NO_PLAYBACK');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('/queue mostra loop discreto no rodapé quando diferente de off', async () => {
    music.getSession.mockImplementation(() => createSessionStub({ loopMode: 'queue' }));

    const interaction = createInteraction();
    await queue.execute(interaction);

    const data = lastReply(interaction).embeds[0].toJSON();
    expect(data.footer.text).toBe('ChicoBot • 3 na fila • mostrando 3 • loop: fila');
    expect(data.color).toBe(0x3b82f6);
  });

  it('/queue mantém o rodapé original quando o loop está off', async () => {
    music.getSession.mockImplementation(() => createSessionStub({ loopMode: 'off' }));

    const interaction = createInteraction();
    await queue.execute(interaction);

    const data = lastReply(interaction).embeds[0].toJSON();
    expect(data.footer.text).toBe('ChicoBot • 3 na fila • mostrando 3');
  });

  it('/nowplaying mostra o modo de loop quando diferente de off', async () => {
    music.requireSession.mockImplementation(() =>
      createSessionStub({ loopMode: 'track', queue: createUpcoming(2) })
    );

    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    const data = lastReply(interaction).embeds[0].toJSON();
    expect(data.footer.text).toBe('ChicoBot • 2 na fila • loop: música');
    expect(data.color).toBe(0x3b82f6);
  });

  it('/nowplaying mantém o rodapé original quando o loop está off', async () => {
    music.requireSession.mockImplementation(() =>
      createSessionStub({ loopMode: 'off', queue: createUpcoming(2) })
    );

    const interaction = createInteraction();
    await nowplaying.execute(interaction);

    const data = lastReply(interaction).embeds[0].toJSON();
    expect(data.footer.text).toBe('ChicoBot • 2 na fila');
  });
});

describe('Stage 9 — registro dos novos comandos', () => {
  it('exporta data e execute com os nomes esperados', () => {
    for (const [command, name] of [
      [loop, 'loop'],
      [shuffle, 'shuffle'],
      [remove, 'remove'],
      [clear, 'clear'],
      [move, 'move'],
    ]) {
      expect(typeof command.execute).toBe('function');
      expect(command.data.name).toBe(name);
      expect(command.data.toJSON().dm_permission).not.toBe(false);
    }
  });

  it('/remove e /move exigem posições inteiras a partir de 1', () => {
    const removeJson = remove.data.toJSON();
    const moveJson = move.data.toJSON();

    const position = removeJson.options.find((option) => option.name === 'position');
    expect(position.required).toBe(true);
    expect(position.min_value).toBe(1);

    for (const name of ['from', 'to']) {
      const option = moveJson.options.find((entry) => entry.name === name);
      expect(option.required).toBe(true);
      expect(option.min_value).toBe(1);
    }
  });

  it('/loop aceita mode opcional com as três escolhas', () => {
    const json = loop.data.toJSON();
    const mode = json.options.find((option) => option.name === 'mode');

    expect(mode.required).toBe(false);
    expect(mode.choices.map((choice) => choice.value)).toEqual(['off', 'track', 'queue']);
  });
});
