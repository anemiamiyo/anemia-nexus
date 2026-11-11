import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../lib/mini-index.mjs';

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'fixtures/semantic-map');
const WORK = path.join(ROOT, 'phase00/tmp/g10/work');
const FULL = path.join(ROOT, 'phase00/tmp/g10/full');

fs.rmSync(path.join(ROOT, 'phase00/tmp/g10'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(WORK), { recursive: true });
fs.cpSync(BASE, WORK, { recursive: true });
fs.cpSync(BASE, FULL, { recursive: true });

const base = buildIndex(WORK);

// Apply a representative mutation set: modify, delete, rename, add, cross-file signature change.
fs.appendFileSync(
  path.join(WORK, 'src/t01-basic.ts'),
  '\nexport function added(value: number): number {\n  return value * 2;\n}\n',
);
fs.rmSync(path.join(WORK, 'src/t02-barrel/consumer.ts'));
fs.renameSync(
  path.join(WORK, 'src/t03-alias/use.ts'),
  path.join(WORK, 'src/t03-alias/use-renamed.ts'),
);
fs.writeFileSync(
  path.join(WORK, 'src/g10-added.ts'),
  'export const addedConstant = 42;\nexport function useAdded(): number {\n  return addedConstant;\n}\n',
);
fs.writeFileSync(
  path.join(WORK, 'packages/ui/src/button.ts'),
  'export function createButton(label: string, disabled = false): { label: string; disabled: boolean } {\n  return { label, disabled };\n}\n',
);

const incremental = buildIndex(WORK, { cache: base.cache });

// Fresh full build over the same changed source, in a separate directory.
fs.rmSync(FULL, { recursive: true, force: true });
fs.cpSync(WORK, FULL, { recursive: true });
const full = buildIndex(FULL);

const fields = [
  'symbols',
  'identity',
  'references',
  'exports',
  'files',
  'surfaceHash',
  'edges',
  'buildFingerprint',
  'coverage',
  'manifest',
];

const comparisons = {};
for (const field of fields) {
  const left = JSON.stringify(incremental.output[field]);
  const right = JSON.stringify(full.output[field]);
  comparisons[field] = {
    equal: left === right,
    incrementalValue:
      field === 'surfaceHash' || field === 'buildFingerprint'
        ? incremental.output[field]
        : undefined,
    fullValue:
      field === 'surfaceHash' || field === 'buildFingerprint' ? full.output[field] : undefined,
  };
}

const pass = Object.values(comparisons).every((c) => c.equal);
const report = {
  group: 'G10',
  generatedAt: new Date().toISOString(),
  thresholds: { comparisonFields: 10, allEqual: true },
  summary: {
    total: fields.length,
    equal: fields.filter((f) => comparisons[f].equal).length,
    pass,
    reusedFiles: incremental.reusedFiles,
    incrementalFiles: incremental.output.coverage.files,
    buildFingerprint: incremental.output.buildFingerprint,
  },
  comparisons,
  limitation:
    'Prototype: unchanged file symbol/export records are reused from cache, but references/dependencies/calls are recomputed globally because cross-file edges may change. Phase 01 must implement per-root invalidation and prove it against the same ten-field comparison.',
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g10-equivalence.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const field of fields) console.log(field, comparisons[field].equal ? 'EQUAL' : 'DIFF');
process.exit(pass ? 0 : 1);
