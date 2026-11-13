import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ANALYZER_VERSION } from '../index/analyzer.js';
import { SCHEMA_VERSION } from './schema.js';
import {
  dbSizes,
  manifestPath,
  readManifest,
  rootDirectory,
  writeManifestAtomic,
  type RootManifest,
} from './manifest.js';
import { databasePath } from './manifest.js';
import {
  integrityCheck,
  latestCommittedBuild,
  openDatabase,
  readSchemaVersion,
  type CommittedBuildRow,
} from './db.js';
import { pendingBuilds } from './db.js';
import { endIndexing, readIndexingMarker, isProcessAlive } from './state.js';
import { clearDeadRootLock } from './lock.js';

/**
 * Startup recovery (docs/12-indexing.md 12.3.3). **The database is
 * authoritative; manifest/surface/workspace are derived views.** Every
 * inconsistency is resolved in favour of the latest `committed` build record.
 */
export type RecoveryOutcome =
  | 'normal'
  | 'manifest-repaired'
  | 'pending-discarded'
  | 'stale-surface'
  | 'invalid'
  | 'corrupt'
  | 'missing';

export interface RecoveryResult {
  rootId: string;
  outcome: RecoveryOutcome;
  readable: boolean;
  errorCode: string | null;
  actions: string[];
}

export interface RecoveryOptions {
  /** Persist repairs (default true). `false` only classifies. */
  repair?: boolean;
  /**
   * Run `PRAGMA integrity_check` (default true). Query paths pass false to
   * avoid scanning a multi-MB database on every read; build/update/doctor keep
   * the full check.
   */
  integrityCheck?: boolean;
}

export function recoveryEventsPath(projectRoot: string, rootId: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'recovery-events.jsonl');
}

export function surfacePathFor(rootId: string, projectRoot: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'surface.json');
}

