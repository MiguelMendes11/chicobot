import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { settle, createTrackStub } from './helpers/fakes.js';
import play from '../src/commands/play.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const music = nodeRequire('../src/services/music/index.js');
const source = nodeRequire('../src/services/music/source/index.js');
const ytdlp = nodeRequire('../src/services/music/source/ytdlp.js');
const { createMusicError } = nodeRequire('../src/services/music/errors.js');

const createdFiles = [];

function createHarnessInteraction({ holdDefer = false, holdStatus = false, failDefer = false } = {}) {
  const events = [];
  let releaseDefer = null;
  let releaseStatus = null;

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
      events.push('defer.begin');

      if (failDefer) {
        events.push('defer.fail');
        throw createMusicError('CONNECTION_TIMEOUT');
      }

      if (holdDefer) {
        await new Promise((resolve) => {
          releaseDefer = () => {
            interaction.deferred = true;
            events.push('defer.end');
            resolve();
          };
        });
      } else {
        interaction.deferred = true;
        events.push('defer.end');
      }
    }),
    editReply: vi.fn(async (payload) => {
      const isStatus = payload && typeof payload.content === 'string' && payload.content.includes('Buscando');

      if (isStatus) {
        events.push('status.begin');

        if (holdStatus) {
          await new Promise((resolve) => {
            releaseStatus = () => {
              events.push('status.end');
              resolve();
            };
          });
        } else {
          events.push('status.end');
        }

        return;
      }

      events.push('final');
    }),
    reply: vi.fn(async () => {
      events.push('reply');
    }),
  };

  return {
    interaction,
    events,
    flushDefer: () => {
      if (releaseDefer) releaseDefer();
    },
    flushStatus: () => {
      if (releaseStatus) releaseStatus();
    },
  };
}

