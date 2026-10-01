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
const { replyMusicError, formatTrack } = require('../utils/musicInteraction');

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

    try {
      guildId = assertInteractionInGuild(interaction);
      timing.begin(guildId);

      const memberChannel = assertMemberInVoice(interaction);

      const session = music.getSession(guildId);
      if (session && session.channelId) assertSameVoiceChannel(interaction, session.channelId);

      assertBotCanConnect(memberChannel, interaction.guild);

      const query = interaction.options.getString('query') || '';
      source.classifyQuery(query);

      await interaction.deferReply();
      await interaction.editReply({ content: '🔍 Buscando música no YouTube…' });

      timing.mark(guildId, 'resolve.begin');
      const track = await source.resolveQuery(query, { requestedBy: interaction.user.tag });
      timing.mark(guildId, 'resolve.end');

      let result;

      try {
        await music.join({
          guildId,
          channelId: memberChannel.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          textChannelId: interaction.channelId,
        });

        result = await music.add(guildId, track);
      } catch (error) {
        await source.releaseTrackInfo(track);
        throw error;
      }

      const label = `${formatTrack(track)} · pedido por ${track.requestedBy}`;

      const content = result.started
        ? `▶️ Tocando agora: ${label}`
        : `➕ Adicionada na fila na posição **${result.position}**: ${label} · fila com ${result.queueLength} música(s)`;

      await interaction.editReply({ content });
      timing.finish(guildId, { pending: result.started });
    } catch (error) {
      if (guildId) timing.finish(guildId);
      await replyMusicError(interaction, error);
    }
  },
};
