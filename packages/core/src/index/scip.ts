import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { nexusError } from '../errors.js';
import { SCIP_VERSION } from './analyzer.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ScipOccurrence {
  range: number[];
  symbol: string;
  symbolRoles: number;
  syntaxKind: number;
  enclosingRange: number[];
}

export interface ScipDocument {
  path: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbolCount: number;
}

export interface ScipIndexData {
  metadata: {
    version: number;
    toolName: string;
    toolVersion: string;
    projectRoot: string;
    textDocumentEncoding: number;
  };
  documents: ScipDocument[];
  externalSymbols: string[];
}

export interface ScipRunOptions {
  projectRoot: string;
  rootPath: string;
  outputPath: string;
  timeoutMs?: number;
  /** Phase 02: index a generated shadow tsconfig instead of `<root>/tsconfig.json`. */
  tsconfigPath?: string;
}

export interface ScipRunResult {
  indexPath: string;
  exitCode: number;
  durationMs: number;
  command: string;
  stderrSummary: string;
}

interface ScipModule {
  scip: {
    Index: {
      deserializeBinary(bytes: Uint8Array): {
        toObject(): Record<string, unknown>;
      };
    };
  };
}

function resolvePackageDir(): string {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve('@sourcegraph/scip-typescript/package.json'));
  } catch {
    const main = require.resolve('@sourcegraph/scip-typescript');
    return path.dirname(main);
  }
}

function adapterPaths(): { mainJs: string; scipJs: string } {
  const packageDir = resolvePackageDir();
  return {
    mainJs: path.join(packageDir, 'dist', 'src', 'main.js'),
    scipJs: path.join(packageDir, 'dist', 'src', 'scip.js'),
  };
}

/**
 * Contract probe for the scip-typescript 0.4.0 internal paths (checklist G04).
 * Internal paths are isolated in this module; a package layout change must be
 * detected here, not leak into business code.
 */
export function probeScipContract(): { ok: boolean; reasons: string[]; packageDir: string } {
  const reasons: string[] = [];
  let packageDir: string;
  try {
    packageDir = resolvePackageDir();
  } catch {
    return { ok: false, reasons: ['cannot resolve @sourcegraph/scip-typescript'], packageDir: '' };
  }
  const { mainJs, scipJs } = adapterPaths();
  if (!fs.existsSync(mainJs)) reasons.push(`missing ${mainJs}`);
  if (!fs.existsSync(scipJs)) reasons.push(`missing ${scipJs}`);
  return { ok: reasons.length === 0, reasons, packageDir };
}

function loadScipModule(): ScipModule {
  const probe = probeScipContract();
  if (!probe.ok) {
    throw nexusError('E11', 'scip-typescript adapter contract is broken', {
      reason: probe.reasons.join('; '),
      suggestion:
        'Reinstall @sourcegraph/scip-typescript@0.4.0 or update the adapter for the new layout.',
      evidence: { packageDir: probe.packageDir, expectedVersion: SCIP_VERSION },
    });
  }
  const require = createRequire(import.meta.url);
  const value = require(adapterPaths().scipJs) as unknown;
  if (typeof value !== 'object' || value === null || !('scip' in value)) {
    throw nexusError('E11', 'scip parser module has an unexpected shape', {
      reason: 'module does not export scip',
      suggestion: 'Recheck the adapter contract test.',
    });
  }
  return value as ScipModule;
}

