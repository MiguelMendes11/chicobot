const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError, formatTrack } = require('../utils/musicInteraction');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula a música atual e toca a próxima da fila.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      const current = session.current;
      await session.skip();

      await interaction.reply({ content: `⏭️ Pulando ${formatTrack(current)}.`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
