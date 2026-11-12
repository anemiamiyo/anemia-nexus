import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  commitBuild,
  WRITE_BATCH_SIZE,
  type CallRecord,
  type DependencyRecord,
  type SymbolRecord,
} from 'anemia-core';
import { ANALYZER_VERSION } from '../src/index/analyzer.js';
import { cleanup, makeEmptyProject } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

function symbolAt(index: number): SymbolRecord {
  const name = `fn${index}`;
  return {
    symbolId: `s_${index.toString(32).padStart(16, '0')}`,
    rootId: 'root',
    path: 'src/a.ts',
    kind: 'fn',
    name,
    nameChain: name,
    signature: `function ${name}(): void`,
    visibility: 'exported',
    isPublic: true,
    exportKind: 'named',
    analysisEngine: 'ts-syntax',
    isTypeOnly: false,
    identityConfidence: 'high',
    identityEvidence: ['same-build'],
    volatile: false,
    anonymous: false,
    nameLine: index + 1,
    nameCol: 0,
    declarationLocator: {
      rootId: 'root',
      path: 'src/a.ts',
      startLine: index + 1,
      startCol: 0,
      endLine: index + 1,
      endCol: 1,
      kind: 'fn',
      nameChain: name,
      overloadOrdinal: 0,
      containerLocatorKey: '',
      syntaxContextHash: 'hash',
      sourceHash: 'source',
    },
    mappingQuality: 'exact',
  };
}

function header(dbPath: string) {
  return {
    dbPath,
    rootId: 'root',
    buildId: 'b_test0001',
    buildFingerprint: 'bf_test0000000000000000',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    fields: {
      filesHash: 'files',
      configHash: 'config',
      schemaVersion: 3,
      analyzerVersion: ANALYZER_VERSION,
      rootSetHash: 'roots',
      nodeVersion: process.versions.node,
      sqliteVersion: '3',
      platform: 'test',
      degraded: [],
    },
  };
}

function file() {
  return {
    path: 'src/a.ts',
    absolutePath: '/src/a.ts',
    sourceHash: 'source',
    size: 10,
    language: 'ts' as const,
  };
}

function dependency(): DependencyRecord {
  return {
    sourceFile: 'src/a.ts',
    targetFile: 'src/b.ts',
    sourceRootId: 'root',
    targetRootId: 'root',
    isCrossRoot: false,
    depType: 'import',
    specifier: './b',
    relationClass: 'certain',
    confidence: 'typed',
    analysisEngine: 'ts-ast',
    line: 1,
    col: 0,
    unresolvedReason: null,
    evidence: {
      sourceOfTruth: 'ts-ast',
      analysisVersion: 'typescript',
      constraints: [],
      missReason: null,
    },
  };
}

function call(): CallRecord {
  return {
    callerSymbolId: null,
    calleeSymbolId: null,
    callerFile: 'src/a.ts',
    calleeFile: null,
    line: 1,
    col: 0,
    resolution: 'unresolved',
    relationClass: 'dynamic-unresolved',
    confidence: 'unresolved',
    analysisEngine: 'ts-ast',
    unresolvedReason: 'dynamic-callee',
    evidence: {
      sourceOfTruth: 'ts-ast',
      analysisVersion: 'typescript',
      constraints: [],
      missReason: 'dynamic-callee',
    },
  };
}

describe('streaming SQLite writer', () => {
  it('consumes iterables and reports batches without a second full array', () => {
    const directory = makeEmptyProject('writer-stream');
    directories.push(directory);
    const dbPath = path.join(directory, '.nexus', 'roots', 'root', 'index.db');
    const total = WRITE_BATCH_SIZE * 2 + 7;
    let pulled = 0;
    function* symbols(): Generator<SymbolRecord> {
      for (let index = 0; index < total; index += 1) {
        pulled += 1;
        yield symbolAt(index);
      }
    }

    const result = commitBuild({
      ...header(dbPath),
      files: [file()],
      symbols: symbols(),
      references: [],
      dependencies: [],
      calls: [],
      architectureModules: [],
      architectureViolations: [],
      mappingRows: [],
      components: [],
      vueFileMeta: [],
    });

    expect(pulled).toBe(total);
    expect(result.counts.symbols).toBe(total);
    expect(result.counts.files).toBe(1);
    expect(result.rowsWritten).toBe(total + 1);
    expect(result.writeBatches).toBe(2);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('select count(*) as count from symbols').get() as { count: number };
      expect(row.count).toBe(total);
      const history = db
        .prepare("select count(*) as count from symbol_id_history where status = 'active'")
        .get() as { count: number };
      expect(history.count).toBe(total);
    } finally {
      db.close();
    }
  });

  it('rolls back every row when a generator fails mid-write', () => {
    const directory = makeEmptyProject('writer-rollback');
    directories.push(directory);
    const dbPath = path.join(directory, '.nexus', 'roots', 'root', 'index.db');
    function* symbols(): Generator<SymbolRecord> {
      yield symbolAt(0);
      throw new Error('injected failure');
    }

    expect(() =>
      commitBuild({
        ...header(dbPath),
        files: [file()],
        symbols: symbols(),
        references: [],
        dependencies: [],
        calls: [],
        architectureModules: [],
        architectureViolations: [],
        mappingRows: [],
        components: [],
        vueFileMeta: [],
      }),
    ).toThrow('injected failure');

    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const builds = db.prepare('select count(*) as count from build_record').get() as {
        count: number;
      };
      const files = db.prepare('select count(*) as count from files').get() as { count: number };
      expect(builds.count).toBe(0);
      expect(files.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rolls back dependency and call rows when a later generator fails', () => {
    const directory = makeEmptyProject('writer-graph-rollback');
    directories.push(directory);
    const dbPath = path.join(directory, '.nexus', 'roots', 'root', 'index.db');
    function* dependencies(): Generator<DependencyRecord> {
      yield dependency();
    }
    function* calls(): Generator<CallRecord> {
      yield call();
      throw new Error('graph failure');
    }

    expect(() =>
      commitBuild({
        ...header(dbPath),
        files: [file()],
        symbols: [symbolAt(0)],
        references: [],
        dependencies: dependencies(),
        calls: calls(),
        architectureModules: [],
        architectureViolations: [],
        mappingRows: [],
        components: [],
        vueFileMeta: [],
      }),
    ).toThrow('graph failure');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const builds = db.prepare('select count(*) as count from build_record').get() as {
        count: number;
      };
      const deps = db.prepare('select count(*) as count from dependencies').get() as {
        count: number;
      };
      const callRows = db.prepare('select count(*) as count from calls').get() as {
        count: number;
      };
      const files = db.prepare('select count(*) as count from files').get() as { count: number };
      expect(builds.count).toBe(0);
      expect(deps.count).toBe(0);
      expect(callRows.count).toBe(0);
      expect(files.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses a v2 database with E06 instead of silently migrating', () => {
    const directory = makeEmptyProject('writer-v2');
    directories.push(directory);
    const dbPath = path.join(directory, '.nexus', 'roots', 'root', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('create table meta (key text primary key, value text not null) strict');
    legacy.prepare('insert into meta(key, value) values (?, ?)').run('schema_version', '2');
    legacy.close();

    let code = '';
    try {
      commitBuild({
        ...header(dbPath),
        files: [file()],
        symbols: [symbolAt(0)],
        references: [],
        dependencies: [],
        calls: [],
        architectureModules: [],
        architectureViolations: [],
        mappingRows: [],
        components: [],
        vueFileMeta: [],
      });
    } catch (error) {
      code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
    }
    expect(code).toBe('E06');
  });
});
