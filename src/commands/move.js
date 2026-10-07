const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { movedMessage } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move uma música de posição dentro das próximas da fila.')
    .addIntegerOption((option) =>
      option
        .setName('from')
        .setDescription('Posição de origem (1 = primeira música depois da atual).')
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((option) =>
      option
        .setName('to')
        .setDescription('Posição de destino.')
        .setRequired(true)
        .setMinValue(1)
    ),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      const from = interaction.options.getInteger('from');
      const to = interaction.options.getInteger('to');
      const result = await session.moveTrack(from, to);

      await interaction.reply({
        content: movedMessage(result.track, result.from, result.to),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
