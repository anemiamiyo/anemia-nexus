import fs from 'node:fs';
import path from 'node:path';

import type { RootManifest } from '../store/manifest.js';
import { databasePath, manifestPath, readManifest } from '../store/manifest.js';
import { latestCommittedBuild, openDatabase } from '../store/db.js';
import { readSurface } from '../surface/store.js';

/**
 * Incremental consistency gate (docs/12-indexing.md 12.2). This module only
 * compares; it never "fixes" an incremental result by copying the full one.
 * A mismatch is a release blocker, not a warning.
 */
export const EQUIVALENCE_FIELDS = [
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
] as const;

export type EquivalenceField = (typeof EQUIVALENCE_FIELDS)[number];

export interface FieldComparison {
  field: EquivalenceField;
  equal: boolean;
  incrementalCount: number;
  fullCount: number;
  differences: number;
  sample: string[];
}

export interface EquivalenceResult {
  pass: boolean;
  fields: FieldComparison[];
  totalDifferences: number;
}

export interface EquivalenceOptions {
  /** Incremental project (built with `nex update`). */
  incrementalProject: string;
  /** Fresh full-build project over the same sources. */
  fullProject: string;
  rootIds?: readonly string[];
  /** First N differences printed per field (default 20). */
  sampleLimit?: number;
}

interface Rows {
  rows: string[];
  raw?: unknown;
}

function readCommitted(dbPath: string): {
  db: ReturnType<typeof openDatabase>;
  buildId: string;
  fingerprint: string;
} | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = openDatabase(dbPath, { readOnly: true });
    const build = latestCommittedBuild(db);
    if (build === null) {
      db.close();
      return null;
    }
    return { db, buildId: build.buildId, fingerprint: build.fingerprint };
  } catch {
    return null;
  }
}

function queryRows(
  db: ReturnType<typeof openDatabase>,
  sql: string,
  params: ReadonlyArray<string | number>,
  mapper: (row: Record<string, unknown>) => string,
): string[] {
  try {
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapper);
  } catch {
    return [];
  }
}

function symbolsOf(dbPath: string): Rows | null {
  const read = readCommitted(dbPath);
  if (read === null) return null;
  try {
    const rows = queryRows(
      read.db,
      `select symbol_id as symbolId, name, kind, signature, visibility, identity_confidence as identityConfidence
       from symbols where build_id = ? order by symbol_id`,
      [read.buildId],
      (row) =>
        [
          row.symbolId,
          row.name,
          row.kind,
          row.signature,
          row.visibility,
          row.identityConfidence,
        ].join('\u0001'),
    );
    return { rows };
  } finally {
    read.db.close();
  }
}

function identityOf(dbPath: string): Rows | null {
  const read = readCommitted(dbPath);
  if (read === null) return null;
  try {
    const rows = queryRows(
      read.db,
      `select symbol_id as symbolId from symbol_id_history where status = 'active' order by symbol_id`,
      [],
      (row) => String(row.symbolId ?? ''),
    );
    return { rows };
  } finally {
    read.db.close();
  }
}

function referencesOf(dbPath: string): Rows | null {
  const read = readCommitted(dbPath);
  if (read === null) return null;
  try {
    const rows = queryRows(
      read.db,
      `select source_symbol_id as sourceId, target_symbol_id as targetId, kind, relation_class as relationClass, confidence
       from "references" where build_id = ?`,
      [read.buildId],
      (row) =>
        [row.sourceId, row.targetId, row.kind, row.relationClass, row.confidence].join('\u0001'),
    );
    return { rows: rows.sort() };
  } finally {
    read.db.close();
  }
}

function filesOf(dbPath: string): Rows | null {
  const read = readCommitted(dbPath);
  if (read === null) return null;
  try {
    const rows = queryRows(
      read.db,
      `select path, source_hash as sourceHash, status from files where build_id = ? order by path`,
      [read.buildId],
      (row) => [row.path, row.sourceHash, row.status].join('\u0001'),
    );
    return { rows };
  } finally {
    read.db.close();
  }
}

function edgesOf(dbPath: string): Rows | null {
  const read = readCommitted(dbPath);
  if (read === null) return null;
  try {
    const dependencies = queryRows(
      read.db,
      `select source_file as sourceFile, target_file as targetFile, dep_type as depType,
              relation_class as relationClass, confidence, analysis_engine as analysisEngine,
              specifier, target_root_id as targetRootId
       from dependencies where build_id = ?`,
      [read.buildId],
      (row) =>
        [
          'dep',
          row.sourceFile,
          row.targetFile,
          row.depType,
          row.relationClass,
          row.confidence,
          row.analysisEngine,
          row.specifier,
          row.targetRootId,
        ].join('\u0001'),
    );
    const calls = queryRows(
      read.db,
      `select caller_symbol_id as callerId, callee_symbol_id as calleeId, caller_file as callerFile,
              callee_file as calleeFile, line, col, resolution, relation_class as relationClass,
              confidence, analysis_engine as analysisEngine
       from calls where build_id = ?`,
      [read.buildId],
      (row) =>
        [
          'call',
          row.callerId,
          row.calleeId,
          row.callerFile,
          row.calleeFile,
          row.line,
          row.col,
          row.resolution,
          row.relationClass,
          row.confidence,
          row.analysisEngine,
        ].join('\u0001'),
    );
    return { rows: [...dependencies, ...calls].sort() };
  } finally {
    read.db.close();
  }
}

