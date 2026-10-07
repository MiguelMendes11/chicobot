const { SlashCommandBuilder } = require('discord.js');
const music = require('../services/music');
const source = require('../services/music/source');
const timing = require('../services/music/timing');
const {
  assertInteractionInGuild,
  assertMemberInVoice,
  assertSameVoiceChannel,
  assertBotCanConnect,
} = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { buildNowPlayingEmbed, buildQueuedEmbed } = require('../utils/embeds');

const SEARCHING_CONTENT = '🔍 Buscando música no YouTube…';

function startResolve(query, requestedBy, guildId) {
  return source.resolveQuery(query, { requestedBy }).then(
    (track) => {
      timing.mark(guildId, 'resolve.end');
      return { ok: true, track };
    },
    (error) => {
      timing.mark(guildId, 'resolve.end');
      return { ok: false, error };
    }
  );
}

function releaseAbandonedTrack(outcomePromise) {
  outcomePromise
    .then((outcome) => {
      if (outcome && outcome.ok) return source.releaseTrackInfo(outcome.track);
      return null;
    })
    .catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca uma música do YouTube ou busca pelo texto.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('URL do YouTube ou termo de busca.')
        .setRequired(true)
        .setMaxLength(300)
    ),
  async execute(interaction) {
    let guildId = null;
    let pendingResolve = null;
    let resolveConsumed = false;

    try {
      guildId = assertInteractionInGuild(interaction);
      timing.begin(guildId);

      const memberChannel = assertMemberInVoice(interaction);

      const session = music.getSession(guildId);
      if (session && session.channelId) assertSameVoiceChannel(interaction, session.channelId);

      assertBotCanConnect(memberChannel, interaction.guild);

      const query = interaction.options.getString('query') || '';
      source.classifyQuery(query);

      timing.mark(guildId, 'ack.begin');
      timing.mark(guildId, 'resolve.begin');
      pendingResolve = startResolve(query, interaction.user.tag, guildId);

      await interaction.deferReply();
      timing.mark(guildId, 'ack.end');

      timing.mark(guildId, 'status.begin');
      await interaction.editReply({ content: SEARCHING_CONTENT });
      timing.mark(guildId, 'status.end');

      const outcome = await pendingResolve;
      resolveConsumed = true;

      if (!outcome.ok) throw outcome.error;

      const track = outcome.track;

      let result;

      try {
        await music.join({
          guildId,
          channelId: memberChannel.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          textChannelId: interaction.channelId,
        });

        timing.mark(guildId, 'add.begin');
        result = await music.add(guildId, track);
        timing.mark(guildId, 'add.end');
      } catch (error) {
        await source.releaseTrackInfo(track);
        throw error;
      }

      const embed = result.started
        ? buildNowPlayingEmbed({
            track,
            state: 'playing',
            progress: null,
            queueLength: result.queueLength,
            client: interaction.client,
          })
        : buildQueuedEmbed({
            track,
            position: result.position,
            queueLength: result.queueLength,
            client: interaction.client,
          });

      timing.mark(guildId, 'reply.begin');
      await interaction.editReply({ content: '', embeds: [embed] });
      timing.mark(guildId, 'reply.end');
      timing.finish(guildId, { pending: result.started });
    } catch (error) {
      if (pendingResolve && !resolveConsumed) releaseAbandonedTrack(pendingResolve);
      if (guildId) timing.finish(guildId);
      await replyMusicError(interaction, error);
    }
  },
};
