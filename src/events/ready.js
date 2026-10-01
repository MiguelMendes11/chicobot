const presence = require('../services/presence');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    presence.start(client);
    console.log(`✅ Bot online como ${client.user.tag}`);
  },
};