export async function runScipIndex(options: ScipRunOptions): Promise<ScipRunResult> {
  const probe = probeScipContract();
  if (!probe.ok) {
    throw nexusError('E11', 'scip-typescript is unavailable', {
      reason: probe.reasons.join('; '),
      suggestion: 'Reinstall @sourcegraph/scip-typescript@0.4.0.',
      evidence: { packageDir: probe.packageDir },
    });
  }
  const { mainJs } = adapterPaths();
  const indexPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const args = [
    mainJs,
    'index',
    '--cwd',
    path.resolve(options.rootPath),
    '--output',
    indexPath,
    '--no-progress-bar',
  ];
  if (options.tsconfigPath !== undefined) {
    args.push(path.resolve(options.tsconfigPath));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const run = await new Promise<{ exitCode: number; timedOut: boolean; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: options.projectRoot,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      const collect = (chunk: Buffer): void => {
        if (stderr.length >= MAX_OUTPUT_BYTES) return;
        stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - stderr.length);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let settled = false;
      const finish = (value: { exitCode: number; timedOut: boolean; stderr: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ exitCode: -1, timedOut: true, stderr });
      }, timeoutMs);
      child.on('error', (error) => {
        finish({ exitCode: -1, timedOut: false, stderr: `${stderr}\n${error.message}` });
      });
      child.on('close', (code) => {
        finish({ exitCode: code ?? -1, timedOut: false, stderr });
      });
    },
  );

  const durationMs = Date.now() - startedAt;
  if (run.timedOut) {
    throw nexusError('E11', 'scip indexing timed out', {
      reason: `scip-typescript exceeded ${timeoutMs} ms`,
      suggestion: 'Increase the timeout or reduce the root scope.',
      evidence: { command: args.join(' '), durationMs },
    });
  }
  if (run.exitCode !== 0) {
    throw nexusError('E11', 'scip indexing failed', {
      reason: run.stderr.slice(0, 4000) || `exit code ${run.exitCode}`,
      suggestion: 'Fix the TypeScript project errors reported above, then rebuild.',
      evidence: { command: args.join(' '), exitCode: run.exitCode, durationMs },
    });
  }
  if (!fs.existsSync(indexPath)) {
    throw nexusError('E11', 'scip indexing produced no index', {
      reason: 'index.scip was not created',
      suggestion: 'Recheck scip-typescript output options.',
      evidence: { command: args.join(' '), durationMs },
    });
  }
  return {
    indexPath,
    exitCode: run.exitCode,
    durationMs,
    command: args.join(' '),
    stderrSummary: run.stderr.trim().split(/\r?\n/).slice(-8).join('\n'),
  };
}

export function readScipIndex(indexPath: string): ScipIndexData {
  const module = loadScipModule();
  let raw: Record<string, unknown>;
  try {
    raw = module.scip.Index.deserializeBinary(fs.readFileSync(indexPath)).toObject();
  } catch (error) {
    throw nexusError('E11', 'scip index is not a valid protobuf payload', {
      reason: error instanceof Error ? error.message : String(error),
      suggestion: 'Delete .nexus/tmp and rebuild.',
      evidence: { indexPath: path.basename(indexPath) },
    });
  }
  const metadata = asRecord(raw.metadata) ?? {};
  const documents = Array.isArray(raw.documents) ? raw.documents : [];
  return {
    metadata: {
      version: typeof metadata.version === 'number' ? metadata.version : 0,
      toolName:
        typeof metadata.tool_info === 'object' && metadata.tool_info !== null
          ? String((metadata.tool_info as Record<string, unknown>).name ?? '')
          : '',
      toolVersion:
        typeof metadata.tool_info === 'object' && metadata.tool_info !== null
          ? String((metadata.tool_info as Record<string, unknown>).version ?? '')
          : '',
      projectRoot: typeof metadata.project_root === 'string' ? metadata.project_root : '',
      textDocumentEncoding:
        typeof metadata.text_document_encoding === 'number' ? metadata.text_document_encoding : 0,
    },
    documents: documents.map((document) => {
      const record = asRecord(document) ?? {};
      const occurrences = Array.isArray(record.occurrences) ? record.occurrences : [];
      return {
        path: String(record.relative_path ?? '').replaceAll('\\', '/'),
        language: String(record.language ?? ''),
        symbolCount: Array.isArray(record.symbols) ? record.symbols.length : 0,
        occurrences: occurrences.map((occurrence) => {
          const value = asRecord(occurrence) ?? {};
          return {
            range: Array.isArray(value.range)
              ? value.range.filter((n): n is number => typeof n === 'number')
              : [],
            symbol: typeof value.symbol === 'string' ? value.symbol : '',
            symbolRoles: typeof value.symbol_roles === 'number' ? value.symbol_roles : 0,
            syntaxKind: typeof value.syntax_kind === 'number' ? value.syntax_kind : 0,
            enclosingRange: Array.isArray(value.enclosing_range)
              ? value.enclosing_range.filter((n): n is number => typeof n === 'number')
              : [],
          };
        }),
      };
    }),
    externalSymbols: Array.isArray(raw.external_symbols)
      ? raw.external_symbols.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function isDefinition(occurrence: ScipOccurrence): boolean {
  return (occurrence.symbolRoles & 1) !== 0;
}

export function isImport(occurrence: ScipOccurrence): boolean {
  return (occurrence.symbolRoles & 2) !== 0;
}

export function isWriteAccess(occurrence: ScipOccurrence): boolean {
  return (occurrence.symbolRoles & 4) !== 0;
}

export function scipDescriptorName(symbol: string): string {
  if (symbol === '') return '';
  const segments = symbol.split('/').filter((segment) => segment.length > 0);
  const descriptor = segments.at(-1) ?? '';
  const withoutSuffix = descriptor.replace(/\(\)\.$/, '').replace(/[.#]$/, '');
  const names = withoutSuffix.split(/[#.]/).filter((name) => name.length > 0);
  return names.at(-1) ?? '';
}
