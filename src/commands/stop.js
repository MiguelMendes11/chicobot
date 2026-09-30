const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Limpa a fila e desconecta o bot do canal de voz.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);

      assertSameVoiceChannel(interaction, session.channelId);

      await music.stop(guildId);

      await interaction.reply({
        content: '⏹️ Fila limpa. Desconectando do canal de voz.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
