import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type {
  ArchitectureModuleRecord,
  ArchitectureViolationRecord,
  CallRecord,
  ComponentEmit,
  ComponentProp,
  ComponentRecord,
  ComponentSlot,
  DependencyRecord,
  ReferenceRecord,
  RelationEvidence,
  SymbolRecord,
  TestRecord,
  VueFileMetaRecord,
} from '../model.js';
import {
  latestCommittedBuild,
  openDatabase,
  readSchemaVersion,
  type CommittedBuildRow,
} from './db.js';
import { SCHEMA_VERSION } from './schema.js';

export interface ReadStore {
  db: DatabaseSync;
  build: CommittedBuildRow;
}

export function openReadStore(dbPath: string): ReadStore | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = openDatabase(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    if (readSchemaVersion(db) !== SCHEMA_VERSION) {
      db.close();
      return null;
    }
    const build = latestCommittedBuild(db);
    if (build === null) {
      db.close();
      return null;
    }
    return { db, build };
  } catch {
    db.close();
    return null;
  }
}

function rowToSymbol(row: Record<string, unknown>): SymbolRecord {
  const locator = {
    rootId: String(row.root_id ?? ''),
    path: String(row.path ?? ''),
    startLine: Number(row.start_line ?? 0),
    startCol: Number(row.start_col ?? 0),
    endLine: Number(row.end_line ?? 0),
    endCol: Number(row.end_col ?? 0),
    kind: String(row.kind ?? ''),
    nameChain: String(row.name_chain ?? ''),
    overloadOrdinal: Number(row.overload_ordinal ?? 0),
    containerLocatorKey: String(row.container_locator_key ?? ''),
    syntaxContextHash: String(row.syntax_context_hash ?? ''),
    sourceHash: String(row.source_hash ?? ''),
  };
  return {
    symbolId: String(row.symbol_id ?? ''),
    rootId: String(row.root_id ?? ''),
    path: String(row.path ?? ''),
    kind: String(row.kind ?? 'var') as SymbolRecord['kind'],
    name: String(row.name ?? ''),
    nameChain: String(row.name_chain ?? ''),
    signature: String(row.signature ?? ''),
    visibility: String(row.visibility ?? 'module-local') as SymbolRecord['visibility'],
    isPublic: Number(row.is_public ?? 0) === 1,
    exportKind: String(row.export_kind ?? 'none') as SymbolRecord['exportKind'],
    analysisEngine: String(row.analysis_engine ?? ''),
    isTypeOnly: Number(row.is_type_only ?? 0) === 1,
    identityConfidence: String(
      row.identity_confidence ?? 'high',
    ) as SymbolRecord['identityConfidence'],
    identityEvidence: parseStringArray(row.identity_evidence_json),
    volatile: Number(row.volatile ?? 0) === 1,
    anonymous: Number(row.anonymous ?? 0) === 1,
    nameLine: Number(row.name_line ?? 0),
    nameCol: Number(row.name_col ?? 0),
    declarationLocator: locator as SymbolRecord['declarationLocator'],
    mappingQuality: String(row.mapping_quality ?? 'unmapped') as SymbolRecord['mappingQuality'],
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

const SYMBOL_COLUMNS = `symbol_id, build_id, root_id, path, kind, name, name_chain, signature, visibility, is_public, export_kind, analysis_engine, is_type_only, identity_confidence, identity_evidence_json, volatile, anonymous, name_line, name_col, start_line, start_col, end_line, end_col, overload_ordinal, container_locator_key, syntax_context_hash, source_hash, mapping_quality`;

export function readSymbolById(store: ReadStore, symbolId: string): SymbolRecord | null {
  const row = store.db
    .prepare(`select ${SYMBOL_COLUMNS} from symbols where symbol_id = ? and build_id = ?`)
    .get(symbolId, store.build.buildId) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToSymbol(row);
}

export function readSymbolsForFile(store: ReadStore, filePath: string): SymbolRecord[] {
  const rows = store.db
    .prepare(
      `select ${SYMBOL_COLUMNS} from symbols where build_id = ? and path = ? order by start_line, start_col`,
    )
    .all(store.build.buildId, filePath) as Array<Record<string, unknown>>;
  return rows.map(rowToSymbol);
}

export function readSymbolsForPathPrefix(store: ReadStore, prefix: string): SymbolRecord[] {
  const rows = store.db
    .prepare(
      `select ${SYMBOL_COLUMNS} from symbols where build_id = ? and (path = ? or path like ?) order by path, start_line, start_col`,
    )
    .all(store.build.buildId, prefix, `${prefix}/%`) as Array<Record<string, unknown>>;
  return rows.map(rowToSymbol);
}

export function countSymbols(store: ReadStore): number {
  const row = store.db
    .prepare('select count(*) as count from symbols where build_id = ?')
    .get(store.build.buildId) as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}

/**
 * Deterministic full symbol listing for duplicate auditing. `limit` is a hard
 * safety bound; callers compare `countSymbols` with the returned length and
 * must report truncation instead of pretending the listing was complete.
 */
export function readAllSymbols(store: ReadStore, limit = 20000): SymbolRecord[] {
  const rows = store.db
    .prepare(`select ${SYMBOL_COLUMNS} from symbols where build_id = ? order by symbol_id limit ?`)
    .all(store.build.buildId, Math.min(Math.max(limit, 1), 20000)) as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToSymbol);
}

export function findSymbolsByName(store: ReadStore, name: string, limit = 50): SymbolRecord[] {
  const rows = store.db
    .prepare(
      `select ${SYMBOL_COLUMNS} from symbols where build_id = ? and (name = ? or name_chain = ?) order by path, start_line, start_col limit ?`,
    )
    .all(store.build.buildId, name, name, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToSymbol);
}

export interface ReferenceRow extends ReferenceRecord {
  sourceName: string | null;
  targetName: string | null;
}

export function readReferencesTo(store: ReadStore, symbolId: string): ReferenceRow[] {
  const rows = store.db
    .prepare(
      `select r.target_symbol_id, r.target_scip_symbol, r.source_symbol_id, r.source_file, r.kind, r.role,
              r.relation_class, r.confidence, r.analysis_engine, r.line, r.col, r.unresolved_reason, r.build_id,
              s.name_chain as source_name, t.name_chain as target_name
       from "references" r
       left join symbols s on s.symbol_id = r.source_symbol_id and s.build_id = r.build_id
       left join symbols t on t.symbol_id = r.target_symbol_id and t.build_id = r.build_id
       where r.build_id = ? and r.target_symbol_id = ?
       order by r.source_file, r.line, r.col`,
    )
    .all(store.build.buildId, symbolId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    targetSymbolId: typeof row.target_symbol_id === 'string' ? row.target_symbol_id : null,
    targetScipSymbol: typeof row.target_scip_symbol === 'string' ? row.target_scip_symbol : null,
    sourceSymbolId: typeof row.source_symbol_id === 'string' ? row.source_symbol_id : null,
    sourceFile: String(row.source_file ?? ''),
    kind: String(row.kind ?? 'read') as ReferenceRecord['kind'],
    role: String(row.role ?? 'read'),
    relationClass: String(row.relation_class ?? 'certain') as ReferenceRecord['relationClass'],
    confidence: String(row.confidence ?? 'typed') as ReferenceRecord['confidence'],
    analysisEngine: String(row.analysis_engine ?? 'scip'),
    line: Number(row.line ?? 0),
    col: Number(row.col ?? 0),
    unresolvedReason: typeof row.unresolved_reason === 'string' ? row.unresolved_reason : null,
    buildId: String(row.build_id ?? ''),
    sourceName: typeof row.source_name === 'string' ? row.source_name : null,
    targetName: typeof row.target_name === 'string' ? row.target_name : null,
  }));
}

