const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const music = require('../services/music');
const { assertInteractionInGuild, assertSameVoiceChannel } = require('../services/music/guards');
const { createMusicError } = require('../services/music/errors');
const { replyMusicError } = require('../utils/musicInteraction');
const { loopModeMessage } = require('../utils/embeds');

const LOOP_CYCLE = Object.freeze({ off: 'track', track: 'queue', queue: 'off' });

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Define o modo de repetição da fila.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Modo de loop. Sem opção, avança para o próximo modo.')
        .setRequired(false)
        .addChoices(
          { name: 'Desligado', value: 'off' },
          { name: 'Música', value: 'track' },
          { name: 'Fila', value: 'queue' }
        )
    ),
  async execute(interaction) {
    try {
      const guildId = assertInteractionInGuild(interaction);

      const session = music.getSession(guildId);
      if (!session || session.destroyed) throw createMusicError('NO_PLAYBACK');

      assertSameVoiceChannel(interaction, session.channelId);

      const requested = interaction.options && typeof interaction.options.getString === 'function'
        ? interaction.options.getString('mode')
        : null;

      const mode = requested || LOOP_CYCLE[session.loopMode] || 'off';
      const result = await session.setLoop(mode);

      await interaction.reply({ content: loopModeMessage(result.mode), flags: MessageFlags.Ephemeral });
    } catch (error) {
      await replyMusicError(interaction, error);
    }
  },
};
