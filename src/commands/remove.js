const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { removedMessage } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove uma música das próximas da fila.')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Posição entre as próximas (1 = primeira música depois da atual).')
        .setRequired(true)
        .setMinValue(1)
    ),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      const position = interaction.options.getInteger('position');
      const result = await session.removeAt(position);

      await interaction.reply({
        content: removedMessage(result.track, result.position, result.queueLength),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
