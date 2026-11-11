#!/usr/bin/env node
/**
 * Independent tsserver Oracle for Phase 01 reference correctness
 * (docs/17-testing.md, docs/phase-01/02-plan-and-gates.md 2.1).
 *
 * This module depends only on the TypeScript compiler and the fixture; it must
 * never import packages/* or reuse the SCIP mapping implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

export function loadFixture(fixtureDir) {
  const root = path.resolve(fixtureDir);
  const configPath = path.join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  return { root, options: parsed.options, fileNames: parsed.fileNames };
}

function createService(fixture) {
  const { root, options, fileNames } = fixture;
  const versions = new Map();
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (fileName) => {
      const key = path.resolve(fileName);
      const version = versions.get(key) ?? 0;
      versions.set(key, version + 1);
      return String(version);
    },
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host);
}

export function findReferencesWithTs(fixtureDir, relativeFile, line, col) {
  const fixture = loadFixture(fixtureDir);
  const service = createService(fixture);
  const absolute = path.resolve(fixture.root, relativeFile);
  const source = service.getProgram()?.getSourceFile(absolute);
  if (source === undefined) {
    throw new Error(`source file not in program: ${relativeFile}`);
  }
  const position = source.getPositionOfLineAndCharacter(line - 1, col);
  const symbols = service.findReferences(absolute, position) ?? [];
  const entries = new Map();
  for (const symbol of symbols) {
    for (const reference of [
      ...(symbol.definition ? [symbol.definition] : []),
      ...symbol.references,
    ]) {
      const fileName = path.resolve(reference.fileName);
      const relative = toPosix(path.relative(fixture.root, fileName));
      if (relative.startsWith('..')) continue;
      const referenceSource = service.getProgram()?.getSourceFile(fileName);
      if (referenceSource === undefined) continue;
      const lc = referenceSource.getLineAndCharacterOfPosition(reference.textSpan.start);
      const key = `${relative}:${lc.line + 1}:${lc.character}`;
      const existing = entries.get(key);
      const isDefinition = reference.isDefinition === true;
      if (existing === undefined) {
        entries.set(key, {
          path: relative,
          line: lc.line + 1,
          col: lc.character,
          isDefinition,
          isWriteAccess: reference.isWriteAccess === true,
        });
      } else if (isDefinition) {
        existing.isDefinition = true;
      }
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.path === right.path
      ? left.line === right.line
        ? left.col - right.col
        : left.line - right.line
      : left.path < right.path
        ? -1
        : 1,
  );
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('tsserver-references.mjs')) {
  const [fixtureDir, relativeFile, lineRaw, colRaw] = process.argv.slice(2);
  try {
    const result = findReferencesWithTs(
      fixtureDir,
      relativeFile,
      Number.parseInt(lineRaw ?? '0', 10),
      Number.parseInt(colRaw ?? '0', 10),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
