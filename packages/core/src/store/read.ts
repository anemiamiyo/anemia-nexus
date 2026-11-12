import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type {
  ComponentEmit,
  ComponentProp,
  ComponentRecord,
  ComponentSlot,
  ReferenceRecord,
  SymbolRecord,
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
