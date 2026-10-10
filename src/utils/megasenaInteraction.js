const { MessageFlags } = require('discord.js');
const { MegaSenaError } = require('../services/megasena/errors');

async function replyMegaSenaError(interaction, error) {
  if (!(error instanceof MegaSenaError)) throw error;

  const content = error.userMessage;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  return true;
}

module.exports = { replyMegaSenaError };
