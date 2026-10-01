const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const presence = require('../services/presence');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { resumedMessage } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Retoma a música pausada.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      await session.resume();
      presence.notify(session);

      await interaction.reply({ content: resumedMessage(session.current), flags: MessageFlags.Ephemeral });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
