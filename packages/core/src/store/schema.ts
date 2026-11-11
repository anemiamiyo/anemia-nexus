/**
 * Declarative schema v1. `schemaVersion` and the DDL live in this one module
 * (docs/05-data-model.md 5.5). Incompatible changes require a new version and
 * a rebuild; Phase 01 has no migration path.
 */
export const SCHEMA_VERSION = 1;

export const DDL_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS build_record (
  build_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
  root_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  analyzer_version_json TEXT NOT NULL,
  root_set_hash TEXT NOT NULL,
  node_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  degraded_json TEXT NOT NULL,
  built_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS build_record_status_idx ON build_record (status, started_at);

CREATE TABLE IF NOT EXISTS files (
  file_id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  is_generated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (build_id, path)
) STRICT;

CREATE INDEX IF NOT EXISTS files_build_idx ON files (build_id);

CREATE TABLE IF NOT EXISTS symbols (
  build_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  name_chain TEXT NOT NULL,
  signature TEXT NOT NULL,
  visibility TEXT NOT NULL,
  is_public INTEGER NOT NULL,
  export_kind TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  is_type_only INTEGER NOT NULL,
  identity_confidence TEXT NOT NULL,
  identity_evidence_json TEXT NOT NULL,
  volatile INTEGER NOT NULL,
  anonymous INTEGER NOT NULL,
  name_line INTEGER NOT NULL,
  name_col INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  overload_ordinal INTEGER NOT NULL,
  container_locator_key TEXT NOT NULL,
  syntax_context_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  mapping_quality TEXT NOT NULL,
  PRIMARY KEY (build_id, symbol_id)
) STRICT;

CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols (name);
CREATE INDEX IF NOT EXISTS symbols_symbol_idx ON symbols (symbol_id);
CREATE INDEX IF NOT EXISTS symbols_root_path_idx ON symbols (root_id, path);

CREATE TABLE IF NOT EXISTS "references" (
  ref_id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  target_symbol_id TEXT,
  target_scip_symbol TEXT,
  source_symbol_id TEXT,
  source_file TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  relation_class TEXT NOT NULL,
  confidence TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  unresolved_reason TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS references_target_idx ON "references" (target_symbol_id);
CREATE INDEX IF NOT EXISTS references_build_target_idx ON "references" (build_id, target_symbol_id);
CREATE INDEX IF NOT EXISTS references_source_idx ON "references" (source_symbol_id);
CREATE INDEX IF NOT EXISTS references_file_idx ON "references" (source_file, line);

CREATE TABLE IF NOT EXISTS symbol_map (
  build_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  engine_ref TEXT NOT NULL,
  match_quality TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  PRIMARY KEY (build_id, symbol_id, engine)
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_map_symbol_idx ON symbol_map (symbol_id, engine);

CREATE INDEX IF NOT EXISTS symbol_map_engine_idx ON symbol_map (engine, engine_ref);

CREATE TABLE IF NOT EXISTS symbol_id_history (
  symbol_id TEXT NOT NULL,
  valid_from_build TEXT NOT NULL,
  valid_to_build TEXT,
  locator_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'unknown')),
  successor_id TEXT,
  PRIMARY KEY (symbol_id, valid_from_build)
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_id_history_symbol_idx ON symbol_id_history (symbol_id, valid_from_build);
`;

export interface RequiredIndex {
  table: string;
  columns: string[];
}

/** Required indexes from docs/05-data-model.md 5.6; Phase 01 omits `dependencies`. */
export const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  { table: 'references', columns: ['target_symbol_id'] },
  { table: 'references', columns: ['source_symbol_id'] },
  { table: 'symbols', columns: ['name'] },
  { table: 'symbols', columns: ['root_id', 'path'] },
  { table: 'symbol_map', columns: ['symbol_id', 'engine'] },
  { table: 'symbol_map', columns: ['engine', 'engine_ref'] },
  { table: 'symbol_id_history', columns: ['symbol_id', 'valid_from_build'] },
];
