const fs = require('fs');
const path = require('path');

const commandsDir = path.join(__dirname, '..', 'commands');

async function loadCommands(client) {
  const files = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const command = require(path.join(commandsDir, file));

    if (!command?.data || typeof command.execute !== 'function') {
      console.warn(`⚠️ Comando ignorado (${file}): precisa exportar "data" e "execute".`);
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  return files.length;
}

module.exports = loadCommands;
