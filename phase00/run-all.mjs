import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GROUPS = [
  { id: 'G1', script: 'phase00/g1-g3/run-g1.mjs', timeout: 180_000 },
  { id: 'G2', script: 'phase00/g1-g3/run-g2.mjs', timeout: 180_000 },
  { id: 'G3', script: 'phase00/g1-g3/run-g3.mjs', timeout: 180_000 },
  { id: 'G4', script: 'phase00/g4/run-identity.mjs', timeout: 180_000 },
  { id: 'G5', script: 'phase00/g5/run-crash-recovery.mjs', timeout: 180_000 },
  { id: 'G6', script: 'phase00/g6/run-runtime.mjs', timeout: 600_000 },
  { id: 'G7', script: 'phase00/g7/run-rss.mjs', timeout: 600_000 },
  { id: 'G8', script: 'phase00/g8/run-scheduler.mjs', timeout: 180_000 },
  { id: 'G9', script: 'phase00/g9/run-security.mjs', timeout: 180_000 },
  { id: 'G10', script: 'phase00/g10/run-equivalence.mjs', timeout: 180_000 },
  { id: 'MCP', script: 'phase00/mcp/run-probe.mjs', timeout: 120_000 },
];

const results = [];
for (const group of GROUPS) {
  const started = performance.now();
  const child = spawnSync(process.execPath, [path.join(ROOT, group.script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: group.timeout,
  });
  const elapsed = Math.round(performance.now() - started);
  results.push({
    id: group.id,
    script: group.script,
    exitCode: child.status,
    elapsedMs: elapsed,
    pass: child.status === 0,
    stdoutTail: (child.stdout ?? '').trim().split('\n').slice(-4),
    stderrTail: (child.stderr ?? '').trim().split('\n').slice(-4),
  });
  console.log(`${group.id} ${child.status === 0 ? 'PASS' : 'FAIL'} (${elapsed}ms)`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  pass: results.every((r) => r.pass),
  results,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify({ total: summary.total, passed: summary.passed, pass: summary.pass }));
process.exit(summary.pass ? 0 : 1);
