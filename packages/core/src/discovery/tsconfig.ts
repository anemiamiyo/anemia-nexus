import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { nexusError } from '../errors.js';

export interface TsconfigResult {
  ok: boolean;
  tsconfigPath: string;
  relativePath: string;
  fileNames: string[];
  errors: string[];
  options: ts.CompilerOptions | null;
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

/**
 * Parses (never executes) a tsconfig. Returning `ok: false` lets the caller
 * enter the documented `syntax-only` degradation (E03) instead of pretending
 * semantic results exist.
 */
export function readTsconfig(rootPath: string, relativePath: string): TsconfigResult {
  const tsconfigPath = path.join(rootPath, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    return {
      ok: false,
      tsconfigPath,
      relativePath,
      fileNames: [],
      errors: ['tsconfig.json not found'],
      options: null,
    };
  }
  let read: ReturnType<typeof ts.readConfigFile>;
  try {
    read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  } catch (error) {
    return {
      ok: false,
      tsconfigPath,
      relativePath,
      fileNames: [],
      errors: [error instanceof Error ? error.message : String(error)],
      options: null,
    };
  }
  if (read.error) {
    return {
      ok: false,
      tsconfigPath,
      relativePath,
      fileNames: [],
      errors: [diagnosticText(read.error)],
      options: null,
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    rootPath,
    undefined,
    tsconfigPath,
  );
  const errors = parsed.errors.map(diagnosticText);
  const fileNames = parsed.fileNames.map((file) => path.resolve(file));
  const usable = errors.length === 0;
  return {
    ok: usable,
    tsconfigPath,
    relativePath,
    fileNames,
    errors,
    options: usable ? parsed.options : null,
  };
}

export function assertValidTsconfig(result: TsconfigResult, projectRoot: string): void {
  if (result.ok) return;
  throw nexusError('E03', 'tsconfig could not be parsed', {
    reason: result.errors.join('; ') || 'unknown tsconfig error',
    file: path.relative(projectRoot, result.tsconfigPath).replaceAll('\\', '/'),
    suggestion: 'Fix tsconfig.json, or continue in syntax-only mode with reduced guarantees.',
    evidence: { errors: result.errors },
  });
}
