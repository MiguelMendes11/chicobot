import MusicRegistry from '../../src/services/music/registry.js';
import GuildMusicSession from '../../src/services/music/session.js';
import {
  createFakePlayer,
  createFakeConnection,
  fakeAdapterCreator,
  createTrackStub,
} from './fakes.js';

function createHarness(options = {}) {
  const registry = options.registry || new MusicRegistry();
  const player = options.player || createFakePlayer();
  const resources = [];

  const createResource =
    options.createResource ||
    (async (track) => {
      resources.push(track);
      return { resource: { trackId: track.id }, kill() {} };
    });

  const joinCalls = [];

  const joinVoiceChannel =
    options.joinVoiceChannel ||
    ((joinOptions) => {
      joinCalls.push(joinOptions);
      return createFakeConnection({
        guildId: joinOptions.guildId,
        channelId: joinOptions.channelId,
      });
    });

  const session = registry.getOrCreate(
    options.guildId || 'g1',
    (guildId) =>
      new GuildMusicSession(guildId, {
        registry,
        player,
        createResource,
        adapterCreator: options.adapterCreator === undefined ? fakeAdapterCreator : options.adapterCreator,
        joinVoiceChannel,
        targetChannelId: options.targetChannelId || 'vc1',
        textChannelId: options.textChannelId || null,
        hooks: options.hooks,
      })
  );

  return { registry, player, session, resources, joinCalls, joinVoiceChannel, createResource };
}

export { createHarness, createTrackStub };
