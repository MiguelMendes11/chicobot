require('dotenv').config();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const loadCommands = require('./utils/loadCommands');
const loadEvents = require('./utils/loadEvents');

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Variáveis de ambiente ausentes. Copie .env.example para .env e preencha DISCORD_TOKEN e CLIENT_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();

async function main() {
  await loadEvents(client);
  await loadCommands(client);

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  console.error('❌ Falha ao iniciar o bot:', error);
  process.exit(1);
});
