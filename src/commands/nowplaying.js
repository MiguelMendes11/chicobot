const { SlashCommandBuilder } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild } = require('../services/music/guards');
const { replyMusicError } = require('../utils/musicInteraction');
const { buildNowPlayingEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Mostra a música que está tocando agora com o progresso.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);
      const snapshot = session.snapshot();

      const embed = buildNowPlayingEmbed({
        track: snapshot.current,
        state: snapshot.state,
        progress: snapshot.progress,
        queueLength: snapshot.queueLength,
        client: interaction.client,
        loopMode: snapshot.loopMode,
      });

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
