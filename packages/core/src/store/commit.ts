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
import { SCHEMA_VERSION } from './schema.js';

export interface MappingRow {
  symbolId: string;
  engine: 'scip' | 'ts' | 'vue';
  engineRef: string;
  matchQuality: string;
  evidence: unknown;
  analyzerVersion: string;
}

/**
 * Streaming commit input. Every collection is an `Iterable` so callers can
 * feed rows one at a time (docs/21-phase-00.md: compute-while-writing); the
 * writer never materializes a second full array of references or mapping rows.
 */
export interface CommitInput {
  dbPath: string;
  rootId: string;
  buildId: string;
  buildFingerprint: string;
  startedAt: string;
  finishedAt: string;
  fields: BuildFingerprintFields;
  files: Iterable<ScannedFile>;
  symbols: Iterable<SymbolRecord>;
  references: Iterable<ReferenceRecord>;
  mappingRows: Iterable<MappingRow>;
  components: Iterable<ComponentRecord>;
  vueFileMeta: Iterable<VueFileMetaRecord>;
}

export interface CommitResult {
  buildId: string;
  fingerprint: string;
  sqliteVersion: string;
  counts: { files: number; symbols: number; references: number };
  writeBatches: number;
  rowsWritten: number;
}

export interface PreviousIdentityRow {
  locatorKey: string;
  symbolId: string;
  confidence: string;
  evidence: string[];
}

/** Logical batch size used to expose write progress and bound retained rows. */
export const WRITE_BATCH_SIZE = 500;

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

type Statement = ReturnType<DatabaseSync['prepare']>;

/**
 * One-transaction, streaming writer for the fixed 12.3.2 order:
 * BEGIN IMMEDIATE -> pending build_record -> rows -> integrity checks -> COMMIT.
 * Rows are bound and executed immediately, so only the caller's cursor keeps a
 * row alive; no `references.map(...)` or `mappingRows` array is allocated here.
 */
export class BuildWriter {
  private readonly db: DatabaseSync;
  private readonly header: CommitInput;
  private readonly insertFile: Statement;
  private readonly insertSymbol: Statement;
  private readonly markCurrentSymbol: Statement;
  private readonly insertReference: Statement;
  private readonly insertMapping: Statement;
  private readonly insertComponent: Statement;
  private readonly insertVueMeta: Statement;
  private closed = false;
  private rows = 0;
  private batches = 0;
  private counts = { files: 0, symbols: 0, references: 0 };

