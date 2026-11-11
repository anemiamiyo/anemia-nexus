import fs from 'node:fs';
import path from 'node:path';

import type { Coverage, StalenessState } from '../model.js';
import type { ANALYZER_VERSION } from '../index/analyzer.js';

export interface ManifestCoverage extends Coverage {
  semanticCoverage: number | null;
  filesSkippedBySize: number;
  filesOutsideRoot: number;
  hashCollisions: number;
}

export interface ManifestTimings {
  scanMs: number;
  analyzeMs: number;
  scipMs: number;
  mapMs: number;
  writeMs: number;
  totalMs: number;
}

export interface RootManifest {
  schemaVersion: number;
  indexVersion: number;
  rootId: string;
  rootPath: string;
  packageName: string | null;
  tsconfig: string | null;
  buildId: string;
  buildFingerprint: string;
  filesHash: string;
  configHash: string;
  rootSetHash: string;
  ignoreHash: string;
  analyzerVersion: typeof ANALYZER_VERSION;
  nodeVersion: string;
  sqliteVersion: string;
  platform: string;
  state: 'ready' | 'stale' | 'failed';
  staleness: StalenessState;
  counts: {
    files: number;
    symbols: number;
    references: number;
    unresolvedReferences: number;
  };
  coverage: ManifestCoverage;
  stats: {
    exact: number;
    structural: number;
    conflict: number;
    unmapped: number;
    externalReferences: number;
    localOrUnmappedReferences: number;
    mappingSuccessRate: number;
  };
  timings: ManifestTimings;
  memory: {
    peakRssMB: number;
    scipPeakRssMB: number | null;
    scipPeakRssUnavailableReason: string | null;
  };
  dbBytes: number;
  walBytes: number;
  degraded: string[];
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  configLoads: Array<{
    path: string;
    contentHash: string;
    authorization: string;
    durationMs: number;
    result: string;
  }>;
  builtAt: string;
  lastSuccessAt: string;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
}

export function rootDirectory(projectRoot: string, rootId: string): string {
  return path.join(projectRoot, '.nexus', 'roots', rootId);
}

export function manifestPath(projectRoot: string, rootId: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'manifest.json');
}

export function databasePath(projectRoot: string, rootId: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'index.db');
}

export function writeManifestAtomic(filePath: string, manifest: RootManifest): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, payload, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(temporary, filePath);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // best effort cleanup
      }
      throw error;
    }
  }
}

export interface ManifestReadResult {
  manifest: RootManifest | null;
  error: string | null;
}

export function readManifest(filePath: string): ManifestReadResult {
  if (!fs.existsSync(filePath)) return { manifest: null, error: 'manifest.json not found' };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      return { manifest: null, error: 'manifest is not an object' };
    }
    const value = raw as Record<string, unknown>;
    if (
      typeof value.buildId !== 'string' ||
      typeof value.buildFingerprint !== 'string' ||
      typeof value.rootId !== 'string' ||
      typeof value.schemaVersion !== 'number' ||
      typeof value.coverage !== 'object' ||
      value.coverage === null
    ) {
      return { manifest: null, error: 'manifest is missing required fields' };
    }
    return { manifest: raw as RootManifest, error: null };
  } catch (error) {
    return { manifest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function dbSizes(dbPath: string): { dbBytes: number; walBytes: number } {
  const size = (candidate: string): number => {
    try {
      return fs.statSync(candidate).size;
    } catch {
      return 0;
    }
  };
  return { dbBytes: size(dbPath), walBytes: size(`${dbPath}-wal`) };
}
