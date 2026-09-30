const music = require('../services/music');

module.exports = {
  name: 'voiceStateUpdate',
  once: false,
  execute(oldState, newState) {
    try {
      const client = (oldState && oldState.client) || (newState && newState.client) || null;
      music.onVoiceStateUpdate(client, oldState, newState);
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      console.error('❌ [música] falha ao processar voiceStateUpdate:', detail);
    }
  },
};
