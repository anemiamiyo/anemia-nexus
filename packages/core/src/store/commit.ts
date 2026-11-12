import fs from 'node:fs';

import { DatabaseSync } from 'node:sqlite';

import type {
  ComponentRecord,
  ReferenceRecord,
  SymbolRecord,
  VueFileMetaRecord,
} from '../model.js';
import type { ScannedFile } from '../discovery/scan.js';
import type { BuildFingerprintFields } from '../index/fingerprint.js';
import { nexusError } from '../errors.js';
import {
  ensureSchema,
  latestCommittedBuild,
  openDatabase,
  readSchemaVersion,
  requiredIndexesPresent,
  sqliteVersionOf,
} from './db.js';
import { applyHistory } from './history.js';
import { SCHEMA_VERSION } from './schema.js';

export interface MappingRow {
  symbolId: string;
  engine: 'scip' | 'ts' | 'vue';
  engineRef: string;
  matchQuality: string;
  evidence: unknown;
  analyzerVersion: string;
}

export interface CommitInput {
  dbPath: string;
  rootId: string;
  buildId: string;
  buildFingerprint: string;
  startedAt: string;
  finishedAt: string;
  fields: BuildFingerprintFields;
  files: readonly ScannedFile[];
  symbols: readonly SymbolRecord[];
  references: readonly ReferenceRecord[];
  mappingRows: readonly MappingRow[];
  components: readonly ComponentRecord[];
  vueFileMeta: readonly VueFileMetaRecord[];
}

export interface CommitResult {
  buildId: string;
  fingerprint: string;
  sqliteVersion: string;
  counts: { files: number; symbols: number; references: number };
}

export interface PreviousIdentityRow {
  locatorKey: string;
  symbolId: string;
  confidence: string;
  evidence: string[];
}

function locatorKeyOf(
  pathValue: string,
  startLine: number,
  startCol: number,
  kind: string,
  nameChain: string,
): string {
  return `${pathValue}:${startLine}:${startCol}:${kind}:${nameChain}`;
}

export function readPreviousIdentities(dbPath: string): Map<string, PreviousIdentityRow> {
  const map = new Map<string, PreviousIdentityRow>();
  if (!fs.existsSync(dbPath)) return map;
  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    if (readSchemaVersion(db) !== SCHEMA_VERSION) return map;
    const committed = latestCommittedBuild(db);
    if (committed === null) return map;
    const rows = db
      .prepare(
        'select symbol_id as symbolId, path, start_line as startLine, start_col as startCol, kind, name_chain as nameChain, identity_confidence as confidence, identity_evidence_json as evidenceJson from symbols where build_id = ?',
      )
      .all(committed.buildId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const symbolId = typeof row.symbolId === 'string' ? row.symbolId : '';
      const pathValue = typeof row.path === 'string' ? row.path : '';
      if (symbolId === '' || pathValue === '') continue;
      const startLine = typeof row.startLine === 'number' ? row.startLine : 0;
      const startCol = typeof row.startCol === 'number' ? row.startCol : 0;
      const kind = typeof row.kind === 'string' ? row.kind : '';
      const nameChain = typeof row.nameChain === 'string' ? row.nameChain : '';
      const key = locatorKeyOf(pathValue, startLine, startCol, kind, nameChain);
      map.set(key, {
        locatorKey: key,
        symbolId,
        confidence: typeof row.confidence === 'string' ? row.confidence : 'high',
        evidence: parseEvidence(row.evidenceJson),
      });
    }
    return map;
  } catch {
    return map;
  } finally {
    db?.close();
  }
}

function parseEvidence(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function beginImmediate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
}

/**
 * Startup recovery (docs/12-indexing.md 12.3.3): a pending build that never
 * flipped to committed has no readers, so its build-scoped rows are discarded.
 * The previous committed build is untouched.
 */
export function recoverPending(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  let db: DatabaseSync;
  try {
    db = openDatabase(dbPath);
  } catch {
    return 0;
  }
  try {
    if (readSchemaVersion(db) !== SCHEMA_VERSION) return 0;
    const pending = db
      .prepare("select build_id as buildId from build_record where status = 'pending'")
      .all() as Array<Record<string, unknown>>;
    if (pending.length === 0) return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of pending) {
        const buildId = typeof row.buildId === 'string' ? row.buildId : '';
        if (buildId === '') continue;
        db.prepare('delete from "references" where build_id = ?').run(buildId);
        db.prepare('delete from symbol_map where build_id = ?').run(buildId);
        db.prepare('delete from components where build_id = ?').run(buildId);
        db.prepare('delete from vue_file_meta where build_id = ?').run(buildId);
        db.prepare('delete from symbols where build_id = ?').run(buildId);
        db.prepare('delete from files where build_id = ?').run(buildId);
        db.prepare('delete from build_record where build_id = ?').run(buildId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no active transaction
      }
      throw error;
    }
    return pending.length;
  } finally {
    db.close();
  }
}

