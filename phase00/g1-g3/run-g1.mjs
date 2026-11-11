import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadProject, collectDeclarations } from '../lib/ts-declarations.mjs';
import {
  runScipIndex,
  readScipIndex,
  definitionMap,
  scipDescriptorName,
} from '../lib/scip-index.mjs';

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, 'fixtures/semantic-map');
const THRESHOLDS = { mappingSuccessRate: 0.95, falseMatchCount: 0 };

function scenarioOf(relPath) {
  if (relPath.startsWith('src/t08-cross/')) return 'T08-same-root';
  if (relPath.startsWith('packages/')) return 'T08-cross-package';
  const m = relPath.match(/^src\/(t0[1-9])-/);
  return m ? m[1].toUpperCase() : 'OTHER';
}

const indexPath = runScipIndex({ cwd: FIXTURE, output: 'index.scip', root: ROOT });
const project = loadProject(FIXTURE);
const { declarations } = collectDeclarations(project);
const scipIndex = readScipIndex(indexPath);
const defs = definitionMap(scipIndex);

const results = [];
for (const decl of declarations) {
  const key = `${decl.path}:${decl.line}:${decl.col}`;
  const hit = defs.get(key);
  const scenario = scenarioOf(decl.path);
  if (!hit) {
    results.push({
      ...summarize(decl),
      scenario,
      status: 'unmapped',
      reason: 'no-definition-at-location',
    });
    continue;
  }
  if (!hit.symbol) {
    results.push({
      ...summarize(decl),
      scenario,
      status: 'unmapped',
      reason: 'scip-empty-symbol',
      scip: '',
    });
    continue;
  }
  const scipName = scipDescriptorName(hit.symbol);
  const status = scipName === decl.name ? 'exact' : 'conflict';
  results.push({
    ...summarize(decl),
    scenario,
    status,
    scip: hit.symbol,
    scipName,
    ...(status === 'conflict' ? { reason: 'name-mismatch' } : {}),
  });
}

function summarize(decl) {
  return {
    path: decl.path,
    line: decl.line,
    col: decl.col,
    name: decl.name,
    nameChain: decl.nameChain,
    kind: decl.kind,
    ordinal: decl.ordinal,
  };
}

const eligible = results.length;
const exact = results.filter((r) => r.status === 'exact').length;
const structural = results.filter((r) => r.status === 'structural').length;
const conflicts = results.filter((r) => r.status === 'conflict');
const unmapped = results.filter((r) => r.status === 'unmapped');
const mappingSuccessRate = eligible === 0 ? 0 : (exact + structural) / eligible;

const byScenario = {};
for (const r of results) {
  byScenario[r.scenario] ??= { eligible: 0, exact: 0, structural: 0, conflict: 0, unmapped: 0 };
  byScenario[r.scenario].eligible += 1;
  byScenario[r.scenario][r.status] += 1;
}

const unmappedReasons = {};
for (const r of unmapped) unmappedReasons[r.reason] = (unmappedReasons[r.reason] ?? 0) + 1;

const scipSymbolCounts = new Map();
for (const r of results) {
  if (!r.scip) continue;
  const list = scipSymbolCounts.get(r.scip) ?? [];
  list.push(`${r.path}:${r.line}:${r.name}`);
  scipSymbolCounts.set(r.scip, list);
}
const sharedScipSymbols = [...scipSymbolCounts.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([symbol, list]) => ({ symbol, declarations: list }));

const overloadOrdinals = results
  .filter((r) => r.scenario === 'T06')
  .map((r) => ({
    path: r.path,
    line: r.line,
    name: r.name,
    ordinal: r.ordinal,
  }));

const scenarioNames = [
  'T01',
  'T02',
  'T03',
  'T04',
  'T05',
  'T06',
  'T07',
  'T08-same-root',
  'T08-cross-package',
];
const scenarioPass = scenarioNames.every((s) => (byScenario[s]?.exact ?? 0) > 0);
const pass =
  mappingSuccessRate >= THRESHOLDS.mappingSuccessRate &&
  conflicts.length <= THRESHOLDS.falseMatchCount &&
  scenarioPass;

const report = {
  group: 'G1',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    typescript: ts.version,
    scipVersion: '0.4.0',
  },
  fixture: 'fixtures/semantic-map',
  thresholds: THRESHOLDS,
  summary: {
    eligibleDeclarations: eligible,
    exact,
    structural,
    mappingSuccessRate: Number(mappingSuccessRate.toFixed(4)),
    falseMatchCount: conflicts.length,
    unmappedCount: unmapped.length,
    conflictCount: conflicts.length,
    scenarioPass,
  },
  byScenario,
  unmappedReasons,
  sharedScipSymbols,
  overloadOrdinals,
  conflicts,
  unmapped,
  pass,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g1-mapping.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary, null, 2));
console.log('byScenario', JSON.stringify(byScenario, null, 2));
console.log('unmappedReasons', JSON.stringify(unmappedReasons));
console.log('pass', pass);
process.exit(pass ? 0 : 1);
