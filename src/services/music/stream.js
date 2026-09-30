const { createAudioResource, demuxProbe } = require('@discordjs/voice');
const { createMusicError } = require('./errors');
const { MUSIC_CONFIG } = require('./constants');
const { openStream } = require('./source/ytdlp');

function withTimeout(promise, timeoutMs) {
  let timer = null;

  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(createMusicError('STREAM_UNAVAILABLE')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function createResourceFromStream(readable, metadata = null) {
  let probe;

  try {
    probe = await demuxProbe(readable);
  } catch (error) {
    if (typeof readable.destroy === 'function') readable.destroy();
    throw createMusicError('STREAM_UNAVAILABLE', { cause: error });
  }

  let resource;

  try {
    resource = createAudioResource(probe.stream, { inputType: probe.type, metadata });
  } catch (error) {
    if (typeof probe.stream.destroy === 'function') probe.stream.destroy();
    throw createMusicError('STREAM_UNAVAILABLE', { cause: error });
  }

  if (resource.playStream && typeof resource.playStream.on === 'function') {
    resource.playStream.on('error', () => {});
  }

  return { resource, inputType: probe.type };
}

async function createTrackResource(track) {
  const handle = await openStream(track.url);

  try {
    const { resource, inputType } = await withTimeout(
      createResourceFromStream(handle.stream, track),
      MUSIC_CONFIG.STREAM_SPAWN_TIMEOUT_MS
    );

    return { resource, inputType, child: handle.child, kill: handle.kill };
  } catch (error) {
    handle.kill();
    throw error;
  }
}

module.exports = { createResourceFromStream, createTrackResource };
