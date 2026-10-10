const { SlashCommandBuilder } = require('discord.js');
const generator = require('../services/megasena/generator');
const { buildMegaSenaGameEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('megasena')
    .setDescription('Diversão com a Mega-Sena: gere dezenas aleatórias.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('jogo')
        .setDescription('Gera 6 dezenas aleatórias (1 a 60), em ordem crescente.')
    ),
  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'jogo') {
      const dezenas = generator.generateDezenas();
      const embed = buildMegaSenaGameEmbed({ dezenas, client: interaction.client });

      await interaction.reply({ embeds: [embed] });
    }
  },
};
