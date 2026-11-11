import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  createVueProject,
  collectVueUserSymbols,
  collectTemplateRanges,
  findRangeAt,
  lineColOf,
} from '../lib/vue-project.mjs';

const require = createRequire(import.meta.url);
const { parse: parseSfc } = require('@vue/compiler-sfc');

const ROOT = process.cwd();
const VUE_ROOT = path.join(ROOT, 'fixtures/semantic-map/vue');
const project = createVueProject(VUE_ROOT);
const { symbolsByFile, unmapped } = collectVueUserSymbols(project);
const expected = JSON.parse(fs.readFileSync(path.join(VUE_ROOT, 'expected/symbols.json'), 'utf8'));

const actualByFile = {};
for (const [rel, entries] of Object.entries(symbolsByFile)) {
  actualByFile[rel] = entries.map((e) => e.name).sort();
}
const expectedSorted = Object.fromEntries(
  Object.entries(expected).map(([file, names]) => [file, [...names].sort()]),
);
const symbolSetMatches = JSON.stringify(actualByFile) === JSON.stringify(expectedSorted);
const userNames = new Set(
  Object.values(symbolsByFile)
    .flat()
    .map((entry) => entry.name),
);

const edges = [];
const ghostRefs = [];
const unmappedTemplateRefs = [];
const rangesByFile = {};

for (const virtual of project.virtuals.values()) {
  const sourceText = fs.readFileSync(virtual.vueFile, 'utf8');
  const { descriptor } = parseSfc(sourceText, { filename: path.basename(virtual.vueFile) });
  const ranges = collectTemplateRanges(sourceText, descriptor);
  rangesByFile[virtual.rel] = ranges;
  const sf = project.program.getSourceFile(virtual.virtualFileName);
  if (!sf) throw new Error(`virtual source missing: ${virtual.virtualFileName}`);

  const templateStart = descriptor.template?.loc.start.offset ?? 0;
  const templateEnd = descriptor.template?.loc.end.offset ?? 0;

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const generatedOffset = node.getStart(sf);
      const sourceOffset = virtual.toSource(generatedOffset);
      if (sourceOffset !== undefined) {
        const range = findRangeAt(ranges, sourceOffset);
        const symbol = project.checker.getSymbolAtLocation(node);
        const target =
          symbol && symbol.flags & ts.SymbolFlags.Alias
            ? project.checker.getAliasedSymbol(symbol)
            : symbol;
        const name = target?.name ?? '';
        if (range) {
          if (range.kind.startsWith('component-use')) {
            // Component-use edges are derived from the opening tag itself below.
          } else if (name.startsWith('__VLS_')) {
            ghostRefs.push({
              file: virtual.rel,
              name,
              line: lineColOf(sourceText, sourceOffset).line,
            });
          } else if (name) {
            const pos = lineColOf(sourceText, sourceOffset);
            edges.push({
              kind: range.kind,
              target: node.text,
              file: virtual.rel,
              line: pos.line,
              col: pos.col,
              sourceOffset,
              inSlotContent: Boolean(range.inSlotContent),
            });
          }
        } else if (
          sourceOffset >= templateStart &&
          sourceOffset < templateEnd &&
          userNames.has(node.text)
        ) {
          unmappedTemplateRefs.push({ file: virtual.rel, name: node.text, sourceOffset });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Component-use edges are derived from the template tag itself.
  for (const range of ranges.filter((r) => r.kind === 'component-use')) {
    const pos = lineColOf(sourceText, range.start);
    edges.push({
      kind: 'component-use',
      target: range.tag,
      file: virtual.rel,
      line: pos.line,
      col: pos.col,
      sourceOffset: range.start,
      inSlotContent: Boolean(range.inSlotContent),
    });
  }
}

const dedup = new Map();
for (const edge of edges) {
  const key = `${edge.kind}:${edge.file}:${edge.sourceOffset}:${edge.target}`;
  if (!dedup.has(key)) dedup.set(key, edge);
}
const uniqueEdges = [...dedup.values()];

const counts = {};
for (const edge of uniqueEdges) counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
const slotContentEdges = uniqueEdges.filter((e) => e.inSlotContent);

const vueTscBin = path.join(ROOT, 'node_modules/vue-tsc/bin/vue-tsc.js');
const vueTsc = spawnSync(
  process.execPath,
  [vueTscBin, '--noEmit', '-p', path.join(VUE_ROOT, 'tsconfig.json')],
  { cwd: ROOT, encoding: 'utf8' },
);

const expectedKinds = [
  'component-use',
  'event-binding',
  'directive-binding',
  'prop-binding',
  'interpolation',
];
const missingKinds = expectedKinds.filter((k) => (counts[k] ?? 0) === 0);
const invalidCoordinates = uniqueEdges.filter(
  (e) => e.line < 1 || e.col < 0 || !Number.isFinite(e.sourceOffset),
);
const pass =
  symbolSetMatches &&
  missingKinds.length === 0 &&
  ghostRefs.length === 0 &&
  invalidCoordinates.length === 0 &&
  slotContentEdges.length > 0 &&
  vueTsc.status === 0;

const report = {
  group: 'G2',
  generatedAt: new Date().toISOString(),
  fixture: 'fixtures/semantic-map/vue',
  thresholds: {
    userSymbolSetConsistency: 1,
    requiredKinds: expectedKinds,
    slotContentEdgesAtLeast: 1,
    ghostVlsRefs: 0,
    invalidCoordinates: 0,
    vueTscErrors: 0,
  },
  summary: {
    symbolSetMatches,
    userSymbols: actualByFile,
    expectedSymbols: expectedSorted,
    unmappedSymbols: unmapped,
    counts,
    slotContentEdges: slotContentEdges.length,
    ghostRefs: ghostRefs.length,
    unmappedTemplateRefs: unmappedTemplateRefs.length,
    invalidCoordinates: invalidCoordinates.length,
    missingKinds,
    vueTscExitCode: vueTsc.status,
    pass,
  },
  vueTsc: {
    command: `${process.execPath} node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p ${path.relative(ROOT, path.join(VUE_ROOT, 'tsconfig.json'))}`,
    stdout: vueTsc.stdout,
    stderr: vueTsc.stderr,
  },
  edges: uniqueEdges,
  ghostRefList: ghostRefs,
  unmappedTemplateRefs,
  rangesByFile,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g2-vue.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary, null, 2));
process.exit(pass ? 0 : 1);
