require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Variáveis de ambiente ausentes. Copie .env.example para .env e preencha DISCORD_TOKEN, CLIENT_ID e GUILD_ID.');
  process.exit(1);
}

const commandsDir = path.join(__dirname, 'commands');

const commands = fs
  .readdirSync(commandsDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => {
    const command = require(path.join(commandsDir, file));
    if (!command?.data) {
      throw new Error(`O comando em ${file} não exporta "data".`);
    }
    return command.data.toJSON();
  });

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`🔄 Registrando ${commands.length} comando(s) na guild ${GUILD_ID}...`);

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });

    console.log('✅ Comandos registrados com sucesso.');
  } catch (error) {
    console.error('❌ Falha ao registrar comandos:', error);
    process.exit(1);
  }
})();
