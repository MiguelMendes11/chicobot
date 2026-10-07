const presence = require('../services/presence');
const ytdlp = require('../services/music/source/ytdlp');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    presence.start(client);
    console.log(`✅ Bot online como ${client.user.tag}`);

    try {
      ytdlp.prewarmYtDlp();
    } catch (error) {
      console.warn('⚠️ Aquecimento do yt-dlp ignorado:', error && error.message);
    }
  },
};
