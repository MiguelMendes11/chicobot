const { MessageFlags } = require('discord.js');
const { MusicError } = require('../services/music/errors');

async function replyMusicError(interaction, error) {
  if (!(error instanceof MusicError)) throw error;

  const content = error.userMessage;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  return true;
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '\u2014';

  const total = Math.round(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');

  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;

  return `${minutes}:${pad(seconds)}`;
}

function formatTitle(title) {
  return String(title).replace(/([\[\]])/g, '\\$1');
}

function formatTrack(track) {
  return `**[${formatTitle(track.title)}](${track.url})** (${formatDuration(track.duration)})`;
}

module.exports = { replyMusicError, formatDuration, formatTitle, formatTrack };