function surfaceOf(
  projectRoot: string,
  rootId: string,
): {
  hash: string;
  entries: string[];
} | null {
  const read = readSurface(projectRoot, rootId);
  if (read.surface === null) return null;
  const entries = read.surface.entries
    .map((entry) =>
      [
        entry.entryPath ?? '',
        entry.condition ?? '',
        entry.exportKind ?? '',
        entry.symbolId ?? '',
        entry.name ?? '',
      ].join('\u0001'),
    )
    .sort();
  return { hash: read.surface.surfaceHash, entries };
}

const MANIFEST_IGNORED = new Set([
  'buildId',
  'builtAt',
  'lastSuccessAt',
  'lastFailureAt',
  'lastFailureCode',
  'timings',
  'memory',
  'dbBytes',
  'walBytes',
  'recoveryEvents',
  'recovered',
  'resources',
  'configLoads',
  'changed',
  'invalidatedFiles',
  'gitCommit',
  'mode',
  'lastIntegrityCheck',
  'statHash',
  'tsconfigMtimeMs',
  'tsconfigSize',
]);

function sanitizedManifest(manifest: RootManifest | null): string {
  if (manifest === null) return '';
  const copy: Record<string, unknown> = { ...manifest };
  for (const key of MANIFEST_IGNORED) delete copy[key];
  if (copy.coverage !== undefined) delete copy.coverage;
  return JSON.stringify(copy);
}

function compareRows(
  field: EquivalenceField,
  incremental: Rows | null,
  full: Rows | null,
  sampleLimit: number,
): FieldComparison {
  const left = incremental?.rows ?? [];
  const right = full?.rows ?? [];
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) - 1);
  const differences: string[] = [];
  let total = 0;
  for (const [value, delta] of counts) {
    if (delta === 0) continue;
    total += Math.abs(delta);
    if (differences.length < sampleLimit) {
      differences.push(
        `${delta > 0 ? 'incremental-only' : 'full-only'} x${Math.abs(delta)}: ${value}`,
      );
    }
  }
  return {
    field,
    equal: total === 0 && incremental !== null && full !== null,
    incrementalCount: left.length,
    fullCount: right.length,
    differences: total,
    sample: differences,
  };
}

function compareManifests(
  incremental: RootManifest | null,
  full: RootManifest | null,
  sampleLimit: number,
): FieldComparison {
  const left = sanitizedManifest(incremental);
  const right = sanitizedManifest(full);
  const equal = incremental !== null && full !== null && left === right;
  return {
    field: 'manifest',
    equal,
    incrementalCount: incremental === null ? 0 : 1,
    fullCount: full === null ? 0 : 1,
    differences: equal ? 0 : 1,
    sample:
      equal || sampleLimit === 0
        ? []
        : [`incremental=${left.slice(0, 300)}`, `full=${right.slice(0, 300)}`],
  };
}

function compareCoverage(
  incremental: RootManifest | null,
  full: RootManifest | null,
  sampleLimit: number,
): FieldComparison {
  const left = JSON.stringify(incremental?.coverage ?? null);
  const right = JSON.stringify(full?.coverage ?? null);
  const equal = incremental !== null && full !== null && left === right;
  return {
    field: 'coverage',
    equal,
    incrementalCount: incremental === null ? 0 : 1,
    fullCount: full === null ? 0 : 1,
    differences: equal ? 0 : 1,
    sample: equal || sampleLimit === 0 ? [] : [`incremental=${left}`, `full=${right}`],
  };
}

function compareSurface(
  rootId: string,
  incrementalProject: string,
  fullProject: string,
  sampleLimit: number,
): FieldComparison[] {
  const left = surfaceOf(incrementalProject, rootId);
  const right = surfaceOf(fullProject, rootId);
  const hashEqual = left !== null && right !== null && left.hash === right.hash;
  const exportComparison = compareRows(
    'exports',
    left === null ? null : { rows: left.entries },
    right === null ? null : { rows: right.entries },
    sampleLimit,
  );
  return [
    exportComparison,
    {
      field: 'surfaceHash',
      equal: hashEqual,
      incrementalCount: left === null ? 0 : 1,
      fullCount: right === null ? 0 : 1,
      differences: hashEqual ? 0 : 1,
      sample:
        hashEqual || sampleLimit === 0
          ? []
          : [`incremental=${left?.hash ?? 'missing'}`, `full=${right?.hash ?? 'missing'}`],
    },
  ];
}