/** Keep data for the most recent `keep` committed builds (default 2). */
function pruneBuilds(db: DatabaseSync, keep = 2): void {
  const rows = db
    .prepare(
      "select build_id as buildId from build_record where status = 'committed' order by started_at desc",
    )
    .all() as Array<Record<string, unknown>>;
  const old = rows
    .slice(keep)
    .map((row) => (typeof row.buildId === 'string' ? row.buildId : ''))
    .filter((id) => id !== '');
  if (old.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const buildId of old) {
      db.prepare('delete from "references" where build_id = ?').run(buildId);
      db.prepare('delete from symbol_map where build_id = ?').run(buildId);
      db.prepare('delete from components where build_id = ?').run(buildId);
      db.prepare('delete from vue_file_meta where build_id = ?').run(buildId);
      db.prepare('delete from symbols where build_id = ?').run(buildId);
      db.prepare('delete from files where build_id = ?').run(buildId);
      db.prepare('delete from build_record where build_id = ?').run(buildId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no active transaction
    }
    throw error;
  }
}

/**
 * Commit protocol (docs/12-indexing.md 12.3.2): write data + pending record in
 * one immediate transaction, verify after commit on a read-only connection,
 * then flip the record to committed in a short transaction. The manifest is
 * written by the caller only after this returns.
 */
