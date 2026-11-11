import fs from 'node:fs';
import path from 'node:path';

const [, , outDir, filesArg, linesArg] = process.argv;
const files = Number(filesArg ?? 50);
const linesPerFile = Number(linesArg ?? 1000);
const root = path.resolve(outDir);

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify(
    { name: `perf-fixture-${files}k`, version: '0.0.0', private: true, type: 'module' },
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(
  path.join(root, 'tsconfig.json'),
  JSON.stringify(
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
  ) + '\n',
);

const blocksPerFile = Math.max(1, Math.floor((linesPerFile - 4) / 8));
let totalLines = 0;
for (let i = 0; i < files; i += 1) {
  const lines = [];
  lines.push(`import type { Model${Math.max(0, i - 1)} } from './file${Math.max(0, i - 1)}';`);
  lines.push(`export interface Model${i} { id: string; value: number; }`);
  lines.push('');
  for (let j = 0; j < blocksPerFile; j += 1) {
    lines.push(`export function fn${i}_${j}(x: number): number {`);
    lines.push(`  const y = x + ${j};`);
    lines.push(`  return y * 2;`);
    lines.push(`}`);
    lines.push(`export class C${i}_${j} {`);
    lines.push(`  value = ${j};`);
    lines.push(`  read(): number { return this.value; }`);
    lines.push(`}`);
    lines.push(`export const v${i}_${j} = fn${i}_${j}(${j});`);
    lines.push('');
  }
  lines.push(`export type Alias${i} = Model${Math.max(0, i - 1)};`);
  const text = lines.join('\n') + '\n';
  totalLines += lines.length;
  fs.writeFileSync(path.join(root, 'src', `file${i}.ts`), text);
}

console.log(JSON.stringify({ root, files, blocksPerFile, totalLines }));
