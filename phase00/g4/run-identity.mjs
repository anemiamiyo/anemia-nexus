import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshot, IdentityRegistry } from '../lib/identity.mjs';

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'fixtures/F15-identity/base');
const WORK = path.join(ROOT, 'phase00/tmp/g4');

function prepare(name) {
  const dir = path.join(WORK, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(BASE, dir, { recursive: true });
  return dir;
}

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function initGit(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'phase00@example.invalid']);
  git(dir, ['config', 'user.name', 'Phase 00']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
}

function parseRenameLine(line) {
  const match = line.match(/^ rename (.+) \(\d+%\)$/);
  if (!match) return undefined;
  let body = match[1].replaceAll('"', '');
  const brace = body.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, prefix, left, right, suffix] = brace;
    const combine = (a, b) => `${a}${b}`.replace(/\/{2,}/g, '/');
    return [combine(prefix + left, suffix), combine(prefix + right, suffix)];
  }
  const simple = body.match(/^(.+) => (.+)$/);
  return simple ? [simple[1], simple[2]] : undefined;
}

function renamePairs(dir) {
  git(dir, ['add', '-A']);
  const out = git(dir, ['diff', '-M', '--summary', 'HEAD']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const pair = parseRenameLine(line);
    if (pair) map.set(pair[0], pair[1]);
  }
  return map;
}

function decisionFor(decisions, name) {
  return decisions.filter((d) => d.record.nameChain === name);
}

const scenarios = {};

function simpleScenario(name, mutate, verify) {
  const dir = prepare(name);
  initGit(dir);
  const before = snapshot(dir);
  const registry = new IdentityRegistry();
  registry.seed(before);
  mutate(dir);
  const pairs = renamePairs(dir);
  const after = snapshot(dir);
  const decisions = registry.migrate(after, { renamePairs: pairs });
  return verify({ dir, before, after, registry, decisions, pairs, name });
}

// 1. file rename.
scenarios.rename = simpleScenario(
  'rename',
  (dir) => fs.renameSync(path.join(dir, 'src/rename-me.ts'), path.join(dir, 'src/renamed-me.ts')),
  ({ before, after, decisions, pairs }) => {
    const beforeRecord = [...before.records].find((r) => r.nameChain === 'stableFn');
    const decision = decisionFor(decisions, 'stableFn')[0];
    const afterRecord = after.records.find((r) => r.nameChain === 'stableFn');
    const pass =
      decision.symbolId === beforeRecord.id &&
      ['high', 'medium'].includes(decision.confidence) &&
      decision.evidence.includes('E1') &&
      decision.evidence.includes('E3') &&
      decision.evidence.includes('E5') &&
      afterRecord.path === 'src/renamed-me.ts';
    return {
      pass,
      assertions: {
        idSame: decision.symbolId === beforeRecord.id,
        confidence: decision.confidence,
        evidence: decision.evidence,
        renamePairs: [...pairs.entries()],
        afterPath: afterRecord.path,
      },
    };
  },
);

// 2. cross-directory move.
scenarios.move = simpleScenario(
  'move',
  (dir) => {
    const target = path.join(dir, 'src/moved/deep');
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(path.join(dir, 'src/move-me.ts'), path.join(target, 'move-me.ts'));
  },
  ({ before, decisions, pairs }) => {
    const beforeRecord = before.records.find((r) => r.nameChain === 'MoveClass');
    const decision = decisionFor(decisions, 'MoveClass')[0];
    const pass =
      decision.symbolId === beforeRecord.id &&
      ['high', 'medium'].includes(decision.confidence) &&
      decision.evidence.includes('E1') &&
      decision.record.path === 'src/moved/deep/move-me.ts';
    return {
      pass,
      assertions: {
        idSame: decision.symbolId === beforeRecord.id,
        confidence: decision.confidence,
        evidence: decision.evidence,
        afterPath: decision.record.path,
        renamePairs: [...pairs.entries()],
      },
    };
  },
);

