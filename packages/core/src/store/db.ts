import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { nexusError } from '../errors.js';
import { DDL_V1, REQUIRED_INDEXES, SCHEMA_VERSION } from './schema.js';

export interface SqliteProbe {
  ok: boolean;
  version: string;
  reason: string;
}

/** Startup probe for node:sqlite (checklist F01). No fallback driver exists. */
export function probeSqlite(): SqliteProbe {
  try {
    if (typeof DatabaseSync !== 'function') {
      return { ok: false, version: '', reason: 'DatabaseSync is not available' };
    }
    const db = new DatabaseSync(':memory:');
    try {
      const row = db.prepare('select sqlite_version() as version').get() as { version?: unknown };
      const version = typeof row.version === 'string' ? row.version : '';
      db.exec('create table probe(x integer) strict');
      db.exec('insert into probe(x) values (1)');
      return { ok: true, version, reason: '' };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      version: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OpenDatabaseOptions {
  readOnly?: boolean;
  timeoutMs?: number;
}

export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const db = new DatabaseSync(filePath, {
    readOnly: options.readOnly ?? false,
    timeout: options.timeoutMs ?? 5000,
    enableForeignKeyConstraints: true,
  });
  if (!options.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

export function sqliteVersionOf(db: DatabaseSync): string {
  const row = db.prepare('select sqlite_version() as version').get() as { version?: unknown };
  return typeof row.version === 'string' ? row.version : '';
}

export function ensureSchema(dbPath: string): { db: DatabaseSync; sqliteVersion: string } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    db.exec(DDL_V1);
    const current = readSchemaVersion(db);
    if (current === null) {
      db.prepare('insert into meta(key, value) values (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION),
      );
    } else if (current !== SCHEMA_VERSION) {
      throw nexusError('E06', 'schema version mismatch', {
        reason: `database schema ${current}, expected ${SCHEMA_VERSION}`,
        file: path.basename(dbPath),
        suggestion: 'Delete the root index and rebuild; migrations are not provided.',
        evidence: { current, expected: SCHEMA_VERSION },
      });
    }
    return { db, sqliteVersion: sqliteVersionOf(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare('select value from meta where key = ?').get('schema_version') as
      { value?: unknown } | undefined;
    if (row === undefined || typeof row.value !== 'string') return null;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface IntegrityResult {
  ok: boolean;
  errors: string[];
}

export function integrityCheck(db: DatabaseSync): IntegrityResult {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const messages = rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((message) => message !== '' && message !== 'ok');
    return { ok: messages.length === 0, errors: messages };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function indexColumns(db: DatabaseSync, indexName: string): string[] {
  const rows = db.prepare(`PRAGMA index_info(${JSON.stringify(indexName)})`).all() as Array<
    Record<string, unknown>
  >;
  return rows
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter((name) => name !== '');
}

export function requiredIndexesPresent(db: DatabaseSync): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const required of REQUIRED_INDEXES) {
    let indexes: Array<Record<string, unknown>>;
    try {
      indexes = db.prepare(`PRAGMA index_list(${JSON.stringify(required.table)})`).all() as Array<
        Record<string, unknown>
      >;
    } catch {
      missing.push(`${required.table} (table missing)`);
      continue;
    }
    let found = false;
    for (const index of indexes) {
      const name = typeof index.name === 'string' ? index.name : '';
      if (name === '') continue;
      const columns = indexColumns(db, name);
      if (
        columns.length === required.columns.length &&
        columns.every((column, position) => column === required.columns[position])
      ) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(`${required.table}(${required.columns.join(', ')})`);
  }
  return { ok: missing.length === 0, missing };
}

export interface CommittedBuildRow {
  buildId: string;
  fingerprint: string;
  builtAt: string | null;
  status: string;
}

export function latestCommittedBuild(db: DatabaseSync): CommittedBuildRow | null {
  try {
    const row = db
      .prepare(
        "select build_id as buildId, fingerprint, built_at as builtAt, status from build_record where status = 'committed' order by started_at desc limit 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      buildId: typeof row.buildId === 'string' ? row.buildId : '',
      fingerprint: typeof row.fingerprint === 'string' ? row.fingerprint : '',
      builtAt: typeof row.builtAt === 'string' ? row.builtAt : null,
      status: typeof row.status === 'string' ? row.status : '',
    };
  } catch {
    return null;
  }
}

export function pendingBuilds(db: DatabaseSync): Array<{ buildId: string; fingerprint: string }> {
  try {
    const rows = db
      .prepare("select build_id as buildId, fingerprint from build_record where status = 'pending'")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      buildId: typeof row.buildId === 'string' ? row.buildId : '',
      fingerprint: typeof row.fingerprint === 'string' ? row.fingerprint : '',
    }));
  } catch {
    return [];
  }
}