function appendRecoveryEvent(
  projectRoot: string,
  rootId: string,
  action: string,
  detail: Record<string, unknown>,
): void {
  const filePath = recoveryEventsPath(projectRoot, rootId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), action, ...detail })}\n`;
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split('\n') : [];
    const kept = existing.filter((entry) => entry.trim() !== '').slice(-19);
    fs.writeFileSync(filePath, `${[...kept, line.trim()].join('\n')}\n`, 'utf8');
  } catch {
    // Event logging is diagnostic; never fail recovery on it.
  }
}

function countRows(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  try {
    const row = db.prepare(sql).get(...params) as { count?: unknown } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  } catch {
    return 0;
  }
}

function readBuildRow(db: DatabaseSync, buildId: string): Record<string, unknown> | null {
  try {
    const row = db
      .prepare(
        `select build_id as buildId, fingerprint, status, root_id as rootId, started_at as startedAt,
                finished_at as finishedAt, files_hash as filesHash, config_hash as configHash,
                schema_version as schemaVersion, analyzer_version_json as analyzerVersionJson,
                root_set_hash as rootSetHash, node_version as nodeVersion,
                sqlite_version as sqliteVersion, platform, degraded_json as degradedJson,
                built_at as builtAt
         from build_record where build_id = ?`,
      )
      .get(buildId) as Record<string, unknown> | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function workspaceEntry(
  projectRoot: string,
  rootId: string,
): { rootPath: string; packageName: string | null; tsconfig: string | null } | null {
  const filePath = path.join(projectRoot, '.nexus', 'workspace.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      roots?: Array<Record<string, unknown>>;
    };
    const entry = parsed.roots?.find((root) => root.rootId === rootId);
    if (entry === undefined) return null;
    return {
      rootPath: typeof entry.rootPath === 'string' ? entry.rootPath : '.',
      packageName: typeof entry.packageName === 'string' ? entry.packageName : null,
      tsconfig: typeof entry.tsconfig === 'string' ? entry.tsconfig : null,
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild a manifest from authoritative DB rows when the manifest is old,
 * missing or corrupt. Counts/coverage are derived from the DB; timing and
 * memory fields are zeroed and the manifest is flagged `recovered`, which
 * keeps the state `stale` until a verified rebuild.
 */
function manifestFromDatabase(input: {
  projectRoot: string;
  rootId: string;
  committed: CommittedBuildRow;
  db: DatabaseSync;
  previous: RootManifest | null;
  actions: string[];
}): RootManifest {
  const { projectRoot, rootId, committed, db, previous, actions } = input;
  const row = readBuildRow(db, committed.buildId) ?? {};
  const fromWorkspace = workspaceEntry(projectRoot, rootId);
  const buildId = committed.buildId;
  let analyzerVersion: RootManifest['analyzerVersion'] = ANALYZER_VERSION;
  if (typeof row.analyzerVersionJson === 'string') {
    try {
      analyzerVersion = JSON.parse(row.analyzerVersionJson) as RootManifest['analyzerVersion'];
    } catch {
      // Keep the current tuple; the recovered manifest is stale anyway.
    }
  }
  let degraded: string[] = [];
  if (typeof row.degradedJson === 'string') {
    try {
      const parsed = JSON.parse(row.degradedJson) as unknown;
      if (Array.isArray(parsed)) {
        degraded = parsed.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      degraded = [];
    }
  }
  const files = countRows(db, 'select count(*) as count from files where build_id = ?', buildId);
  const symbols = countRows(
    db,
    'select count(*) as count from symbols where build_id = ?',
    buildId,
  );
  const references = countRows(
    db,
    'select count(*) as count from "references" where build_id = ?',
    buildId,
  );
  const certain = countRows(
    db,
    `select count(*) as count from "references" where build_id = ? and relation_class = 'certain'`,
    buildId,
  );
  const unmapped = countRows(
    db,
    `select count(*) as count from symbols where build_id = ? and mapping_quality = 'unmapped'`,
    buildId,
  );
  const dependencies = countRows(
    db,
    'select count(*) as count from dependencies where build_id = ?',
    buildId,
  );
  const calls = countRows(db, 'select count(*) as count from calls where build_id = ?', buildId);
  const tests = countRows(db, 'select count(*) as count from tests where build_id = ?', buildId);
  const sizes = dbSizes(databasePath(projectRoot, rootId));
  const surface = (() => {
    try {
      const surfaceFile = surfacePathFor(rootId, projectRoot);
      if (!fs.existsSync(surfaceFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(surfaceFile, 'utf8')) as {
        buildId?: unknown;
        surfaceHash?: unknown;
        entries?: unknown;
      };
      if (parsed.buildId !== buildId || typeof parsed.surfaceHash !== 'string') return null;
      return {
        hash: parsed.surfaceHash,
        entries: Array.isArray(parsed.entries) ? parsed.entries.length : 0,
      };
    } catch {
      return null;
    }
  })();
  const builtAt =
    typeof row.builtAt === 'string'
      ? row.builtAt
      : typeof row.finishedAt === 'string'
        ? row.finishedAt
        : new Date().toISOString();
  const coverage: RootManifest['coverage'] = {
    filesCovered: files,
    filesSkipped: 0,
    filesIgnored: previous?.coverage.filesIgnored ?? 0,
    filesFailed: 0,
    resolved: certain,
    unresolved: Math.max(references - certain, 0),
    unmapped,
    filteredInternal: 0,
    semanticCoverage: null,
    filesSkippedBySize: 0,
    filesOutsideRoot: 0,
    hashCollisions: 0,
    dependencies,
    calls,
  };
  actions.push('manifest-rebuilt-from-db');
  return {
    schemaVersion: SCHEMA_VERSION,
    indexVersion: 2,
    rootId,
    rootPath:
      fromWorkspace?.rootPath ??
      previous?.rootPath ??
      (typeof row.rootPath === 'string' ? row.rootPath : '.'),
    packageName: fromWorkspace?.packageName ?? previous?.packageName ?? null,
    tsconfig: fromWorkspace?.tsconfig ?? previous?.tsconfig ?? null,
    buildId,
    buildFingerprint: typeof row.fingerprint === 'string' ? row.fingerprint : committed.fingerprint,
    filesHash: typeof row.filesHash === 'string' ? row.filesHash : '',
    configHash: typeof row.configHash === 'string' ? row.configHash : '',
    rootSetHash: typeof row.rootSetHash === 'string' ? row.rootSetHash : '',
    ignoreHash: previous?.ignoreHash ?? '',
    tsconfigHash: previous?.tsconfigHash ?? '',
    analyzerVersion,
    nodeVersion:
      typeof row.nodeVersion === 'string' ? row.nodeVersion : (previous?.nodeVersion ?? ''),
    sqliteVersion:
      typeof row.sqliteVersion === 'string' ? row.sqliteVersion : (previous?.sqliteVersion ?? ''),
    platform: typeof row.platform === 'string' ? row.platform : (previous?.platform ?? ''),
    state: 'ready',
    staleness: 'stale',
    counts: {
      files,
      symbols,
      references,
      unresolvedReferences: Math.max(references - certain, 0),
      dependencies,
      calls,
      tests,
    },
    coverage,
    graph: {
      dependencies,
      calls,
      tests,
      styleEdges: 0,
      crossRootEdges: 0,
      architectureViolations: 0,
      byConfidence: {},
      byType: {},
    },
    stats: {
      exact: 0,
      structural: 0,
      conflict: 0,
      unmapped,
      externalReferences: 0,
      localOrUnmappedReferences: 0,
      mappingSuccessRate: 0,
      falseMatchCount: 0,
    },
    timings: {
      scanMs: 0,
      analyzeMs: 0,
      vueMs: 0,
      scipMs: 0,
      mapMs: 0,
      graphMs: 0,
      writeMs: 0,
      writeBatches: 0,
      totalMs: 0,
    },
    memory: { peakRssMB: 0, scipPeakRssMB: null, scipPeakRssUnavailableReason: 'recovered' },
    dbBytes: sizes.dbBytes,
    walBytes: sizes.walBytes,
    surfaceHash: surface?.hash,
    surfaceEntries: surface?.entries,
    degraded,
    warnings: [
      ...(previous?.warnings ?? []).filter((warning) => warning.message !== 'manifest-recovered'),
      {
        code: 'E19',
        message: 'manifest-recovered',
        severity: 'warning' as const,
      },
    ],
    configLoads: previous?.configLoads ?? [],
    gitCommit: previous?.gitCommit ?? null,
    mode: 'full',
    changed: undefined,
    invalidatedFiles: [],
    lastIntegrityCheck: previous?.lastIntegrityCheck ?? null,
    recoveryEvents: [...(previous?.recoveryEvents ?? []), ...actions],
    recovered: true,
    builtAt,
    lastSuccessAt: builtAt,
    lastFailureAt: previous?.lastFailureAt ?? null,
    lastFailureCode: previous?.lastFailureCode ?? null,
  };
}

function readSurfaceIdentity(
  projectRoot: string,
  rootId: string,
): { buildId: string | null; matches: boolean } {
  const filePath = surfacePathFor(rootId, projectRoot);
  if (!fs.existsSync(filePath)) return { buildId: null, matches: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      buildId?: unknown;
      buildFingerprint?: unknown;
    };
    return {
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null,
      matches: typeof parsed.buildFingerprint === 'string',
    };
  } catch {
    return { buildId: null, matches: false };
  }
}

export function recoverRoot(
  projectRoot: string,
  rootId: string,
  options: RecoveryOptions = {},
): RecoveryResult {
  const repair = options.repair ?? true;
  const checkIntegrity = options.integrityCheck ?? true;
  const actions: string[] = [];
  const dbPath = databasePath(projectRoot, rootId);
  const manifestFile = manifestPath(projectRoot, rootId);
  if (!fs.existsSync(dbPath)) {
    return { rootId, outcome: 'missing', readable: false, errorCode: null, actions: [] };
  }

  // A live process is mid-build; do not touch its transaction.
  const marker = readIndexingMarker(projectRoot, rootId);
  if (marker !== null && isProcessAlive(marker.pid) && marker.pid !== process.pid) {
    return { rootId, outcome: 'normal', readable: true, errorCode: null, actions: ['indexing'] };
  }
  if (marker !== null) {
    if (repair) endIndexing(projectRoot, rootId);
    actions.push('cleared-stale-indexing-marker');
  }

  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(dbPath);
    const integrity = checkIntegrity ? integrityCheck(db) : { ok: true, errors: [] as string[] };
    if (!integrity.ok) {
      return {
        rootId,
        outcome: 'corrupt',
        readable: false,
        errorCode: 'E07',
        actions: [`integrity:${integrity.errors[0] ?? 'failed'}`],
      };
    }
    if (readSchemaVersion(db) !== SCHEMA_VERSION) {
      return { rootId, outcome: 'invalid', readable: false, errorCode: 'E06', actions: [] };
    }
    const committed = latestCommittedBuild(db);
    const pending = pendingBuilds(db);
    const manifestRead = readManifest(manifestFile);
    const manifest = manifestRead.manifest;

    if (committed === null) {
      const files = countRows(db, 'select count(*) as count from files');
      if (pending.length > 0 || files > 0) {
        if (repair) {
          appendRecoveryEvent(projectRoot, rootId, 'invalid-no-committed', {
            pending: pending.length,
            files,
          });
        }
        return { rootId, outcome: 'invalid', readable: false, errorCode: 'E19', actions };
      }
      return { rootId, outcome: 'missing', readable: false, errorCode: null, actions };
    }

    // Step 1: pending + manifest pointing at the pending build is a protocol
    // violation (docs/12-indexing.md 12.3.3).
    if (manifest !== null && pending.some((row) => row.buildId === manifest.buildId)) {
      if (repair) {
        appendRecoveryEvent(projectRoot, rootId, 'invalid-pending-manifest', {
          buildId: manifest.buildId,
        });
      }
      return { rootId, outcome: 'invalid', readable: false, errorCode: 'E19', actions };
    }

    // Step 2: discard unreachable pending rows, keep the previous committed.
    let discarded = 0;
    if (pending.length > 0) {
      if (repair) {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of pending) {
            for (const table of [
              '"references"',
              'dependencies',
              'calls',
              'architecture_violations',
              'architecture_modules',
              'symbol_map',
              'components',
              'vue_file_meta',
              'tests',
              'symbols',
              'files',
            ]) {
              db.prepare(`delete from ${table} where build_id = ?`).run(row.buildId);
            }
            db.prepare('delete from build_record where build_id = ?').run(row.buildId);
          }
          db.exec('COMMIT');
        } catch {
          try {
            db.exec('ROLLBACK');
          } catch {
            // no active transaction
          }
        }
        appendRecoveryEvent(projectRoot, rootId, 'pending-discarded', {
          count: pending.length,
        });
      }
      discarded = pending.length;
      actions.push(`pending-discarded:${discarded}`);
    }

    // Step 3: manifest must point at the authoritative committed build.
    const surface = readSurfaceIdentity(projectRoot, rootId);
    if (
      manifest === null ||
      manifest.buildId !== committed.buildId ||
      manifest.buildFingerprint !== committed.fingerprint
    ) {
      if (repair) {
        const rebuilt = manifestFromDatabase({
          projectRoot,
          rootId,
          committed,
          db,
          previous: manifest,
          actions,
        });
        if (surface.buildId !== committed.buildId) {
          rebuilt.warnings.push({
            code: 'E19',
            message: 'surface-mismatch',
            severity: 'warning',
          });
        }
        writeManifestAtomic(manifestFile, rebuilt);
        appendRecoveryEvent(projectRoot, rootId, 'manifest-repaired', {
          from: manifest?.buildId ?? null,
          to: committed.buildId,
        });
      }
      return {
        rootId,
        outcome: discarded > 0 ? 'pending-discarded' : 'manifest-repaired',
        readable: true,
        errorCode: null,
        actions,
      };
    }

    // Step 4: committed + manifest agree. A derived surface that does not
    // match is marked stale; we do not fabricate surface content.
    if (surface.buildId !== committed.buildId) {
      if (repair) {
        const next: RootManifest = {
          ...manifest,
          staleness: 'stale',
          warnings: [
            ...manifest.warnings.filter((warning) => warning.message !== 'surface-mismatch'),
            { code: 'E19', message: 'surface-mismatch', severity: 'warning' },
          ],
          recoveryEvents: [...(manifest.recoveryEvents ?? []), 'surface-mismatch'],
        };
        writeManifestAtomic(manifestFile, next);
        appendRecoveryEvent(projectRoot, rootId, 'surface-mismatch', {
          expected: committed.buildId,
          actual: surface.buildId,
        });
      }
      return { rootId, outcome: 'stale-surface', readable: true, errorCode: null, actions };
    }

    if (discarded > 0) {
      if (repair) {
        const next: RootManifest = {
          ...manifest,
          staleness: 'stale',
          recoveryEvents: [...(manifest.recoveryEvents ?? []), 'pending-discarded'],
        };
        writeManifestAtomic(manifestFile, next);
      }
      return { rootId, outcome: 'pending-discarded', readable: true, errorCode: null, actions };
    }
    return { rootId, outcome: 'normal', readable: true, errorCode: null, actions };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'E07';
    return { rootId, outcome: 'corrupt', readable: false, errorCode: code, actions };
  } finally {
    db?.close();
  }
}

export interface WorkspaceRecoveryResult {
  roots: RecoveryResult[];
  repaired: string[];
  invalid: string[];
}

/**
 * Cheap pre-check for the query path: an indexing marker is left behind by
 * every interrupted commit (build writes it before the first write and only
 * clears it in `finally`), so its presence is the signal that the full startup
 * recovery is worth the DB scan. A missing manifest is also repaired eagerly.
 */
export function needsRecovery(projectRoot: string): boolean {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(rootsDir)) return false;
  try {
    for (const entry of fs.readdirSync(rootsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.lock')) continue;
      if (fs.existsSync(path.join(rootsDir, entry.name, 'indexing.json'))) return true;
      if (!fs.existsSync(path.join(rootsDir, entry.name, 'manifest.json'))) return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function recoverWorkspace(
  projectRoot: string,
  options: RecoveryOptions = {},
): WorkspaceRecoveryResult {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  const results: RecoveryResult[] = [];
  if (!fs.existsSync(rootsDir)) return { roots: results, repaired: [], invalid: [] };
  const entries = (() => {
    try {
      return fs
        .readdirSync(rootsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [] as string[];
    }
  })();
  // A SIGKILL'd build leaves `<root>.lock`; clear it only if its owner is dead.
  for (const entry of entries) {
    if (entry.endsWith('.lock')) clearDeadRootLock(path.join(rootsDir, entry.slice(0, -5)));
  }
  for (const rootId of entries) {
    if (rootId.endsWith('.lock')) continue;
    try {
      results.push(recoverRoot(projectRoot, rootId, options));
    } catch {
      results.push({
        rootId,
        outcome: 'corrupt',
        readable: false,
        errorCode: 'E07',
        actions: [],
      });
    }
  }
  return {
    roots: results,
    repaired: results
      .filter((result) => result.outcome !== 'normal' && result.readable)
      .map((result) => result.rootId),
    invalid: results
      .filter((result) => !result.readable && result.outcome !== 'missing')
      .map((result) => result.rootId),
  };
}
