import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { commitBuild, WRITE_BATCH_SIZE, type SymbolRecord } from 'anemia-core';
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
      schemaVersion: 2,
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
});
