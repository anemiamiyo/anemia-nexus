import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scip } = require('@sourcegraph/scip-typescript/dist/src/scip.js');

export const SCIP_TYPESCRIPT_MAIN = 'node_modules/@sourcegraph/scip-typescript/dist/src/main.js';

export function runScipIndex({ cwd, output = 'index.scip', root = process.cwd() }) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, SCIP_TYPESCRIPT_MAIN),
      'index',
      '--cwd',
      cwd,
      '--output',
      output,
      '--no-progress-bar',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `scip-typescript failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return path.join(cwd, output);
}

export function readScipIndex(indexPath) {
  const index = scip.Index.deserializeBinary(fs.readFileSync(indexPath));
  const object = index.toObject();
  return {
    metadata: object.metadata,
    documents: (object.documents ?? []).map((doc) => ({
      path: String(doc.relative_path).replaceAll('\\', '/'),
      language: doc.language ?? '',
      occurrences: (doc.occurrences ?? []).map((occ) => ({
        range: occ.range ?? [],
        symbol: occ.symbol ?? '',
        symbolRoles: occ.symbol_roles ?? 0,
        syntaxKind: occ.syntax_kind ?? 0,
      })),
      symbols: doc.symbols ?? [],
    })),
    externalSymbols: object.externalSymbols ?? [],
  };
}

export function definitionMap(index) {
  const map = new Map();
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if ((occ.symbolRoles & 1) === 0) continue;
      const [line, col] = occ.range;
      map.set(`${doc.path}:${line + 1}:${col}`, {
        path: doc.path,
        line: line + 1,
        col,
        symbol: occ.symbol,
      });
    }
  }
  return map;
}

export function scipDescriptorName(symbol) {
  if (!symbol) return '';
  const segments = symbol.split('/').filter(Boolean);
  const descriptor = segments.at(-1) ?? '';
  const withoutParens = descriptor.replace(/\(\)\.$/, '').replace(/[.#]$/, '');
  const nameSegments = withoutParens.split(/[#.]/).filter(Boolean);
  return nameSegments.at(-1) ?? '';
}

export function isDefinition(occ) {
  return (occ.symbolRoles & 1) !== 0;
}
