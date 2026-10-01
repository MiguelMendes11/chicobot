const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { skippedMessage } = require('../utils/embeds');

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
      const next = session.queue.length > 0 ? session.queue[0] : null;

      await session.skip();

      await interaction.reply({ content: skippedMessage(current, next), flags: MessageFlags.Ephemeral });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
