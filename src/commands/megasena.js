const { SlashCommandBuilder } = require('discord.js');
const generator = require('../services/megasena/generator');
const results = require('../services/megasena/results');
const statistics = require('../services/megasena/statistics');
const { buildMegaSenaGameEmbed, buildMegaSenaResultEmbed, buildMegaSenaStatsEmbed } = require('../utils/embeds');
const { replyMegaSenaError } = require('../utils/megasenaInteraction');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('megasena')
    .setDescription('Diversão com a Mega-Sena: gere dezenas e consulte o último resultado.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('jogo')
        .setDescription('Gera 6 dezenas aleatórias (1 a 60), em ordem crescente.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('resultado')
        .setDescription('Mostra o último resultado oficial da Mega-Sena.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estatisticas')
        .setDescription('Mostra as dezenas mais e menos sorteadas na história da Mega-Sena.')
    ),
  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'jogo') {
      const dezenas = generator.generateDezenas();
      const embed = buildMegaSenaGameEmbed({ dezenas, client: interaction.client });

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (subcommand === 'resultado') {
      await interaction.deferReply();

      try {
        const result = await results.getLatestResult();
        const embed = buildMegaSenaResultEmbed({ result, client: interaction.client });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await replyMegaSenaError(interaction, error);
      }
    }

    if (subcommand === 'estatisticas') {
      await interaction.deferReply();

      try {
        const stats = await statistics.getStatistics();
        const embed = buildMegaSenaStatsEmbed({ stats, client: interaction.client });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await replyMegaSenaError(interaction, error);
      }
    }
  },
};