describe('/play — concorrência do novo fluxo', () => {
  let order;

  beforeEach(() => {
    order = [];

    vi.spyOn(music, 'getSession').mockImplementation(() => null);
    vi.spyOn(music, 'join').mockImplementation(async () => {
      order.push('join');
    });
    vi.spyOn(music, 'add').mockImplementation(async () => {
      order.push('add');
      return { started: false, position: 1, queueLength: 1 };
    });
    vi.spyOn(source, 'resolveQuery').mockImplementation(async () => {
      order.push('resolve');
      return createTrackStub();
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();

    for (const file of createdFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  });

  it('inicia resolveQuery sem esperar o defer nem a segunda REST', async () => {
    const harness = createHarnessInteraction({ holdDefer: true, holdStatus: true });

    const execution = play.execute(harness.interaction);
    await settle();

    expect(source.resolveQuery).toHaveBeenCalledTimes(1);
    expect(harness.interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(harness.interaction.editReply).not.toHaveBeenCalled();
    expect(harness.events).toEqual(['defer.begin']);

    harness.flushDefer();
    await settle();

    expect(source.resolveQuery).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['defer.begin', 'defer.end', 'status.begin']);

    harness.flushStatus();
    await execution;

    expect(order).toEqual(['resolve', 'join', 'add']);
  });

  it('nenhum editReply acontece antes de deferReply concluir', async () => {
    const harness = createHarnessInteraction({ holdDefer: true, holdStatus: true });

    const execution = play.execute(harness.interaction);
    await settle();

    expect(harness.interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(harness.interaction.editReply).not.toHaveBeenCalled();

    harness.flushDefer();
    await settle();

    expect(harness.events.indexOf('defer.end')).toBeLessThan(harness.events.indexOf('status.begin'));

    harness.flushStatus();
    await execution;

    expect(harness.events.indexOf('defer.end')).toBeLessThan(harness.events.indexOf('final'));
    expect(harness.interaction.deferred).toBe(true);
  });

  it('erro de resolve com defer pendente aguarda o defer e responde via editReply', async () => {
    source.resolveQuery.mockImplementationOnce(async () => {
      order.push('resolve');
      throw createMusicError('NO_RESULTS');
    });

    const harness = createHarnessInteraction({ holdDefer: true, holdStatus: true });

    const execution = play.execute(harness.interaction);
    await settle();

    expect(harness.interaction.editReply).not.toHaveBeenCalled();
    expect(music.join).not.toHaveBeenCalled();

    harness.flushDefer();
    await settle();

    expect(music.join).not.toHaveBeenCalled();

    harness.flushStatus();
    await execution;

    expect(music.join).not.toHaveBeenCalled();
    expect(music.add).not.toHaveBeenCalled();
    expect(harness.interaction.deferred).toBe(true);
    expect(harness.interaction.editReply).toHaveBeenLastCalledWith({
      content: 'Nenhum resultado encontrado para essa busca.',
    });
  });

  it('sem race: a resposta final só sai depois do status inicial concluir', async () => {
    const harness = createHarnessInteraction({ holdStatus: true });

    const execution = play.execute(harness.interaction);
    await settle();

    expect(harness.events).toEqual(['defer.begin', 'defer.end', 'status.begin']);
    expect(harness.interaction.editReply).toHaveBeenCalledTimes(1);

    harness.flushStatus();
    await execution;

    expect(harness.events).toEqual(['defer.begin', 'defer.end', 'status.begin', 'status.end', 'final']);

    const payloads = harness.interaction.editReply.mock.calls.map((call) => call[0]);
    expect(payloads[0].content).toContain('Buscando');
    expect(payloads.at(-1).embeds).toHaveLength(1);
    expect(harness.interaction.deferred).toBe(true);
  });

  it('quando o fluxo aborta antes de consumir o resolve, o infoFile é liberado', async () => {
    const infoFile = ytdlp.createInfoFile({
      id: 'leak-1',
      title: 'Faixa de teste',
      webpage_url: 'https://www.youtube.com/watch?v=leak-1',
    });
    createdFiles.push(infoFile);

    const track = createTrackStub({ infoFile });
    let releaseResolve;

    source.resolveQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push('resolve');
          releaseResolve = () => resolve(track);
        })
    );

    const harness = createHarnessInteraction({ failDefer: true });

    await play.execute(harness.interaction);

    expect(harness.interaction.reply).toHaveBeenCalledTimes(1);
    expect(music.join).not.toHaveBeenCalled();
    expect(fs.existsSync(infoFile)).toBe(true);

    releaseResolve();

    await vi.waitFor(() => {
      expect(fs.existsSync(infoFile)).toBe(false);
    });
    expect(track.infoFile).toBeNull();
  });

  it('MUSIC_DEBUG_TIMING=true mede ack, status e resolve do novo fluxo', async () => {
    vi.stubEnv('MUSIC_DEBUG_TIMING', 'true');

    const harness = createHarnessInteraction();
    await play.execute(harness.interaction);
    await settle();

    const line = console.log.mock.calls
      .map((args) => String(args[0]))
      .find((entry) => entry.includes('[timing]'));

    expect(line).toBeTruthy();
    expect(line).toMatch(/guild=g1/);
    expect(line).toMatch(/ack=\d+ms/);
    expect(line).toMatch(/status=\d+ms/);
    expect(line).toMatch(/resolve=\d+ms/);
    expect(line).toMatch(/total=\d+ms/);
  });

  it('sem MUSIC_DEBUG_TIMING não há linha de timing e o fluxo responde normalmente', async () => {
    const harness = createHarnessInteraction();

    await play.execute(harness.interaction);
    await settle();

    expect(console.log.mock.calls.some((args) => String(args[0]).includes('[timing]'))).toBe(false);
    expect(harness.interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(harness.interaction.editReply).toHaveBeenCalledTimes(2);
    expect(harness.events).toEqual(['defer.begin', 'defer.end', 'status.begin', 'status.end', 'final']);
  });
});
