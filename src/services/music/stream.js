const { createAudioResource, demuxProbe } = require('@discordjs/voice');
const { createMusicError } = require('./errors');
const { MUSIC_CONFIG } = require('./constants');
const ytdlp = require('./source/ytdlp');
const timing = require('./timing');

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

async function openTrackResource(track, infoFile) {
  const handle = await ytdlp.openStream(track.url, { infoFile: infoFile || undefined });

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

async function createTrackResource(track, session = null) {
  const infoFile = track && track.infoFile ? track.infoFile : null;

  if (!infoFile) return openTrackResource(track, null);

  try {
    const playback = await openTrackResource(track, infoFile);
    await ytdlp.releaseTrackInfo(track);
    return playback;
  } catch (error) {
    await ytdlp.releaseTrackInfo(track);

    if (error && error.code === 'YT_DLP_NOT_FOUND') throw error;

    if (session && session.guildId) timing.mark(session.guildId, 'resource.fallback');

    return openTrackResource(track, null);
  }
}

module.exports = { createResourceFromStream, createTrackResource };
