const cp = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMusicError } = require('../errors');
const { MUSIC_CONFIG } = require('../constants');

const STDERR_LIMIT = 1024 * 1024;
const URL_PATTERN = /^https?:\/\//i;
const INFO_DIR = path.join(os.tmpdir(), 'chicobot-info');
const INFO_FILE_PREFIX = 'chicobot-info-';
const INFO_FILE_STALE_MS = 60 * 1000;
const UNLINK_RETRY_ATTEMPTS = 6;
const UNLINK_RETRY_DELAY_MS = 50;

function getYtDlpCommand() {
  const configured = process.env.YT_DLP_PATH;

  if (typeof configured === 'string' && configured.trim()) return configured.trim();

  return 'yt-dlp';
}

function getEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureInfoDir() {
  try {
    fs.mkdirSync(INFO_DIR, { recursive: true });
    return INFO_DIR;
  } catch (error) {
    return null;
  }
}

function createInfoFile(entry) {
  const dir = ensureInfoDir();
  if (!dir) return null;

  const file = path.join(dir, `${INFO_FILE_PREFIX}${Date.now()}-${randomUUID()}.json`);

  try {
    fs.writeFileSync(file, JSON.stringify(entry));
    return file;
  } catch (error) {
    return null;
  }
}

async function unlinkInfoFile(file) {
  for (let attempt = 0; attempt < UNLINK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsp.unlink(file);
      return true;
    } catch (error) {
      const code = error && error.code;

      if (code === 'ENOENT') return false;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await sleep(UNLINK_RETRY_DELAY_MS);
        continue;
      }

      return false;
    }
  }

  try {
    await fsp.unlink(file);
    return true;
  } catch (error) {
    return false;
  }
}

async function releaseTrackInfo(track) {
  if (!track || !track.infoFile) return false;

  const file = track.infoFile;
  track.infoFile = null;
  await unlinkInfoFile(file);
  return true;
}

function cleanupStaleInfoFiles(options = {}) {
  const { olderThanMs = INFO_FILE_STALE_MS } = options;
  let names;

  try {
    names = fs.readdirSync(INFO_DIR);
  } catch (error) {
    return 0;
  }

  const cutoff = Date.now() - olderThanMs;
  let removed = 0;

  for (const name of names) {
    if (!name.startsWith(INFO_FILE_PREFIX)) continue;

    const file = path.join(INFO_DIR, name);

    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch (error) {}
  }

  return removed;
}

function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;

  try {
    child.kill();
  } catch (error) {
    console.error('❌ Não foi possível encerrar o yt-dlp:', error.message);
  }
}

function summarizeStderr(stderr) {
  if (!stderr) return undefined;

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return undefined;

  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line)) || lines[lines.length - 1];
  const summary = errorLine.replace(/^ERROR:\s*/i, '').trim();

  if (!summary) return undefined;

  return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

function mapYtDlpError(stderr) {
  const text = (stderr || '').toLowerCase();

  if (text.includes('no results') || text.includes('no video found')) return 'NO_RESULTS';
  if (text.includes('sign in to confirm') || text.includes('confirm you\'re not a bot') || text.includes('confirm you are not a bot')) return 'YT_BOT_CHECK';
  if (text.includes('unsupported url')) return 'UNSUPPORTED_URL';
  if (
    text.includes('video unavailable') ||
    text.includes('video is private') ||
    text.includes('has been removed') ||
    text.includes('has been deleted') ||
    text.includes('account associated with this video') ||
    text.includes('not available in your country') ||
    text.includes('video is not available')
  ) return 'VIDEO_UNAVAILABLE';
  if (text.includes('requested format is not available')) return 'STREAM_UNAVAILABLE';
  if (
    text.includes('unable to download webpage') ||
    text.includes('getaddrinfo failed') ||
    text.includes('name or service not known') ||
    text.includes('connection refused') ||
    text.includes('network is unreachable') ||
    text.includes('timed out') ||
    text.includes('http error 4')
  ) return 'NETWORK_ERROR';

  return 'YT_DLP_FAILED';
}

function createChild(args) {
  let child;

  try {
    child = cp.spawn(getYtDlpCommand(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getEnv(),
    });
  } catch (error) {
    throw createMusicError('YT_DLP_NOT_FOUND', { cause: error });
  }

  return child;
}

