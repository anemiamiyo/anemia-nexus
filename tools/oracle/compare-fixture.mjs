#!/usr/bin/env node
/**
 * Compares the product's `certain` references with the independent tsserver
 * Oracle. Used by the Phase 01 G3 gate; the Oracle module never imports
 * packages/*.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { findReferencesWithTs } from './tsserver-references.mjs';

function runCli(cliPath, args, cwd) {
  const output = execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', NEXUS_FORMAT: 'json' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function keyOf(reference) {
  return `${reference.path}:${reference.line}:${reference.col}`;
}

export function compareFixture({ fixtureDir, cliPath, publicOnly = true, maxSymbols = 400 }) {
  const fixture = path.resolve(fixtureDir);
  const search = runCli(cliPath, ['search', '--format', 'json', '--roots', 'all'], fixture);
  const symbols = (search.items ?? []).filter((item) =>
    publicOnly ? item.isPublic === true : true,
  );
  const limited = symbols.slice(0, maxSymbols);
  const rows = [];
  let missingTotal = 0;
  let extraTotal = 0;
  for (const symbol of limited) {
    const oracle = findReferencesWithTs(
      fixture,
      symbol.path,
      symbol.nameLine,
      symbol.nameCol,
    ).filter((reference) => reference.isDefinition !== true);
    const product = runCli(cliPath, ['references', symbol.symbolId, '--format', 'json'], fixture);
    const productSet = new Set(
      (product.items ?? [])
        .filter((item) => item.relationClass === 'certain')
        .map((item) => keyOf(item)),
    );
    const oracleSet = new Set(oracle.map((item) => keyOf(item)));
    const missing = [...oracleSet].filter((key) => !productSet.has(key)).sort();
    const extra = [...productSet].filter((key) => !oracleSet.has(key)).sort();
    missingTotal += missing.length;
    extraTotal += extra.length;
    rows.push({
      symbolId: symbol.symbolId,
      name: symbol.nameChain,
      path: symbol.path,
      productCertain: productSet.size,
      oracleReferences: oracleSet.size,
      missing,
      extra,
      pass: missing.length === 0 && extra.length === 0,
    });
  }
  return {
    fixture: path.relative(process.cwd(), fixture).replaceAll('\\', '/'),
    comparedSymbols: limited.length,
    missingTotal,
    extraTotal,
    failures: rows.filter((row) => !row.pass),
    rows,
    pass: missingTotal === 0 && extraTotal === 0,
  };
}

if (process.argv[1] !== undefined) {
  const fixtureDir = process.argv[2];
  const cliPath = process.argv[3];
  const result = compareFixture({
    fixtureDir,
    cliPath: path.resolve(cliPath ?? 'packages/cli/dist/main.js'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
