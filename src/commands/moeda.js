const { SlashCommandBuilder } = require('discord.js');
const moeda = require('../services/moeda');
const { buildMoedaEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('moeda')
    .setDescription('Sorteia cara ou coroa com 50% de chance para cada lado.'),
  async execute(interaction) {
    const result = moeda.flip();
    const embed = buildMoedaEmbed({ result, client: interaction.client });

    await interaction.reply({ embeds: [embed] });
  },
};