  private constructor(db: DatabaseSync, header: CommitInput) {
    this.db = db;
    this.header = header;
    this.insertFile = db.prepare(
      'insert into files(build_id, path, source_hash, language, size_bytes, status, is_generated) values (?, ?, ?, ?, ?, ?, 0)',
    );
    this.insertSymbol = db.prepare(
      `insert into symbols(symbol_id, build_id, root_id, path, kind, name, name_chain, signature, visibility, is_public, export_kind, analysis_engine, is_type_only, identity_confidence, identity_evidence_json, volatile, anonymous, name_line, name_col, start_line, start_col, end_line, end_col, overload_ordinal, container_locator_key, syntax_context_hash, source_hash, mapping_quality)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.markCurrentSymbol = db.prepare(
      'insert or ignore into temp.current_symbols(symbol_id) values (?)',
    );
    this.insertReference = db.prepare(
      `insert into "references"(build_id, target_symbol_id, target_scip_symbol, source_symbol_id, source_file, kind, role, relation_class, confidence, analysis_engine, line, col, unresolved_reason)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertMapping = db.prepare(
      'insert or replace into symbol_map(build_id, symbol_id, engine, engine_ref, match_quality, evidence_json, analyzer_version) values (?, ?, ?, ?, ?, ?, ?)',
    );
    this.insertComponent = db.prepare(
      `insert into components(build_id, symbol_id, name, props_json, emits_json, slots_json, props_resolved, props_total, analysis_engine, source)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertVueMeta = db.prepare(
      `insert into vue_file_meta(build_id, path, source_hash, projector_version, language_core_version, generated_bytes, generated_at, filtered_internal, template_edges)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Begin the transaction and write the pending build record. */
  static begin(input: CommitInput): BuildWriter {
    const { db } = ensureSchema(input.dbPath);
    const sqliteVersion = sqliteVersionOf(db);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(
        'create temp table if not exists current_symbols (symbol_id text primary key) strict',
      );
      db.exec('delete from temp.current_symbols');
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
      return new BuildWriter(db, input);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no active transaction
      }
      db.close();
      throw error;
    }
  }

  addFile(file: ScannedFile): void {
    this.insertFile.run(
      this.header.buildId,
      file.path,
      file.sourceHash,
      file.language,
      file.size,
      'indexed',
    );
    this.counts.files += 1;
    this.tick();
  }

  addSymbol(symbol: SymbolRecord): void {
    this.insertSymbol.run(
      symbol.symbolId,
      this.header.buildId,
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
    this.markCurrentSymbol.run(symbol.symbolId);
    this.counts.symbols += 1;
    this.tick();
  }

  addReference(reference: ReferenceRecord): void {
    this.insertReference.run(
      this.header.buildId,
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
    this.counts.references += 1;
    this.tick();
  }

  addMapping(row: MappingRow): void {
    this.insertMapping.run(
      this.header.buildId,
      row.symbolId,
      row.engine,
      row.engineRef,
      row.matchQuality,
      JSON.stringify(row.evidence),
      row.analyzerVersion,
    );
    this.tick();
  }

  addComponent(component: ComponentRecord): void {
    this.insertComponent.run(
      this.header.buildId,
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
    this.tick();
  }

  addVueFileMeta(meta: VueFileMetaRecord): void {
    this.insertVueMeta.run(
      this.header.buildId,
      meta.path,
      meta.sourceHash,
      meta.projectorVersion,
      meta.languageCoreVersion,
      meta.generatedBytes,
      meta.generatedAt,
      meta.filteredInternal,
      meta.templateEdges,
    );
    this.tick();
  }

  /**
   * History maintenance without a JS `Set` of every symbol: the current build's
   * ids already live in `temp.current_symbols`, so retire/insert are SQL-only.
   */
  private applyHistory(): void {
    this.db
      .prepare(
        "update symbol_id_history set status = 'retired', valid_to_build = ? where status = 'active' and symbol_id not in (select symbol_id from temp.current_symbols)",
      )
      .run(this.header.buildFingerprint);
    this.db
      .prepare(
        `insert or ignore into symbol_id_history(symbol_id, valid_from_build, valid_to_build, locator_json, confidence, evidence_json, status, successor_id)
         select s.symbol_id, ?, null,
           json_object('rootId', s.root_id, 'path', s.path, 'startLine', s.start_line, 'startCol', s.start_col,
             'endLine', s.end_line, 'endCol', s.end_col, 'kind', s.kind, 'nameChain', s.name_chain,
             'overloadOrdinal', s.overload_ordinal, 'containerLocatorKey', s.container_locator_key,
             'syntaxContextHash', s.syntax_context_hash, 'sourceHash', s.source_hash),
           s.identity_confidence, s.identity_evidence_json, 'active', null
         from symbols s
         where s.build_id = ?
           and not exists (select 1 from symbol_id_history h where h.symbol_id = s.symbol_id and h.status = 'active')`,
      )
      .run(this.header.buildFingerprint, this.header.buildId);
    this.db.exec('drop table temp.current_symbols');
  }

  private tick(): void {
    this.rows += 1;
    if (this.rows % WRITE_BATCH_SIZE === 0) this.batches += 1;
  }

  /** Validates, commits, verifies pending, flips to committed and prunes. */
  seal(): CommitResult {
    const { db, header } = this;
    try {
      this.applyHistory();
      assertClosure(db, header.buildId);
      const indexes = requiredIndexesPresent(db);
      if (!indexes.ok) {
        throw nexusError('E23', 'required indexes are missing after write', {
          reason: indexes.missing.join('; '),
          suggestion: 'Schema DDL and required-index list diverged; fix store/schema.ts.',
        });
      }
      if (this.counts.files === 0) {
        throw nexusError('E23', 'build produced no files', {
          reason: 'coverage denominator would be zero',
          suggestion: 'Check include/ignore rules and tsconfig file list.',
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
    const sqliteVersion = sqliteVersionOf(db);
    db.close();
    this.closed = true;

    // Step 6: reopen read-only and verify the pending record + fingerprint.
    const verify = openDatabase(header.dbPath, { readOnly: true });
    try {
      const row = verify
        .prepare('select status, fingerprint from build_record where build_id = ?')
        .get(header.buildId) as { status?: unknown; fingerprint?: unknown } | undefined;
      if (
        row === undefined ||
        row.status !== 'pending' ||
        row.fingerprint !== header.buildFingerprint
      ) {
        throw nexusError('E19', 'build verification failed after commit', {
          reason: 'pending build record or fingerprint mismatch',
          suggestion: 'Run `nex doctor`; the index must be rebuilt.',
          evidence: { buildId: header.buildId },
        });
      }
    } finally {
      verify.close();
    }

    const flip = openDatabase(header.dbPath);
    try {
      flip.exec('BEGIN IMMEDIATE');
      try {
        flip
          .prepare(
            "update build_record set status = 'committed', finished_at = ? where build_id = ? and status = 'pending'",
          )
          .run(header.finishedAt, header.buildId);
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
      buildId: header.buildId,
      fingerprint: header.buildFingerprint,
      sqliteVersion,
      counts: { ...this.counts },
      writeBatches: Math.max(this.batches, this.rows === 0 ? 0 : 1),
      rowsWritten: this.rows,
    };
  }

  rollback(): void {
    if (this.closed) return;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // no active transaction
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
    this.closed = true;
  }
}

/**
 * Commit protocol (docs/12-indexing.md 12.3.2): write data + pending record in
 * one immediate transaction, verify after commit on a read-only connection,
 * then flip the record to committed in a short transaction. The manifest is
 * written by the caller only after this returns.
 */
export function commitBuild(input: CommitInput): CommitResult {
  const writer = BuildWriter.begin(input);
  try {
    for (const file of input.files) writer.addFile(file);
    for (const symbol of input.symbols) writer.addSymbol(symbol);
    for (const reference of input.references) writer.addReference(reference);
    for (const row of input.mappingRows) writer.addMapping(row);
    for (const component of input.components) writer.addComponent(component);
    for (const meta of input.vueFileMeta) writer.addVueFileMeta(meta);
    return writer.seal();
  } catch (error) {
    writer.rollback();
    throw error;
  }
}