function buildMetadataArgs(target) {
  const args = ['--ignore-config', '--dump-single-json', '--skip-download', '--no-warnings'];

  if (URL_PATTERN.test(target)) args.push('--no-playlist');

  args.push(target);

  return args;
}

function buildStreamArgs(target, options = {}) {
  const args = [
    '--ignore-config',
    '-f',
    MUSIC_CONFIG.YT_DLP_AUDIO_FORMAT,
    '-o',
    '-',
    '--no-warnings',
    '--no-part',
  ];

  if (options.infoFile) args.push('--load-info-json', options.infoFile);

  if (URL_PATTERN.test(target)) args.push('--no-playlist');

  args.push(target);

  return args;
}

function runYtDlp(args, options = {}) {
  const { timeoutMs = MUSIC_CONFIG.RESOLVE_TIMEOUT_MS, maxStdout = MUSIC_CONFIG.METADATA_MAX_BYTES } = options;

  return new Promise((resolve, reject) => {
    let child;

    try {
      child = createChild(args);
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;

    const settle = (method, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      method(value);
    };

    timer = setTimeout(() => {
      killChild(child);
      settle(reject, createMusicError('YT_DLP_TIMEOUT'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > maxStdout) {
        killChild(child);
        settle(reject, createMusicError('YT_DLP_TIMEOUT'));
        return;
      }

      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STDERR_LIMIT) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.stdout.on('error', () => {});

    child.on('error', (error) => {
      const code = error && error.code === 'ENOENT' ? 'YT_DLP_NOT_FOUND' : 'YT_DLP_FAILED';
      settle(reject, createMusicError(code, { cause: error }));
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code === 0) {
        settle(resolve, { stdout, stderr, code });
        return;
      }

      const mapped = mapYtDlpError(stderr);
      const details = mapped === 'YT_DLP_FAILED' || mapped === 'NETWORK_ERROR' ? summarizeStderr(stderr) : undefined;

      settle(reject, createMusicError(mapped, details ? { details } : {}));
    });
  });
}

async function fetchMetadata(target) {
  const { stdout } = await runYtDlp(buildMetadataArgs(target));

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw createMusicError('METADATA_INVALID', { cause: error });
  }
}

function openStream(target, options = {}) {
  const { timeoutMs = MUSIC_CONFIG.STREAM_SPAWN_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    let child;

    try {
      child = createChild(buildStreamArgs(target, { infoFile: options.infoFile }));
    } catch (error) {
      reject(error);
      return;
    }

    const stderrChunks = [];
    let stderrBytes = 0;
    let settled = false;
    let timer = null;

    const settle = (method, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      method(value);
    };

    timer = setTimeout(() => {
      killChild(child);
      settle(reject, createMusicError('YT_DLP_TIMEOUT'));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STDERR_LIMIT) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.stdout.on('error', () => {});

    const getStderr = () => Buffer.concat(stderrChunks).toString('utf8');

    child.on('error', (error) => {
      const code = error && error.code === 'ENOENT' ? 'YT_DLP_NOT_FOUND' : 'YT_DLP_FAILED';
      settle(reject, createMusicError(code, { cause: error }));
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0) return;

      const stderr = getStderr();
      const mapped = exitCode === null ? 'STREAM_UNAVAILABLE' : mapYtDlpError(stderr);
      const details = mapped === 'YT_DLP_FAILED' ? summarizeStderr(stderr) : undefined;

      settle(reject, createMusicError(mapped, details ? { details } : {}));
    });

    child.once('spawn', () => {
      settle(resolve, {
        child,
        stream: child.stdout,
        getStderr,
        kill: () => killChild(child),
      });
    });
  });
}

async function checkYtDlp() {
  try {
    const { stdout } = await runYtDlp(['--ignore-config', '--version'], { timeoutMs: 15000 });

    return {
      ok: true,
      command: getYtDlpCommand(),
      version: stdout.trim().split(/\r?\n/).filter(Boolean).pop() || 'desconhecida',
    };
  } catch (error) {
    return { ok: false, command: getYtDlpCommand(), error };
  }
}

module.exports = {
  getYtDlpCommand,
  runYtDlp,
  fetchMetadata,
  openStream,
  checkYtDlp,
  mapYtDlpError,
  summarizeStderr,
  createInfoFile,
  releaseTrackInfo,
  cleanupStaleInfoFiles,
  INFO_DIR,
};

cleanupStaleInfoFiles();
