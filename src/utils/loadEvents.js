const fs = require('fs');
const path = require('path');

const eventsDir = path.join(__dirname, '..', 'events');

async function loadEvents(client) {
  const files = fs.readdirSync(eventsDir).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const event = require(path.join(eventsDir, file));

    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(`⚠️ Evento ignorado (${file}): precisa exportar "name" e "execute".`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }

  return files.length;
}

module.exports = loadEvents;