// 3. two same-name files swap contents.
scenarios.swap = simpleScenario(
  'swap',
  (dir) => {
    const a = path.join(dir, 'src/swap-a.ts');
    const b = path.join(dir, 'src/swap-b.ts');
    const oldA = fs.readFileSync(a, 'utf8');
    const oldB = fs.readFileSync(b, 'utf8');
    fs.writeFileSync(a, oldB);
    fs.writeFileSync(b, oldA);
  },
  ({ before, decisions }) => {
    const ds = decisionFor(decisions, 'swap');
    const beforeIds = new Set(
      before.records.filter((r) => r.nameChain === 'swap').map((r) => r.id),
    );
    const pass =
      ds.length === 2 &&
      ds.every((d) => d.confidence === 'low') &&
      ds.every((d) => d.identityAmbiguous === true) &&
      ds.every((d) => (d.candidates ?? []).length >= 2) &&
      ds.every((d) => !beforeIds.has(d.symbolId));
    return {
      pass,
      assertions: {
        decisions: ds.map((d) => ({
          symbolId: d.symbolId,
          confidence: d.confidence,
          candidates: d.candidates,
          identityAmbiguous: d.identityAmbiguous,
        })),
        anyIdInherited: ds.some((d) => beforeIds.has(d.symbolId)),
      },
    };
  },
);

// 4. same-name symbol added in a new file.
scenarios.sameNameAdd = simpleScenario(
  'same-name-add',
  (dir) => {
    fs.writeFileSync(
      path.join(dir, 'src/same-name-2.ts'),
      'export function sameName(): number {\n  return 2;\n}\n',
    );
  },
  ({ before, decisions }) => {
    const oldBefore = before.records.find((r) => r.nameChain === 'sameName');
    const oldDecision = decisions.find((d) => d.record.path === 'src/same-name.ts');
    const newDecision = decisions.find((d) => d.record.path === 'src/same-name-2.ts');
    const pass =
      oldDecision.symbolId === oldBefore.id &&
      newDecision.symbolId !== oldBefore.id &&
      newDecision.confidence === 'low';
    return {
      pass,
      assertions: {
        oldId: oldBefore.id,
        oldResolvedId: oldDecision.symbolId,
        newId: newDecision.symbolId,
        newConfidence: newDecision.confidence,
        merged: newDecision.symbolId === oldBefore.id,
      },
    };
  },
);

// 5. delete, then recreate at the same position.
{
  const dir = prepare('delete-recreate');
  initGit(dir);
  const before = snapshot(dir);
  const registry = new IdentityRegistry();
  registry.seed(before);
  const oldId = [...registry.active.values()].find((r) => r.nameChain === 'rebuildMe').id;
  fs.rmSync(path.join(dir, 'src/rebuild.ts'));
  const removed = snapshot(dir);
  registry.migrate(removed);
  const oldRetired = registry.retired.has(oldId);
  fs.writeFileSync(
    path.join(dir, 'src/rebuild.ts'),
    "export function rebuildMe(): string {\n  return 'v1';\n}\n",
  );
  const recreated = snapshot(dir);
  const decisions = registry.migrate(recreated);
  const decision = decisionFor(decisions, 'rebuildMe')[0];
  const pass =
    oldRetired &&
    decision.symbolId !== oldId &&
    decision.confidence === 'low' &&
    decision.identityAmbiguous === false;
  scenarios.deleteRecreate = {
    pass,
    assertions: {
      oldId,
      oldRetired,
      newId: decision.symbolId,
      confidence: decision.confidence,
      identityAmbiguous: decision.identityAmbiguous,
      note: 'E3+E6 medium path not exercised in this run; default new-identity rule verified.',
    },
  };
}

