const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild } = require('../services/music/guards');
const { MUSIC_CONFIG } = require('../services/music/constants');
const { replyMusicError, formatTrack } = require('../utils/musicInteraction');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Mostra a música atual e as próximas da fila.'),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);
      const session = music.requireSession(guildId);
      const snapshot = session.snapshot();

      const preview = MUSIC_CONFIG.MAX_QUEUE_PREVIEW;
      const upcoming = snapshot.queue.slice(0, preview);
      const remaining = snapshot.queue.length - upcoming.length;

      const lines = upcoming.map((item, index) => `${index + 1}. ${formatTrack(item)}`);

      if (lines.length === 0) lines.push('*Nada na fila.*');
      if (remaining > 0) lines.push(`… e mais ${remaining} na fila.`);

      const status = snapshot.state === 'paused' ? '⏸️' : '▶️';
      const author = interaction.guild ? `🎵 Fila de música — ${interaction.guild.name}` : '🎵 Fila de música';
      const description = [
        `${status} Tocando agora: ${formatTrack(snapshot.current)}`,
        snapshot.current && snapshot.current.requestedBy
          ? `Pedido por **${snapshot.current.requestedBy}**`
          : '',
        '**Próximas:**',
        ...lines,
      ]
        .filter(Boolean)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: author })
        .setDescription(description)
        .setFooter({ text: `${snapshot.queue.length} na fila` });

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
