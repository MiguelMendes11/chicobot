const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pausa a música que está tocando.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      await session.pause();

      await interaction.reply({ content: '⏸️ Música pausada.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
