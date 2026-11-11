import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { seedCommitted, recover } from '../lib/sqlite-protocol.mjs';

const ROOT = process.cwd();
const WORK = path.join(ROOT, 'phase00/tmp/g5');
const CHILD = path.join(ROOT, 'phase00/g5/crash-child.mjs');

const injections = [
  { name: 'begin', crashAt: 'begin', state: 'fresh', action: 'none', manifestBuild: 'A' },
  { name: 'pending', crashAt: 'pending', state: 'fresh', action: 'none', manifestBuild: 'A' },
  {
    name: 'committed-pending',
    crashAt: 'committed-pending',
    state: 'stale',
    action: 'discard-pending',
    manifestBuild: 'A',
  },
  {
    name: 'verified',
    crashAt: 'verified',
    state: 'stale',
    action: 'discard-pending',
    manifestBuild: 'A',
  },
  {
    name: 'committed',
    crashAt: 'committed',
    state: 'fresh',
    action: 'manifest-repaired',
    manifestBuild: 'B',
  },
  {
    name: 'manifest-temp',
    crashAt: 'manifest-temp',
    state: 'fresh',
    action: 'manifest-repaired',
    manifestBuild: 'B',
  },
  { name: 'manifest', crashAt: 'manifest', state: 'fresh', action: 'none', manifestBuild: 'B' },
];

const results = [];
for (const injection of injections) {
  const dir = path.join(WORK, injection.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'index.db');
  seedCommitted(dbPath, 'A', 'bf_A');

  const child = spawnSync(process.execPath, [CHILD, dbPath, 'B', 'bf_B', injection.crashAt], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const crashed = child.status === 137;
  const recovery = recover({ dbPath });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const db = new DatabaseSync(dbPath);
  const symbols = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
  const records = db.prepare('SELECT build_id, status FROM build_record ORDER BY rowid').all();
  db.close();

  const pass =
    crashed &&
    recovery.state === injection.state &&
    recovery.action === injection.action &&
    manifest.buildId === injection.manifestBuild &&
    symbols >= 1 &&
    (injection.manifestBuild === 'B'
      ? records.some((r) => r.build_id === 'B' && r.status === 'committed')
      : records.some((r) => r.build_id === 'A' && r.status === 'committed'));

  results.push({
    injection: injection.name,
    pass,
    crashExitCode: child.status,
    recovery,
    manifest,
    symbols,
    records,
    stderr: child.stderr,
  });
}

// Extra recovery-matrix cases from 12.3.3.
const invalidDir = path.join(WORK, 'invalid-db');
fs.rmSync(invalidDir, { recursive: true, force: true });
fs.mkdirSync(invalidDir, { recursive: true });
const invalidDb = path.join(invalidDir, 'index.db');
fs.writeFileSync(invalidDb, 'not a sqlite database');
const invalidRecovery = recover({ dbPath: invalidDb });

const noRecordDir = path.join(WORK, 'no-record');
fs.rmSync(noRecordDir, { recursive: true, force: true });
fs.mkdirSync(noRecordDir, { recursive: true });
const noRecordDb = path.join(noRecordDir, 'index.db');
seedCommitted(noRecordDb, 'A', 'bf_A');
const nr = new DatabaseSync(noRecordDb);
nr.exec('DELETE FROM build_record');
nr.close();
const noRecordRecovery = recover({ dbPath: noRecordDb });
const extraPass = invalidRecovery.code === 'E07' && noRecordRecovery.code === 'E19';

const report = {
  group: 'G5',
  generatedAt: new Date().toISOString(),
  thresholds: { injectionPoints: 7, recoveryMatches: 7, extraInvalidCases: 2 },
  summary: {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    extraPass,
    pass: results.every((r) => r.pass) && extraPass,
  },
  results,
  extra: {
    invalidDb: invalidRecovery,
    noRecord: noRecordRecovery,
  },
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g5-crash-recovery.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const result of results)
  console.log(result.injection, result.pass ? 'PASS' : 'FAIL', JSON.stringify(result.recovery));
console.log(
  'extra',
  extraPass ? 'PASS' : 'FAIL',
  JSON.stringify({ invalid: invalidRecovery, noRecord: noRecordRecovery }),
);
process.exit(report.summary.pass ? 0 : 1);
