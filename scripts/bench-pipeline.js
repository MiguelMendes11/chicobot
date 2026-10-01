#!/usr/bin/env node
const { performance } = require('node:perf_hooks');
const { demuxProbe } = require('@discordjs/voice');
const ytdlp = require('../src/services/music/source/ytdlp');
const { MUSIC_CONFIG } = require('../src/services/music/constants');

function parseArgs(argv) {
  const options = { runs: 5, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', query: 'ytsearch1:never gonna give you up' };

  for (const arg of argv) {
    const match = /^--(runs|url|query)=(.+)$/.exec(arg);
    if (!match) continue;
    if (match[1] === 'runs') options.runs = Math.max(1, parseInt(match[2], 10) || 5);
    else options[match[1]] = match[2];
  }

  return options;
}

async function resolveEntry(target) {
  const payload = await ytdlp.fetchMetadata(target);
  return Array.isArray(payload.entries) ? payload.entries[0] : payload;
}

async function resourceOnce(target, infoFile) {
  const handle = await ytdlp.openStream(target, { infoFile: infoFile || undefined });

  try {
    await demuxProbe(handle.stream);
  } finally {
    handle.kill();
  }
}

async function fullFlow(target, withInfo) {
  const entry = await resolveEntry(target);
  let infoFile = null;

  if (withInfo) infoFile = ytdlp.createInfoFile(entry);

  try {
    await resourceOnce(target, infoFile);
  } finally {
    if (infoFile) await ytdlp.releaseTrackInfo({ infoFile });
  }
}

async function formatOnce(target) {
  const args = ['--ignore-config', '-f', MUSIC_CONFIG.YT_DLP_AUDIO_FORMAT, '-g', '--no-warnings', '--no-part'];

  if (/^https?:\/\//i.test(target)) args.push('--no-playlist');
  args.push(target);

  await ytdlp.runYtDlp(args, { maxStdout: 1024 * 1024 });
}

function createInfoResourceScenario(label, target) {
  let infoFile = null;

  return {
    label,
    prepare: async () => {
      const entry = await resolveEntry(target);
      infoFile = ytdlp.createInfoFile(entry);
    },
    run: async () => {
      await resourceOnce(target, infoFile);
    },
    cleanup: async () => {
      if (infoFile) await ytdlp.releaseTrackInfo({ infoFile });
      infoFile = null;
    },
  };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { n, median: Math.round(median), min: Math.round(sorted[0]), max: Math.round(sorted[n - 1]) };
}

async function main() {
  const { runs, url, query } = parseArgs(process.argv.slice(2));

  const scenarios = [
    { label: 'resolve busca (só metadados)', run: () => resolveEntry(query) },
    { label: 'resolve URL direta (só metadados)', run: () => resolveEntry(url) },
    { label: 'formato -g (busca)', run: () => formatOnce(query) },
    { label: 'formato -g (URL direta)', run: () => formatOnce(url) },
    { label: 'resource busca — ANTES (sem infoFile)', run: () => resourceOnce(query, null) },
    createInfoResourceScenario('resource busca — DEPOIS (infoFile)', query),
    { label: 'resource URL — ANTES (sem infoFile)', run: () => resourceOnce(url, null) },
    createInfoResourceScenario('resource URL — DEPOIS (infoFile)', url),
    { label: 'fluxo completo busca — ANTES', run: () => fullFlow(query, false) },
    { label: 'fluxo completo busca — DEPOIS', run: () => fullFlow(query, true) },
    { label: 'fluxo completo URL — ANTES', run: () => fullFlow(url, false) },
    { label: 'fluxo completo URL — DEPOIS', run: () => fullFlow(url, true) },
  ];

  const results = new Map(scenarios.map((scenario) => [scenario.label, []]));

  console.log(`Benchmark do pipeline yt-dlp — ${runs} execuções por cenário (mediana no final)\n`);

  for (let round = 1; round <= runs; round += 1) {
    console.log(`--- rodada ${round}/${runs} ---`);

    for (const scenario of scenarios) {
      try {
        if (scenario.prepare) await scenario.prepare();
      } catch (error) {
        console.log(`  FALHOU (prepare) ${scenario.label}: ${error && error.message ? error.message : error}`);
        if (scenario.cleanup) await scenario.cleanup().catch(() => {});
        continue;
      }

      const t0 = performance.now();
      let failed = null;

      try {
        await scenario.run();
      } catch (error) {
        failed = error && error.code ? error.code : error && error.message ? error.message : String(error);
      }

      const ms = performance.now() - t0;

      if (scenario.cleanup) await scenario.cleanup().catch(() => {});

      if (failed) {
        console.log(`  FALHOU ${scenario.label}: ${failed}`);
      } else {
        results.get(scenario.label).push(ms);
        console.log(`  ${scenario.label}: ${Math.round(ms)}ms`);
      }
    }
  }

  console.log('\n=== Resumo (mediana) ===');
  console.log('cenário'.padEnd(42) + 'n'.padStart(3) + 'mediana'.padStart(10) + 'mín'.padStart(8) + 'máx'.padStart(8));

  const medians = new Map();

  for (const scenario of scenarios) {
    const s = stats(results.get(scenario.label));
    if (!s) {
      console.log(scenario.label.padEnd(42) + 'sem dados');
      continue;
    }
    medians.set(scenario.label, s.median);
    console.log(
      scenario.label.padEnd(42) + String(s.n).padStart(3) + `${s.median}ms`.padStart(10) + `${s.min}ms`.padStart(8) + `${s.max}ms`.padStart(8)
    );
  }

  const delta = (before, after) => {
    const b = medians.get(before);
    const a = medians.get(after);
    if (b === undefined || a === undefined) return 'n/d';
    const diff = b - a;
    const pct = b > 0 ? Math.round((diff / b) * 100) : 0;
    return `${diff >= 0 ? '-' : '+'}${Math.abs(diff)}ms (${Math.abs(pct)}%)`;
  };

  console.log('\n=== Ganho (ANTES → DEPOIS) ===');
  console.log(`resource busca:      ${delta('resource busca — ANTES (sem infoFile)', 'resource busca — DEPOIS (infoFile)')}`);
  console.log(`resource URL:        ${delta('resource URL — ANTES (sem infoFile)', 'resource URL — DEPOIS (infoFile)')}`);
  console.log(`fluxo completo busca: ${delta('fluxo completo busca — ANTES', 'fluxo completo busca — DEPOIS')}`);
  console.log(`fluxo completo URL:   ${delta('fluxo completo URL — ANTES', 'fluxo completo URL — DEPOIS')}`);
}

main().catch((error) => {
  console.error('Benchmark falhou:', error);
  process.exitCode = 1;
});
