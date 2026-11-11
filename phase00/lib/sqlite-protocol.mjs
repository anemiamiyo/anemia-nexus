import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function manifestPathFor(dbPath) {
  return path.join(path.dirname(dbPath), 'manifest.json');
}

export function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS build_record (
      build_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      build_id TEXT NOT NULL
    );
  `);
}

export function seedCommitted(dbPath, buildId = 'A', fingerprint = 'bf_A') {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  const manifestPath = manifestPathFor(dbPath);
  fs.rmSync(manifestPath, { force: true });
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO build_record VALUES (?, ?, ?, ?)').run(
    buildId,
    fingerprint,
    'committed',
    new Date().toISOString(),
  );
  db.prepare('INSERT INTO symbols VALUES (?, ?, ?)').run(`${buildId}-symbol`, 'stableFn', buildId);
  db.exec('COMMIT');
  db.close();
  writeManifest(manifestPath, { buildId, buildFingerprint: fingerprint, symbols: 1 });
  return { dbPath, manifestPath };
}

export function writeManifest(manifestPath, value) {
  fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2) + '\n');
}

export function writeManifestAtomic(manifestPath, value, crashAt) {
  const temp = `${manifestPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  if (crashAt === 'manifest-temp') crash();
  fs.renameSync(temp, manifestPath);
  if (crashAt === 'manifest') crash();
}

function crash() {
  // Abrupt termination without unwinding application code.
  process.exit(137);
}

export function runProtocol({ dbPath, buildId, fingerprint, crashAt }) {
  const manifestPath = manifestPathFor(dbPath);
  const db = new DatabaseSync(dbPath);
  initSchema(db);

  db.exec('BEGIN IMMEDIATE');
  if (crashAt === 'begin') crash();

  db.prepare('INSERT INTO build_record VALUES (?, ?, ?, ?)').run(
    buildId,
    fingerprint,
    'pending',
    new Date().toISOString(),
  );
  db.prepare('INSERT INTO symbols VALUES (?, ?, ?)').run(`${buildId}-symbol`, 'stableFn', buildId);
  if (crashAt === 'pending') crash();

  db.exec('COMMIT');
  if (crashAt === 'committed-pending') crash();

  const pending = db
    .prepare("SELECT * FROM build_record WHERE build_id = ? AND status = 'pending'")
    .get(buildId);
  if (!pending) throw new Error('pending build record missing after COMMIT');
  if (crashAt === 'verified') crash();

  db.prepare("UPDATE build_record SET status = 'committed' WHERE build_id = ?").run(buildId);
  if (crashAt === 'committed') crash();

  writeManifestAtomic(
    manifestPath,
    { buildId, buildFingerprint: fingerprint, symbols: 1 },
    crashAt,
  );

  db.prepare("DELETE FROM build_record WHERE status = 'pending' AND build_id <> ?").run(buildId);
  db.prepare(
    "DELETE FROM symbols WHERE build_id NOT IN (SELECT build_id FROM build_record WHERE status = 'committed')",
  ).run();
  db.close();
  return { ok: true };
}

export function recover({ dbPath }) {
  const manifestPath = manifestPathFor(dbPath);
  if (!fs.existsSync(dbPath)) {
    return { state: 'uninitialized', action: 'none', code: 'E01' };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') {
      db.close();
      return { state: 'invalid', action: 'rebuild-required', code: 'E07' };
    }
    const records = db.prepare('SELECT rowid, * FROM build_record ORDER BY rowid ASC').all();
    const committed = records.filter((r) => r.status === 'committed').at(-1);
    const pending = records.filter((r) => r.status === 'pending');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : null;
    const symbolCount = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;

    if (!committed && pending.length === 0) {
      db.close();
      return {
        state: symbolCount > 0 ? 'invalid' : 'uninitialized',
        action: symbolCount > 0 ? 'rebuild-required' : 'none',
        code: symbolCount > 0 ? 'E19' : 'E01',
      };
    }

    if (pending.length > 0) {
      if (!committed && manifest && pending.some((p) => p.build_id === manifest.buildId)) {
        db.close();
        return { state: 'invalid', action: 'rebuild-required', code: 'E19' };
      }
      db.exec('BEGIN IMMEDIATE');
      for (const record of pending) {
        db.prepare('DELETE FROM symbols WHERE build_id = ?').run(record.build_id);
        db.prepare('DELETE FROM build_record WHERE build_id = ?').run(record.build_id);
      }
      db.exec('COMMIT');
      if (!committed) {
        db.close();
        return { state: 'invalid', action: 'discard-pending', code: 'E19' };
      }
      // Keep the last committed index readable, but mark it stale.
      const manifestForCommitted = {
        buildId: committed.build_id,
        buildFingerprint: committed.fingerprint,
      };
      if (!manifest || manifest.buildId !== committed.build_id) {
        writeManifest(manifestPath, { ...manifestForCommitted, symbols: 1 });
      }
      db.close();
      return { state: 'stale', action: 'discard-pending', code: null };
    }

    if (!manifest || manifest.buildId !== committed.build_id) {
      writeManifest(manifestPath, {
        buildId: committed.build_id,
        buildFingerprint: committed.fingerprint,
        symbols: 1,
      });
      db.close();
      return { state: 'fresh', action: 'manifest-repaired', code: null };
    }

    db.close();
    return { state: 'fresh', action: 'none', code: null };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    return { state: 'invalid', action: 'rebuild-required', code: 'E07', error: String(error) };
  }
}
