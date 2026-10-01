import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ActivityType } from 'discord.js';

const nodeRequire = createRequire(fileURLToPath(import.meta.url));
const presence = nodeRequire('../src/services/presence.js');

function createClient() {
  return { user: { tag: 'ChicoBot#0001', setPresence: vi.fn() } };
}

function createSessionStub(guildId, overrides = {}) {
  return {
    guildId,
    state: 'playing',
    destroyed: false,
    current: { title: 'Faixa de teste', url: 'https://youtu.be/x', duration: 180 },
    ...overrides,
  };
}

function lastActivity(client) {
  const calls = client.user.setPresence.mock.calls;
  return calls[calls.length - 1][0].activities[0];
}

describe('presença do ChicoBot', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    presence.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    presence.reset();
    vi.restoreAllMocks();
  });

  it('sem client registrado não tenta aplicar presença', () => {
    presence.hooks.onTrackStart(createSessionStub('g1'));

    expect(() => presence.flush()).not.toThrow();
  });

  it('start aplica a presença padrão de imediato', () => {
    const client = createClient();
    presence.start(client);

    expect(client.user.setPresence).toHaveBeenCalledTimes(1);
    expect(client.user.setPresence).toHaveBeenCalledWith({
      status: 'online',
      activities: [{ type: ActivityType.Listening, name: 'ChicoBot • digite /play' }],
    });
  });

  it('faixa ativa vira Listening com apenas o título truncado', () => {
    const client = createClient();
    presence.start(client);

    presence.hooks.onTrackStart(createSessionStub('g1', { current: { title: 'Minha música', url: 'u', duration: 10 } }));
    presence.flush();

    expect(lastActivity(client)).toEqual({ type: ActivityType.Listening, name: 'Minha música' });
  });

  it('título muito longo é truncado em 128 caracteres', () => {
    const client = createClient();
    presence.start(client);

    presence.hooks.onTrackStart(createSessionStub('g1', { current: { title: 'a'.repeat(300), url: 'u', duration: 10 } }));
    presence.flush();

    const activity = lastActivity(client);

    expect(activity.name).toHaveLength(128);
    expect(activity.name.endsWith('…')).toBe(true);
  });

  it('estado pausado usa o prefixo ⏸ no nome da atividade', () => {
    const client = createClient();
    presence.start(client);

    presence.hooks.onTrackStart(
      createSessionStub('g1', { state: 'paused', current: { title: 'Pausada', url: 'u', duration: 10 } })
    );
    presence.flush();

    expect(lastActivity(client).name).toBe('⏸ Pausada');
  });

  it('fim da fila volta para a presença padrão', () => {
    const client = createClient();
    presence.start(client);

    const session = createSessionStub('g1');
    presence.hooks.onTrackStart(session);
    presence.flush();
    presence.hooks.onQueueFinish(session);
    presence.flush();

    expect(lastActivity(client).name).toBe('ChicoBot • digite /play');
  });

  it('destruição da sessão volta para a presença padrão', () => {
    const client = createClient();
    presence.start(client);

    const session = createSessionStub('g1');
    presence.hooks.onTrackStart(session);
    presence.flush();
    presence.hooks.onDestroy(session);
    presence.flush();

    expect(lastActivity(client).name).toBe('ChicoBot • digite /play');
    expect(client.user.setPresence).toHaveBeenCalledTimes(3);
  });

  it('política LIFO: última guild ativa vence e cai para a anterior', () => {
    const client = createClient();
    presence.start(client);

    const g1 = createSessionStub('g1', { current: { title: 'Primeira', url: 'u1', duration: 10 } });
    const g2 = createSessionStub('g2', { current: { title: 'Segunda', url: 'u2', duration: 10 } });

    presence.hooks.onTrackStart(g1);
    presence.flush();
    expect(lastActivity(client).name).toBe('Primeira');

    presence.hooks.onTrackStart(g2);
    presence.flush();
    expect(lastActivity(client).name).toBe('Segunda');

    presence.hooks.onQueueFinish(g2);
    presence.flush();
    expect(lastActivity(client).name).toBe('Primeira');

    presence.hooks.onQueueFinish(g1);
    presence.flush();
    expect(lastActivity(client).name).toBe('ChicoBot • digite /play');
  });

  it('sessão destruída nunca vira dona da presença', () => {
    const client = createClient();
    presence.start(client);

    presence.hooks.onTrackStart(createSessionStub('g1', { destroyed: true }));
    presence.flush();

    expect(lastActivity(client).name).toBe('ChicoBot • digite /play');
  });

  it('notify promove a guild pausada sem duplicar a presença', () => {
    const client = createClient();
    presence.start(client);

    const session = createSessionStub('g1', { state: 'paused', current: { title: 'Pausada', url: 'u', duration: 10 } });
    presence.hooks.onTrackStart(session);
    presence.flush();
    presence.notify(session);
    presence.flush();

    expect(lastActivity(client).name).toBe('⏸ Pausada');
    expect(client.user.setPresence).toHaveBeenCalledTimes(2);
  });

  it('dedupe não reenvia um payload idêntico', () => {
    const client = createClient();
    presence.start(client);

    const session = createSessionStub('g1', { current: { title: 'Única', url: 'u', duration: 10 } });
    presence.hooks.onTrackStart(session);
    presence.flush();
    presence.flush();
    presence.flush();

    expect(client.user.setPresence).toHaveBeenCalledTimes(2);
  });

  it('debounce agrupa várias mudanças em uma única aplicação', async () => {
    vi.useFakeTimers();

    const client = createClient();
    presence.start(client);

    presence.hooks.onTrackStart(createSessionStub('g1', { current: { title: 'A', url: 'u', duration: 10 } }));
    presence.hooks.onTrackStart(createSessionStub('g2', { current: { title: 'B', url: 'u', duration: 10 } }));
    presence.hooks.onTrackStart(createSessionStub('g3', { current: { title: 'C', url: 'u', duration: 10 } }));

    expect(client.user.setPresence).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);

    expect(client.user.setPresence).toHaveBeenCalledTimes(2);
    expect(lastActivity(client).name).toBe('C');
  });

  it('falha ao aplicar presença é registrada sem propagar', () => {
    const client = createClient();
    client.user.setPresence.mockImplementation(() => {
      throw new Error('rate limited');
    });

    presence.start(client);
    presence.hooks.onTrackStart(createSessionStub('g1'));

    expect(() => presence.flush()).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });

  it('reset limpa estado e clientes registrados', () => {
    const client = createClient();
    presence.start(client);
    presence.hooks.onTrackStart(createSessionStub('g1'));
    presence.flush();

    presence.reset();

    const other = createClient();
    presence.start(other);

    expect(other.user.setPresence).toHaveBeenCalledWith({
      status: 'online',
      activities: [{ type: ActivityType.Listening, name: 'ChicoBot • digite /play' }],
    });
  });
});