// 6. declaration body/signature change in the same file and position.
scenarios.bodyChange = simpleScenario(
  'body-change',
  (dir) => {
    fs.writeFileSync(
      path.join(dir, 'src/body-change.ts'),
      'export function changing(value: number): number {\n  return value + 100;\n}\n',
    );
  },
  ({ before, after, decisions }) => {
    const beforeRecord = before.records.find((r) => r.nameChain === 'changing');
    const afterRecord = after.records.find((r) => r.nameChain === 'changing');
    const decision = decisionFor(decisions, 'changing')[0];
    const pass =
      decision.symbolId === beforeRecord.id &&
      beforeRecord.structuralFingerprint !== afterRecord.structuralFingerprint &&
      decision.confidence === 'high';
    return {
      pass,
      assertions: {
        idSame: decision.symbolId === beforeRecord.id,
        fingerprintChanged:
          beforeRecord.structuralFingerprint !== afterRecord.structuralFingerprint,
        confidence: decision.confidence,
        evidence: decision.evidence,
      },
    };
  },
);

// 7. remove two identical twins and add a third identical candidate.
scenarios.multiCandidate = simpleScenario(
  'multi-candidate',
  (dir) => {
    fs.rmSync(path.join(dir, 'src/twin-a.ts'));
    fs.rmSync(path.join(dir, 'src/twin-b.ts'));
    const body = "export function twin(): string {\n  return 'twin';\n}\n";
    fs.writeFileSync(path.join(dir, 'src/twin-c.ts'), body);
  },
  ({ before, decisions }) => {
    const ds = decisionFor(decisions, 'twin');
    const beforeIds = new Set(
      before.records.filter((r) => r.nameChain === 'twin').map((r) => r.id),
    );
    const pass =
      ds.length === 1 &&
      ds[0].confidence === 'low' &&
      ds[0].identityAmbiguous === true &&
      (ds[0].candidates ?? []).length >= 2 &&
      !beforeIds.has(ds[0].symbolId);
    return {
      pass,
      assertions: {
        decisions: ds.map((d) => ({
          path: d.record.path,
          symbolId: d.symbolId,
          confidence: d.confidence,
          candidates: d.candidates,
          identityAmbiguous: d.identityAmbiguous,
        })),
        anyIdInherited: ds.some((d) => beforeIds.has(d.symbolId)),
      },
    };
  },
);

// 8. cross-package move.
scenarios.crossRoot = simpleScenario(
  'cross-root',
  (dir) => {
    const target = path.join(dir, 'packages/other/src/cross.ts');
    fs.renameSync(path.join(dir, 'packages/lib/src/cross.ts'), target);
  },
  ({ before, decisions, registry }) => {
    const beforeRecord = before.records.find((r) => r.nameChain === 'crossMove');
    const decision = decisionFor(decisions, 'crossMove')[0];
    const pass =
      decision.symbolId !== beforeRecord.id &&
      decision.record.rootId === '@fixture/other' &&
      decision.record.rootId !== beforeRecord.rootId &&
      registry.retired.has(beforeRecord.id);
    return {
      pass,
      assertions: {
        oldId: beforeRecord.id,
        oldRoot: beforeRecord.rootId,
        newId: decision.symbolId,
        newRoot: decision.record.rootId,
        oldRetired: registry.retired.has(beforeRecord.id),
        confidence: decision.confidence,
      },
    };
  },
);

const all = Object.entries(scenarios).map(([name, value]) => ({ name, ...value }));
const report = {
  group: 'G4',
  generatedAt: new Date().toISOString(),
  fixture: 'fixtures/F15-identity',
  thresholds: { scenarios: 8, inheritedLowConfidence: 0 },
  summary: {
    total: all.length,
    passed: all.filter((s) => s.pass).length,
    pass: all.every((s) => s.pass),
  },
  scenarios: Object.fromEntries(all.map((s) => [s.name, s])),
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g4-identity.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const scenario of all) console.log(scenario.name, scenario.pass ? 'PASS' : 'FAIL');
process.exit(report.summary.pass ? 0 : 1);