export function commitBuild(input: CommitInput): CommitResult {
  const { db } = ensureSchema(input.dbPath);
  const sqliteVersion = sqliteVersionOf(db);
  try {
    beginImmediate(db);
    try {
      db.prepare(
        `insert into build_record(build_id, fingerprint, status, root_id, started_at, finished_at, files_hash, config_hash, schema_version, analyzer_version_json, root_set_hash, node_version, sqlite_version, platform, degraded_json, built_at)
         values (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.buildId,
        input.buildFingerprint,
        input.rootId,
        input.startedAt,
        input.finishedAt,
        input.fields.filesHash,
        input.fields.configHash,
        input.fields.schemaVersion,
        JSON.stringify(input.fields.analyzerVersion),
        input.fields.rootSetHash,
        input.fields.nodeVersion,
        sqliteVersion,
        input.fields.platform,
        JSON.stringify(input.fields.degraded),
        input.finishedAt,
      );

      const insertFile = db.prepare(
        'insert into files(build_id, path, source_hash, language, size_bytes, status, is_generated) values (?, ?, ?, ?, ?, ?, 0)',
      );
      for (const file of input.files) {
        insertFile.run(
          input.buildId,
          file.path,
          file.sourceHash,
          file.language,
          file.size,
          'indexed',
        );
      }

      const insertSymbol = db.prepare(
        `insert into symbols(symbol_id, build_id, root_id, path, kind, name, name_chain, signature, visibility, is_public, export_kind, analysis_engine, is_type_only, identity_confidence, identity_evidence_json, volatile, anonymous, name_line, name_col, start_line, start_col, end_line, end_col, overload_ordinal, container_locator_key, syntax_context_hash, source_hash, mapping_quality)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const symbol of input.symbols) {
        insertSymbol.run(
          symbol.symbolId,
          input.buildId,
          symbol.rootId,
          symbol.path,
          symbol.kind,
          symbol.name,
          symbol.nameChain,
          symbol.signature,
          symbol.visibility,
          symbol.isPublic ? 1 : 0,
          symbol.exportKind,
          symbol.analysisEngine,
          symbol.isTypeOnly ? 1 : 0,
          symbol.identityConfidence,
          JSON.stringify(symbol.identityEvidence),
          symbol.volatile ? 1 : 0,
          symbol.anonymous ? 1 : 0,
          symbol.nameLine,
          symbol.nameCol,
          symbol.declarationLocator.startLine,
          symbol.declarationLocator.startCol,
          symbol.declarationLocator.endLine,
          symbol.declarationLocator.endCol,
          symbol.declarationLocator.overloadOrdinal,
          symbol.declarationLocator.containerLocatorKey,
          symbol.declarationLocator.syntaxContextHash,
          symbol.declarationLocator.sourceHash,
          symbol.mappingQuality,
        );
      }

      const insertReference = db.prepare(
        `insert into "references"(build_id, target_symbol_id, target_scip_symbol, source_symbol_id, source_file, kind, role, relation_class, confidence, analysis_engine, line, col, unresolved_reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const reference of input.references) {
        insertReference.run(
          input.buildId,
          reference.targetSymbolId,
          reference.targetScipSymbol,
          reference.sourceSymbolId,
          reference.sourceFile,
          reference.kind,
          reference.role,
          reference.relationClass,
          reference.confidence,
          reference.analysisEngine,
          reference.line,
          reference.col,
          reference.unresolvedReason,
        );
      }

      const insertMapping = db.prepare(
        'insert or replace into symbol_map(build_id, symbol_id, engine, engine_ref, match_quality, evidence_json, analyzer_version) values (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const row of input.mappingRows) {
        insertMapping.run(
          input.buildId,
          row.symbolId,
          row.engine,
          row.engineRef,
          row.matchQuality,
          JSON.stringify(row.evidence),
          row.analyzerVersion,
        );
      }

      const insertComponent = db.prepare(
        `insert into components(build_id, symbol_id, name, props_json, emits_json, slots_json, props_resolved, props_total, analysis_engine, source)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const component of input.components) {
        insertComponent.run(
          input.buildId,
          component.symbolId,
          component.name,
          JSON.stringify(component.props),
          JSON.stringify(component.emits),
          JSON.stringify(component.slots),
          component.propsCoverage.resolved,
          component.propsCoverage.total,
          component.analysisEngine,
          component.source,
        );
      }

      const insertVueMeta = db.prepare(
        `insert into vue_file_meta(build_id, path, source_hash, projector_version, language_core_version, generated_bytes, generated_at, filtered_internal, template_edges)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const meta of input.vueFileMeta) {
        insertVueMeta.run(
          input.buildId,
          meta.path,
          meta.sourceHash,
          meta.projectorVersion,
          meta.languageCoreVersion,
          meta.generatedBytes,
          meta.generatedAt,
          meta.filteredInternal,
          meta.templateEdges,
        );
      }

      applyHistory(db, input.symbols, input.buildFingerprint);

      assertClosure(db, input.buildId);
      const indexes = requiredIndexesPresent(db);
      if (!indexes.ok) {
        throw nexusError('E23', 'required indexes are missing after write', {
          reason: indexes.missing.join('; '),
          suggestion: 'Schema DDL and required-index list diverged; fix store/schema.ts.',
        });
      }
      if (input.files.length === 0) {
        throw nexusError('E23', 'build produced no files', {
          reason: 'coverage denominator would be zero',
          suggestion: 'Check include/ignore rules and tsconfig file list.',
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no active transaction
      }
      throw error;
    }
  } finally {
    db.close();
  }

  // Step 6: reopen read-only and verify the pending record + fingerprint.
  const verify = openDatabase(input.dbPath, { readOnly: true });
  try {
    const row = verify
      .prepare('select status, fingerprint from build_record where build_id = ?')
      .get(input.buildId) as { status?: unknown; fingerprint?: unknown } | undefined;
    if (
      row === undefined ||
      row.status !== 'pending' ||
      row.fingerprint !== input.buildFingerprint
    ) {
      throw nexusError('E19', 'build verification failed after commit', {
        reason: 'pending build record or fingerprint mismatch',
        suggestion: 'Run `nex doctor`; the index must be rebuilt.',
        evidence: { buildId: input.buildId },
      });
    }
  } finally {
    verify.close();
  }

  const flip = openDatabase(input.dbPath);
  try {
    flip.exec('BEGIN IMMEDIATE');
    try {
      flip
        .prepare(
          "update build_record set status = 'committed', finished_at = ? where build_id = ? and status = 'pending'",
        )
        .run(input.finishedAt, input.buildId);
      flip.exec('COMMIT');
    } catch (error) {
      try {
        flip.exec('ROLLBACK');
      } catch {
        // no active transaction
      }
      throw error;
    }
    pruneBuilds(flip);
  } finally {
    flip.close();
  }

  return {
    buildId: input.buildId,
    fingerprint: input.buildFingerprint,
    sqliteVersion,
    counts: {
      files: input.files.length,
      symbols: input.symbols.length,
      references: input.references.length,
    },
  };
}

function assertClosure(db: DatabaseSync, buildId: string): void {
  const orphanTarget = db
    .prepare(
      'select count(*) as count from "references" r left join symbols s on r.target_symbol_id = s.symbol_id and s.build_id = r.build_id where r.build_id = ? and r.target_symbol_id is not null and s.symbol_id is null',
    )
    .get(buildId) as { count?: unknown };
  const orphanSource = db
    .prepare(
      'select count(*) as count from "references" r left join symbols s on r.source_symbol_id = s.symbol_id and s.build_id = r.build_id where r.build_id = ? and r.source_symbol_id is not null and s.symbol_id is null',
    )
    .get(buildId) as { count?: unknown };
  const targetCount = typeof orphanTarget.count === 'number' ? orphanTarget.count : -1;
  const sourceCount = typeof orphanSource.count === 'number' ? orphanSource.count : -1;
  if (targetCount !== 0 || sourceCount !== 0) {
    throw nexusError('E23', 'reference foreign keys are not closed', {
      reason: `orphan targets: ${targetCount}, orphan sources: ${sourceCount}`,
      suggestion:
        'Mapping produced edges to symbols that were not written; fix the indexer before release.',
    });
  }
}
