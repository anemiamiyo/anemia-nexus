/* global console */
import fs from 'node:fs';
import path from 'node:path';

/**
 * F11 generator (docs/17-testing.md 17.1.1). Generated projects are never
 * committed; the caller chooses an output directory outside source control.
 *
 * usage: node tools/perf/generate.mjs <outDir> <files> <linesPerFile>
 */
const [, , outArg, filesArg, linesArg] = process.argv;
if (outArg === undefined) {
  console.error('usage: node tools/perf/generate.mjs <outDir> <files> <linesPerFile>');
  process.exit(64);
}
const files = Number(filesArg ?? 20);
const linesPerFile = Number(linesArg ?? 500);
const root = path.resolve(outArg);

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'package.json'),
  `${JSON.stringify(
    {
      name: `perf-fixture-${files}x${linesPerFile}`,
      version: '0.0.0',
      private: true,
      type: 'module',
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(root, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: false,
        skipLibCheck: true,
        types: [],
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`,
);

const blocksPerFile = Math.max(1, Math.floor((linesPerFile - 4) / 8));
let totalLines = 0;
for (let index = 0; index < files; index += 1) {
  const lines = [];
  lines.push(
    `import type { Model${Math.max(0, index - 1)} } from './file${Math.max(0, index - 1)}';`,
  );
  lines.push(`export interface Model${index} { id: string; value: number; }`);
  lines.push('');
  for (let block = 0; block < blocksPerFile; block += 1) {
    lines.push(`export function fn${index}_${block}(x: number): number {`);
    lines.push(`  const y = x + ${block};`);
    lines.push('  return y * 2;');
    lines.push('}');
    lines.push(`export class C${index}_${block} {`);
    lines.push(`  value = ${block};`);
    lines.push('  read(): number { return this.value; }');
    lines.push('}');
    lines.push(`export const v${index}_${block} = fn${index}_${block}(${block});`);
    lines.push('');
  }
  lines.push(`export type Alias${index} = Model${Math.max(0, index - 1)};`);
  totalLines += lines.length;
  fs.writeFileSync(path.join(root, 'src', `file${index}.ts`), `${lines.join('\n')}\n`);
}
console.log(JSON.stringify({ root, files, linesPerFile, totalLines, blocksPerFile }));