export function listManifestRoots(projectRoot: string): string[] {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(rootsDir)) return [];
  try {
    return fs
      .readdirSync(rootsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.lock'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Compare one root. All ten fields are compared independently; a null side is
 * a mismatch, never "skipped".
 */
export function compareRoot(options: {
  incrementalProject: string;
  fullProject: string;
  rootId: string;
  sampleLimit?: number;
}): FieldComparison[] {
  const sampleLimit = options.sampleLimit ?? 20;
  const leftManifest = readManifest(
    manifestPath(options.incrementalProject, options.rootId),
  ).manifest;
  const rightManifest = readManifest(manifestPath(options.fullProject, options.rootId)).manifest;
  const leftDb = databasePath(options.incrementalProject, options.rootId);
  const rightDb = databasePath(options.fullProject, options.rootId);
  const fields: FieldComparison[] = [];
  fields.push(compareRows('symbols', symbolsOf(leftDb), symbolsOf(rightDb), sampleLimit));
  fields.push(compareRows('identity', identityOf(leftDb), identityOf(rightDb), sampleLimit));
  fields.push(compareRows('references', referencesOf(leftDb), referencesOf(rightDb), sampleLimit));
  fields.push(
    ...compareSurface(options.rootId, options.incrementalProject, options.fullProject, sampleLimit),
  );
  fields.push(compareRows('files', filesOf(leftDb), filesOf(rightDb), sampleLimit));
  fields.push(compareRows('edges', edgesOf(leftDb), edgesOf(rightDb), sampleLimit));
  const leftFingerprint = leftManifest?.buildFingerprint ?? '';
  const rightFingerprint = rightManifest?.buildFingerprint ?? '';
  const degradedEqual =
    JSON.stringify(leftManifest?.degraded ?? null) ===
    JSON.stringify(rightManifest?.degraded ?? null);
  fields.push({
    field: 'buildFingerprint',
    equal: leftFingerprint !== '' && leftFingerprint === rightFingerprint && degradedEqual,
    incrementalCount: leftFingerprint === '' ? 0 : 1,
    fullCount: rightFingerprint === '' ? 0 : 1,
    differences: leftFingerprint === rightFingerprint && degradedEqual ? 0 : 1,
    sample:
      leftFingerprint === rightFingerprint && degradedEqual
        ? []
        : [
            `incremental=${leftFingerprint} degraded=${JSON.stringify(leftManifest?.degraded ?? null)}`,
            `full=${rightFingerprint} degraded=${JSON.stringify(rightManifest?.degraded ?? null)}`,
          ],
  });
  fields.push(compareCoverage(leftManifest, rightManifest, sampleLimit));
  fields.push(compareManifests(leftManifest, rightManifest, sampleLimit));
  return fields;
}

export function verifyIncrementalEquivalence(options: EquivalenceOptions): EquivalenceResult {
  const rootIds = options.rootIds ?? listManifestRoots(options.incrementalProject);
  const fields: FieldComparison[] = [];
  for (const rootId of rootIds) {
    fields.push(
      ...compareRoot({
        incrementalProject: options.incrementalProject,
        fullProject: options.fullProject,
        rootId,
        sampleLimit: options.sampleLimit,
      }),
    );
  }
  const required = new Set<string>(EQUIVALENCE_FIELDS);
  // Every field must be present at least once; a missing field is a failure.
  for (const field of required) {
    if (!fields.some((entry) => entry.field === field)) {
      fields.push({
        field: field as EquivalenceField,
        equal: false,
        incrementalCount: 0,
        fullCount: 0,
        differences: 1,
        sample: ['field missing from comparison'],
      });
    }
  }
  const totalDifferences = fields.reduce((sum, entry) => sum + entry.differences, 0);
  return {
    pass: totalDifferences === 0 && fields.every((entry) => entry.equal),
    fields,
    totalDifferences,
  };
}

/** Text diff snapshot for CI logs: first 20 differences per field. */
export function formatEquivalenceReport(result: EquivalenceResult): string {
  const lines: string[] = [];
  for (const field of result.fields) {
    lines.push(
      `${field.field}: ${field.equal ? 'equal' : 'DIFF'} (incremental=${field.incrementalCount}, full=${field.fullCount}, differences=${field.differences})`,
    );
    for (const sample of field.sample) lines.push(`  ${sample}`);
  }
  lines.push(`result: ${result.pass ? 'pass' : 'fail'} (${result.totalDifferences} differences)`);
  return lines.join('\n');
}
