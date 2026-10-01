const { SlashCommandBuilder } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild } = require('../services/music/guards');
const { createMusicError } = require('../services/music/errors');
const { MUSIC_CONFIG } = require('../services/music/constants');
const { replyMusicError } = require('../utils/musicInteraction');
const { buildQueueEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Mostra a música atual e as próximas da fila.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.getSession(guildId);

      if (!session || session.destroyed) throw createMusicError('NO_PLAYBACK');

      const embed = buildQueueEmbed({
        snapshot: session.snapshot(),
        guildName: interaction.guild ? interaction.guild.name : null,
        client: interaction.client,
        previewLimit: MUSIC_CONFIG.MAX_QUEUE_PREVIEW,
      });

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