export interface SearchFilter {
  name: string;
  kind?: string;
  pathPrefix?: string;
  publicOnly?: boolean;
  limit?: number;
}

export function searchSymbols(store: ReadStore, filter: SearchFilter): SymbolRecord[] {
  const clauses: string[] = ['build_id = ?'];
  const params: Array<string | number> = [store.build.buildId];
  if (filter.name !== '') {
    clauses.push('(name like ? or name_chain like ?)');
    params.push(`%${filter.name}%`, `%${filter.name}%`);
  }
  if (filter.kind !== undefined && filter.kind !== '') {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.pathPrefix !== undefined && filter.pathPrefix !== '') {
    clauses.push('path like ?');
    params.push(`${filter.pathPrefix}%`);
  }
  if (filter.publicOnly === true) clauses.push('is_public = 1');
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  params.push(limit);
  const rows = store.db
    .prepare(
      `select ${SYMBOL_COLUMNS} from symbols where ${clauses.join(' and ')} order by name, path, start_line limit ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToSymbol);
}

export function sampleFilePaths(store: ReadStore, limit = 10): string[] {
  const rows = store.db.prepare('select path from files order by path limit ?').all(limit) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => String(row.path ?? ''));
}

export function countFiles(store: ReadStore): number {
  const row = store.db.prepare('select count(*) as count from files').get() as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}

export function fileCovered(store: ReadStore, relativePath: string): boolean {
  const row = store.db
    .prepare('select 1 as hit from files where build_id = ? and path = ? limit 1')
    .get(store.build.buildId, relativePath) as { hit?: unknown } | undefined;
  return row !== undefined;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function readComponent(store: ReadStore, symbolId: string): ComponentRecord | null {
  const row = store.db
    .prepare(
      `select symbol_id, name, props_json, emits_json, slots_json, props_resolved, props_total, analysis_engine, source
       from components where build_id = ? and symbol_id = ?`,
    )
    .get(store.build.buildId, symbolId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const props = parseJsonArray<ComponentProp>(row.props_json);
  const emits = parseJsonArray<ComponentEmit>(row.emits_json);
  const slots = parseJsonArray<ComponentSlot>(row.slots_json);
  const total = Number(row.props_total ?? 0);
  const resolved = Number(row.props_resolved ?? 0);
  return {
    symbolId: String(row.symbol_id ?? ''),
    name: String(row.name ?? ''),
    props,
    emits,
    slots,
    propsCoverage: {
      resolved,
      total,
      unresolved: props
        .filter((prop) => !prop.resolved)
        .map((prop) => ({
          name: prop.name,
          typeText: prop.typeText,
          reason: prop.reason ?? 'unresolved-type',
        })),
    },
    analysisEngine: String(row.analysis_engine ?? ''),
    source: String(row.source ?? 'none') as ComponentRecord['source'],
  };
}

export function readVueFileMeta(store: ReadStore): VueFileMetaRecord[] {
  const rows = store.db
    .prepare(
      `select path, source_hash, projector_version, language_core_version, generated_bytes, generated_at, filtered_internal, template_edges
       from vue_file_meta where build_id = ? order by path`,
    )
    .all(store.build.buildId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    path: String(row.path ?? ''),
    sourceHash: String(row.source_hash ?? ''),
    projectorVersion: String(row.projector_version ?? ''),
    languageCoreVersion: String(row.language_core_version ?? ''),
    generatedBytes: Number(row.generated_bytes ?? 0),
    generatedAt: String(row.generated_at ?? ''),
    filteredInternal: Number(row.filtered_internal ?? 0),
    templateEdges: Number(row.template_edges ?? 0),
  }));
}

export function countComponents(store: ReadStore): number {
  const row = store.db
    .prepare('select count(*) as count from components where build_id = ?')
    .get(store.build.buildId) as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}

function parseEvidence(value: unknown): RelationEvidence {
  if (typeof value !== 'string') {
    return { sourceOfTruth: '', analysisVersion: '', constraints: [], missReason: null };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { sourceOfTruth: '', analysisVersion: '', constraints: [], missReason: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      sourceOfTruth: typeof record.sourceOfTruth === 'string' ? record.sourceOfTruth : '',
      analysisVersion: typeof record.analysisVersion === 'string' ? record.analysisVersion : '',
      constraints: Array.isArray(record.constraints)
        ? record.constraints.filter((entry): entry is string => typeof entry === 'string')
        : [],
      missReason: typeof record.missReason === 'string' ? record.missReason : null,
    };
  } catch {
    return { sourceOfTruth: '', analysisVersion: '', constraints: [], missReason: null };
  }
}

export interface DependencyFilter {
  sourcePrefix?: string | null;
  targetPrefix?: string | null;
  depTypes?: readonly string[] | null;
  reverse?: boolean;
  crossRootOnly?: boolean;
  limit?: number;
}

export function readDependencies(store: ReadStore, filter: DependencyFilter): DependencyRecord[] {
  const clauses: string[] = ['build_id = ?'];
  const params: Array<string | number> = [store.build.buildId];
  if (
    filter.sourcePrefix !== undefined &&
    filter.sourcePrefix !== null &&
    filter.sourcePrefix !== ''
  ) {
    if (filter.reverse === true) {
      clauses.push('target_file like ?');
    } else {
      clauses.push('source_file like ?');
    }
    params.push(`${filter.sourcePrefix}%`);
  }
  if (
    filter.targetPrefix !== undefined &&
    filter.targetPrefix !== null &&
    filter.targetPrefix !== ''
  ) {
    clauses.push('target_file like ?');
    params.push(`${filter.targetPrefix}%`);
  }
  if (filter.depTypes !== undefined && filter.depTypes !== null && filter.depTypes.length > 0) {
    clauses.push(`dep_type in (${filter.depTypes.map(() => '?').join(', ')})`);
    params.push(...filter.depTypes);
  }
  if (filter.crossRootOnly === true) clauses.push('is_cross_root = 1');
  const limit = Math.min(Math.max(filter.limit ?? 5000, 1), 20000);
  params.push(limit);
  const rows = store.db
    .prepare(
      `select source_file, target_file, source_root_id, target_root_id, source_module, target_module,
              is_cross_root, dep_type, specifier, relation_class, confidence, analysis_engine,
              line, col, unresolved_reason, evidence_json
       from dependencies where ${clauses.join(' and ')}
       order by source_file, line, col, dep_type, target_file limit ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    sourceFile: String(row.source_file ?? ''),
    targetFile: typeof row.target_file === 'string' ? row.target_file : null,
    sourceRootId: String(row.source_root_id ?? ''),
    targetRootId: typeof row.target_root_id === 'string' ? row.target_root_id : null,
    sourceModule: typeof row.source_module === 'string' ? row.source_module : null,
    targetModule: typeof row.target_module === 'string' ? row.target_module : null,
    isCrossRoot: Number(row.is_cross_root ?? 0) === 1,
    depType: String(row.dep_type ?? 'import') as DependencyRecord['depType'],
    specifier: String(row.specifier ?? ''),
    relationClass: String(row.relation_class ?? 'certain') as DependencyRecord['relationClass'],
    confidence: String(row.confidence ?? 'typed') as DependencyRecord['confidence'],
    analysisEngine: String(row.analysis_engine ?? ''),
    line: Number(row.line ?? 0),
    col: Number(row.col ?? 0),
    unresolvedReason: typeof row.unresolved_reason === 'string' ? row.unresolved_reason : null,
    evidence: parseEvidence(row.evidence_json),
  }));
}

