/**
 * Declarative schema. `schemaVersion` and the DDL live in this one module
 * (docs/05-data-model.md 5.5). Phase 02 adds the Vue tables required by
 * docs/04-architecture.md 4.1.1 and the Component entity of
 * docs/05-data-model.md 5.1; Phase 04 adds the relation-graph and architecture
 * tables of docs/05-data-model.md 5.1/5.6 (Dependency, CallRelation,
 * ArchitectureModule). Phase 05 adds the Test relation table of
 * docs/05-data-model.md 5.1/5.6 (8th relation class, docs/08-relations.md).
 * Incompatible changes require a new version and a rebuild; no migration is
 * provided.
 */
export const SCHEMA_VERSION = 4;

export const DDL_CURRENT = `
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
  /** Architecture module from explicit config (docs/phase-04/00-entry-and-decisions.md 3.2). */
  owner_module TEXT,
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

CREATE TABLE IF NOT EXISTS vue_file_meta (
  build_id TEXT NOT NULL,
  path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  projector_version TEXT NOT NULL,
  language_core_version TEXT NOT NULL,
  generated_bytes INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  filtered_internal INTEGER NOT NULL,
  template_edges INTEGER NOT NULL,
  PRIMARY KEY (build_id, path)
) STRICT;

CREATE TABLE IF NOT EXISTS components (
  build_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  name TEXT NOT NULL,
  props_json TEXT NOT NULL,
  emits_json TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  props_resolved INTEGER NOT NULL,
  props_total INTEGER NOT NULL,
  analysis_engine TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (build_id, symbol_id)
) STRICT;

CREATE INDEX IF NOT EXISTS components_name_idx ON components (name);

CREATE TABLE IF NOT EXISTS dependencies (
  dep_id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  target_file TEXT,
  source_root_id TEXT NOT NULL,
  target_root_id TEXT,
  source_module TEXT,
  target_module TEXT,
  is_cross_root INTEGER NOT NULL DEFAULT 0,
  dep_type TEXT NOT NULL,
  specifier TEXT NOT NULL,
  relation_class TEXT NOT NULL,
  confidence TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  unresolved_reason TEXT,
  evidence_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS dependencies_build_source_idx ON dependencies (build_id, source_file);
CREATE INDEX IF NOT EXISTS dependencies_source_idx ON dependencies (source_file);
CREATE INDEX IF NOT EXISTS dependencies_target_idx ON dependencies (target_file);

CREATE TABLE IF NOT EXISTS calls (
  call_id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  caller_symbol_id TEXT,
  callee_symbol_id TEXT,
  caller_file TEXT NOT NULL,
  callee_file TEXT,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  resolution TEXT NOT NULL,
  relation_class TEXT NOT NULL,
  confidence TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  unresolved_reason TEXT,
  evidence_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS calls_caller_idx ON calls (caller_symbol_id);
CREATE INDEX IF NOT EXISTS calls_callee_idx ON calls (callee_symbol_id);
CREATE INDEX IF NOT EXISTS calls_build_caller_idx ON calls (build_id, caller_symbol_id);

CREATE TABLE IF NOT EXISTS architecture_modules (
  build_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  include_json TEXT NOT NULL,
  allow_json TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  PRIMARY KEY (build_id, module_name)
) STRICT;

CREATE TABLE IF NOT EXISTS architecture_violations (
  violation_id INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  from_module TEXT NOT NULL,
  to_module TEXT NOT NULL,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  dep_type TEXT NOT NULL,
  relation_class TEXT NOT NULL,
  confidence TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  evidence_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS architecture_violations_from_idx ON architecture_violations (build_id, from_module);
CREATE INDEX IF NOT EXISTS architecture_violations_to_idx ON architecture_violations (build_id, to_module);

CREATE TABLE IF NOT EXISTS tests (
  test_id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  test_file TEXT NOT NULL,
  target_symbol_id TEXT,
  target_file TEXT,
  test_type TEXT NOT NULL CHECK (test_type IN ('unit', 'integration', 'e2e', 'unknown')),
  relation_class TEXT NOT NULL,
  confidence TEXT NOT NULL,
  analysis_engine TEXT NOT NULL,
  line INTEGER NOT NULL,
  evidence_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS tests_target_idx ON tests (build_id, target_symbol_id);
CREATE INDEX IF NOT EXISTS tests_file_idx ON tests (build_id, test_file);
CREATE INDEX IF NOT EXISTS tests_target_file_idx ON tests (build_id, target_file);
`;

export interface RequiredIndex {
  table: string;
  columns: string[];
}

/** Required indexes from docs/05-data-model.md 5.6; Phase 04 adds graph tables. */
export const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  { table: 'references', columns: ['target_symbol_id'] },
  { table: 'references', columns: ['source_symbol_id'] },
  { table: 'symbols', columns: ['name'] },
  { table: 'symbols', columns: ['symbol_id'] },
  { table: 'symbols', columns: ['root_id', 'path'] },
  { table: 'symbol_map', columns: ['symbol_id', 'engine'] },
  { table: 'symbol_map', columns: ['engine', 'engine_ref'] },
  { table: 'symbol_id_history', columns: ['symbol_id', 'valid_from_build'] },
  { table: 'dependencies', columns: ['source_file'] },
  { table: 'dependencies', columns: ['target_file'] },
  { table: 'calls', columns: ['caller_symbol_id'] },
  { table: 'calls', columns: ['callee_symbol_id'] },
  { table: 'tests', columns: ['build_id', 'target_symbol_id'] },
  { table: 'tests', columns: ['build_id', 'test_file'] },
  { table: 'tests', columns: ['build_id', 'target_file'] },
];
