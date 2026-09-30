import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHarness } from './helpers/harness.js';
import {
  createFakeConnection,
  createFakeChannel,
  createVoiceState,
  createTrackStub,
  fakeClient,
  settle,
} from './helpers/fakes.js';

async function flush(session) {
  await settle();
  await session._chain;
  await settle();
}

describe('voiceStateUpdate — ciclo de vida do canal', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup() {
    const harness = createHarness();
    const connection = createFakeConnection({ status: 'ready', channelId: 'vc1' });
    harness.session.attachConnection(connection);
    harness.connection = connection;
    return harness;
  }

  it('remoção manual do bot destrói sessão e fila, sem reconexão', async () => {
    const { session, registry, connection, joinMock } = setup();

    await session.add(createTrackStub());
    await settle();

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: 'vc1' }),
      createVoiceState({ id: 'bot-1', channelId: null })
    );
    await flush(session);

    expect(session.destroyed).toBe(true);
    expect(registry.get('g1')).toBeNull();
    expect(connection.destroyCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('removido do canal'))).toBe(true);

    connection.setStatus('disconnected');
    expect(vi.getTimerCount()).toBe(0);
    if (joinMock) expect(joinMock).not.toHaveBeenCalled();
  });

  it('bot movido para outro canal destrói a sessão', async () => {
    const { session, registry } = setup();

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: 'vc1' }),
      createVoiceState({ id: 'bot-1', channelId: 'vc2' })
    );
    await flush(session);

    expect(session.destroyed).toBe(true);
    expect(registry.get('g1')).toBeNull();
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('movido de canal'))).toBe(true);
  });

  it('entrada do bot (nossa ação) não destrói a sessão', async () => {
    const { session } = setup();

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: null }),
      createVoiceState({ id: 'bot-1', channelId: 'vc1' })
    );
    await flush(session);

    expect(session.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('saiu do canal por nossa ação (/stop) não gera lógica extra', async () => {
    const { session, registry } = setup();

    await session.destroy();
    expect(registry.get('g1')).toBeNull();

    const timerCount = vi.getTimerCount();

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-1', channelId: 'vc1' }),
      createVoiceState({ id: 'bot-1', channelId: null })
    );
    await flush(session);

    expect(vi.getTimerCount()).toBe(timerCount);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('removido do canal'))).toBe(false);
  });

  it('canal sem humanos agenda desconexão em 60s e desconecta ao expirar', async () => {
    const { session, registry } = setup();
    const emptyChannel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel: emptyChannel }),
      createVoiceState({ id: 'human-0', channelId: null, channel: null })
    );

    expect(vi.getTimerCount()).toBe(1);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('desconectando em 60s'))).toBe(true);
    expect(session.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(59000);
    expect(session.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    await flush(session);

    expect(session.destroyed).toBe(true);
    expect(registry.get('g1')).toBeNull();
  });

  it('entrada de humano durante a tolerância cancela a desconexão', async () => {
    const { session } = setup();
    const channel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel }),
      createVoiceState({ id: 'human-0', channelId: null })
    );
    expect(vi.getTimerCount()).toBe(1);

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-1', channelId: null }),
      createVoiceState({ id: 'human-1', channelId: 'vc1', channel: createFakeChannel({ humans: 1 }) })
    );
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120000);
    await flush(session);

    expect(session.destroyed).toBe(false);
  });

  it('outro bot no canal não impede a desconexão (só humanos contam)', async () => {
    const { session } = setup();
    const channel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'bot-2', channelId: 'vc1', channel }),
      createVoiceState({ id: 'bot-2', channelId: null })
    );

    expect(vi.getTimerCount()).toBe(1);
    expect(session.destroyed).toBe(false);
  });

  it('canal sem informação de membros não agenda (fail-safe)', async () => {
    const { session } = setup();
    const channelWithoutMembers = { id: 'vc1' };

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel: channelWithoutMembers }),
      createVoiceState({ id: 'human-0', channelId: null })
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(session.destroyed).toBe(false);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('não agendada'))).toBe(true);
  });

  it('reavaliação no expiry: humano voltou sem evento cancela a desconexão', async () => {
    const { session } = setup();
    const channel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel }),
      createVoiceState({ id: 'human-0', channelId: null })
    );
    expect(vi.getTimerCount()).toBe(1);

    channel.members.set('human-9', { id: 'human-9', user: { id: 'human-9', bot: false } });

    await vi.advanceTimersByTimeAsync(61000);
    await flush(session);

    expect(session.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('/stop durante a tolerância limpa o timer', async () => {
    const { session, registry } = setup();
    const channel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel }),
      createVoiceState({ id: 'human-0', channelId: null })
    );
    expect(vi.getTimerCount()).toBe(1);

    await session.destroy();

    expect(registry.get('g1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('/play durante a tolerância cancela a desconexão automática', async () => {
    const { session } = setup();
    const channel = createFakeChannel({ humans: 0, bots: 1 });

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'vc1', channel }),
      createVoiceState({ id: 'human-0', channelId: null })
    );
    expect(vi.getTimerCount()).toBe(1);

    await session.add(createTrackStub());
    await settle();

    expect(vi.getTimerCount()).toBe(0);
    expect(session.destroyed).toBe(false);
  });

  it('sem sessão destruída, evento de outro canal não agenda nada', () => {
    const { session } = setup();

    session.handleVoiceStateUpdate(
      fakeClient,
      createVoiceState({ id: 'human-0', channelId: 'other', channel: createFakeChannel({ id: 'other', humans: 0 }) }),
      createVoiceState({ id: 'human-0', channelId: null })
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(session.destroyed).toBe(false);
  });
});