export function countDependencies(store: ReadStore): number {
  const row = store.db
    .prepare('select count(*) as count from dependencies where build_id = ?')
    .get(store.build.buildId) as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}

export interface CallFilter {
  callerSymbolId?: string | null;
  calleeSymbolId?: string | null;
  limit?: number;
}

export function readCalls(store: ReadStore, filter: CallFilter): CallRecord[] {
  const clauses: string[] = ['build_id = ?'];
  const params: Array<string | number> = [store.build.buildId];
  if (filter.callerSymbolId !== undefined && filter.callerSymbolId !== null) {
    clauses.push('caller_symbol_id = ?');
    params.push(filter.callerSymbolId);
  }
  if (filter.calleeSymbolId !== undefined && filter.calleeSymbolId !== null) {
    clauses.push('callee_symbol_id = ?');
    params.push(filter.calleeSymbolId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 5000, 1), 20000);
  params.push(limit);
  const rows = store.db
    .prepare(
      `select caller_symbol_id, callee_symbol_id, caller_file, callee_file, line, col,
              resolution, relation_class, confidence, analysis_engine, unresolved_reason, evidence_json
       from calls where ${clauses.join(' and ')}
       order by caller_file, line, col, callee_symbol_id limit ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    callerSymbolId: typeof row.caller_symbol_id === 'string' ? row.caller_symbol_id : null,
    calleeSymbolId: typeof row.callee_symbol_id === 'string' ? row.callee_symbol_id : null,
    callerFile: String(row.caller_file ?? ''),
    calleeFile: typeof row.callee_file === 'string' ? row.callee_file : null,
    line: Number(row.line ?? 0),
    col: Number(row.col ?? 0),
    resolution: String(row.resolution ?? 'unresolved') as CallRecord['resolution'],
    relationClass: String(row.relation_class ?? 'certain') as CallRecord['relationClass'],
    confidence: String(row.confidence ?? 'typed') as CallRecord['confidence'],
    analysisEngine: String(row.analysis_engine ?? ''),
    unresolvedReason: typeof row.unresolved_reason === 'string' ? row.unresolved_reason : null,
    evidence: parseEvidence(row.evidence_json),
  }));
}

export function readArchitectureModules(store: ReadStore): ArchitectureModuleRecord[] {
  const rows = store.db
    .prepare(
      `select module_name, include_json, allow_json, file_count, symbol_count
       from architecture_modules where build_id = ? order by module_name`,
    )
    .all(store.build.buildId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    name: String(row.module_name ?? ''),
    include: parseStringArray(row.include_json),
    allow:
      row.allow_json === 'null' || row.allow_json === null
        ? null
        : parseStringArray(row.allow_json),
    fileCount: Number(row.file_count ?? 0),
    symbolCount: Number(row.symbol_count ?? 0),
  }));
}

export function readArchitectureViolations(store: ReadStore): ArchitectureViolationRecord[] {
  const rows = store.db
    .prepare(
      `select rule_id, from_module, to_module, source_file, target_file, line, col, dep_type,
              relation_class, confidence, analysis_engine, evidence_json
       from architecture_violations where build_id = ? order by rule_id, source_file, line`,
    )
    .all(store.build.buildId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ruleId: String(row.rule_id ?? ''),
    fromModule: String(row.from_module ?? ''),
    toModule: String(row.to_module ?? ''),
    sourceFile: String(row.source_file ?? ''),
    targetFile: String(row.target_file ?? ''),
    line: Number(row.line ?? 0),
    col: Number(row.col ?? 0),
    depType: String(row.dep_type ?? 'import') as ArchitectureViolationRecord['depType'],
    relationClass: String(
      row.relation_class ?? 'certain',
    ) as ArchitectureViolationRecord['relationClass'],
    confidence: String(row.confidence ?? 'typed') as ArchitectureViolationRecord['confidence'],
    analysisEngine: String(row.analysis_engine ?? ''),
    evidence: parseEvidence(row.evidence_json),
  }));
}

function rowToTest(row: Record<string, unknown>): TestRecord {
  return {
    testFile: String(row.test_file ?? ''),
    targetSymbolId: typeof row.target_symbol_id === 'string' ? row.target_symbol_id : null,
    targetFile: typeof row.target_file === 'string' ? row.target_file : null,
    testType: String(row.test_type ?? 'unknown') as TestRecord['testType'],
    relationClass: String(row.relation_class ?? 'certain') as TestRecord['relationClass'],
    confidence: String(row.confidence ?? 'typed') as TestRecord['confidence'],
    analysisEngine: String(row.analysis_engine ?? ''),
    line: Number(row.line ?? 0),
    evidence: parseEvidence(row.evidence_json),
  };
}

const TEST_COLUMNS = `test_file, target_symbol_id, target_file, test_type, relation_class, confidence, analysis_engine, line, evidence_json`;

export function readTestsForSymbol(store: ReadStore, symbolId: string, limit = 500): TestRecord[] {
  const rows = store.db
    .prepare(
      `select ${TEST_COLUMNS} from tests where build_id = ? and target_symbol_id = ? order by test_file, line limit ?`,
    )
    .all(store.build.buildId, symbolId, Math.min(Math.max(limit, 1), 5000)) as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToTest);
}

export function readTestsForFile(store: ReadStore, file: string, limit = 1000): TestRecord[] {
  const rows = store.db
    .prepare(
      `select ${TEST_COLUMNS} from tests where build_id = ? and target_file = ? order by test_file, line limit ?`,
    )
    .all(store.build.buildId, file, Math.min(Math.max(limit, 1), 5000)) as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToTest);
}

export function readTestsForTestFile(store: ReadStore, testFile: string): TestRecord[] {
  const rows = store.db
    .prepare(`select ${TEST_COLUMNS} from tests where build_id = ? and test_file = ? order by line`)
    .all(store.build.buildId, testFile) as Array<Record<string, unknown>>;
  return rows.map(rowToTest);
}

export function readOwnerModule(store: ReadStore, file: string): string | null {
  const row = store.db
    .prepare('select owner_module from files where build_id = ? and path = ?')
    .get(store.build.buildId, file) as { owner_module?: unknown } | undefined;
  return typeof row?.owner_module === 'string' ? row.owner_module : null;
}

export function countTests(store: ReadStore): number {
  const row = store.db
    .prepare('select count(*) as count from tests where build_id = ?')
    .get(store.build.buildId) as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}

export function countTestFiles(store: ReadStore): number {
  const row = store.db
    .prepare('select count(distinct test_file) as count from tests where build_id = ?')
    .get(store.build.buildId) as { count?: unknown };
  return typeof row.count === 'number' ? row.count : 0;
}
