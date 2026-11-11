import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const NODE = 'C:/Users/Anemia/AppData/Roaming/fnm/node-versions/v24.22.2/installation/node.exe';
const BUILD = path.join(ROOT, 'phase00/g7/build-child.mjs');
const QUERY = path.join(ROOT, 'phase00/g7/query-child.mjs');
const SCALES = [
  {
    name: '50k',
    dir: path.join(ROOT, 'phase00/tmp/g7/50k'),
    targetRssMB: 400,
    hardRssMB: 550,
    targetQueryMB: 60,
  },
  {
    name: '300k',
    dir: path.join(ROOT, 'phase00/tmp/g7/300k'),
    targetRssMB: 700,
    hardRssMB: 900,
    targetQueryMB: 100,
  },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseLastJson(stdout) {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines.at(-1));
}

const results = [];
for (const scale of SCALES) {
  if (!fs.existsSync(scale.dir)) {
    throw new Error(`missing generated project: ${scale.dir}`);
  }
  const runs = [];
  for (let rep = 1; rep <= 3; rep += 1) {
    const build = spawnSync(NODE, [BUILD, scale.dir], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600_000,
    });
    if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
    const buildResult = parseLastJson(build.stdout);
    const query = spawnSync(NODE, [QUERY, scale.dir], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (query.status !== 0) throw new Error(`query failed: ${query.stderr}`);
    const queryResult = parseLastJson(query.stdout);
    runs.push({
      rep,
      ...buildResult,
      buildDurationMs: buildResult.durationMs,
      queryRssMB: queryResult.queryRssMB,
      queryDurationMs: queryResult.durationMs,
    });
  }
  const peakValues = runs.map((r) => r.peakRssMB);
  const queryValues = runs.map((r) => r.queryRssMB);
  const medianPeak = median(peakValues);
  const maxPeak = Math.max(...peakValues);
  const medianQuery = median(queryValues);
  const pass =
    medianPeak <= scale.targetRssMB &&
    maxPeak <= scale.hardRssMB &&
    medianQuery <= scale.targetQueryMB;
  results.push({
    scale: scale.name,
    pass,
    environment: {
      projectLoc: runs[0].loc,
      fileCount: runs[0].files,
      dependencyCount: 0,
      tsRatio: 1,
      vueRatio: 0,
      nodeVersion: runs[0].node,
      os: os.platform(),
      osVersion: os.release(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCores: os.cpus().length,
      availableMemMB: Math.round(os.freemem() / 1024 / 1024),
      scenario: 'P1-cold-full-index',
      repetitions: 3,
      sampling: '50ms setInterval plus phase checkpoints',
      note: 'SCIP stage not included in this measurement; see G1 and the Phase 00 report limitation.',
    },
    thresholds: {
      targetRssMB: scale.targetRssMB,
      hardRssMB: scale.hardRssMB,
      targetQueryMB: scale.targetQueryMB,
    },
    summary: {
      medianPeakRssMB: Number(medianPeak.toFixed(1)),
      maxPeakRssMB: Number(maxPeak.toFixed(1)),
      medianQueryRssMB: Number(medianQuery.toFixed(1)),
      medianDurationMs: Math.round(median(runs.map((r) => r.buildDurationMs))),
      medianDbSizeMB: Number(median(runs.map((r) => r.dbSizeMB)).toFixed(1)),
      pass,
    },
    runs,
  });
}

const report = {
  group: 'G7',
  generatedAt: new Date().toISOString(),
  verdict: 'pass-with-limit',
  limitation:
    'RSS covers TypeScript Program construction, declaration/reference traversal, and SQLite writes. The SCIP subprocess is measured separately in G1 and is not included in this peak; Phase 01/06 must measure the integrated pipeline.',
  thresholds: { repetitions: 3, scaleCount: 2, millionLineSkippedByOwner: true },
  summary: {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    pass: results.every((r) => r.pass),
  },
  results,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g7-rss.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const result of results) {
  console.log(result.scale, result.pass ? 'PASS' : 'FAIL', JSON.stringify(result.summary));
}
process.exit(report.summary.pass ? 0 : 1);
