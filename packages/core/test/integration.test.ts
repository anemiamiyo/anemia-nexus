import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import {
  buildWorkspace,
  loadConfig,
  queryReferences,
  querySearch,
  querySymbol,
  statusReport,
  isNexusError,
} from 'anemia-core';
import { openReadStore, readReferencesTo, searchSymbols } from '../src/store/read.js';
import { databasePath, readManifest } from '../src/store/manifest.js';
import { integrityCheck, openDatabase, requiredIndexesPresent } from '../src/store/db.js';
import { recoverPending } from '../src/store/commit.js';
import { REPO_ROOT, cleanup, indexFixture, initProject, makeProject } from './helpers.js';

const ORACLE_SCRIPT = path.join(REPO_ROOT, 'tools', 'oracle', 'tsserver-references.mjs');

interface OracleReference {
  path: string;
  line: number;
  col: number;
  isDefinition: boolean;
}

function oracleRefs(directory: string, file: string, line: number, col: number): OracleReference[] {
  const output = execFileSync(
    process.execPath,
    [ORACLE_SCRIPT, directory, file, String(line), String(col)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(output) as OracleReference[];
}

const SELF = {
  serverVersion: '0.0.0',
  packageName: 'anemia-cli',
  binaryPath: 'main.js',
  projectRoot: '.',
  nodeVersion: process.versions.node,
};

describe('F01 build and queries', () => {
  it('builds, reports fresh status, and serves references/symbol/search', async () => {
    const fixture = await indexFixture('F01-reexport-chain', 'f01');
    try {
      expect(fixture.build.failedRoots).toEqual([]);
      const status = await statusReport({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        self: SELF,
      });
      expect(status.state).toBe('ready');
      expect(status.staleness).toBe('fresh');
      expect(status.capabilities.styleDependency).toBe('file-level');
      expect(status.capabilities.dependencyGraph).toBe('file-level');
      expect(status.capabilities.callGraph).toBe('static-ts');
      expect(status.capabilities.architectureRules).toBe('allow-list');
      expect(status.capabilities.mcpFormats).toEqual([]);
      expect(status.roots).toHaveLength(1);

      const references = await queryReferences(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'add',
        true,
      );
      expect(references.envelope.counts.certain).toBe(7);
      expect(references.envelope.staleness).toBe('fresh');
      expect(references.envelope.buildFingerprint).toMatch(/^bf_/);
      expect(references.symbol.name).toBe('add');

      const symbol = await querySymbol(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'Counter',
        true,
      );
      expect(symbol.envelope.items[0]?.kind).toBe('class');
      expect(symbol.envelope.items[0]?.surface).toBe('internal');

      const search = await querySearch(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'trim',
        {},
      );
      expect(search.envelope.items.some((item) => item.name === 'trim')).toBe(true);
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('stores the required schema, indexes and a consistent manifest', async () => {
    const fixture = await indexFixture('F10-negative', 'f10-schema');
    try {
      const dbPath = databasePath(fixture.directory, fixture.rootId);
      const db = openDatabase(dbPath, { readOnly: true });
      try {
        expect(integrityCheck(db).ok).toBe(true);
        expect(requiredIndexesPresent(db).ok).toBe(true);
      } finally {
        db.close();
      }
      const manifest = readManifest(
        path.join(fixture.directory, '.nexus', 'roots', fixture.rootId, 'manifest.json'),
      );
      expect(manifest.manifest?.buildFingerprint).toBe(fixture.build.roots[0]?.buildFingerprint);
      expect(manifest.manifest?.coverage.filesCovered).toBeGreaterThan(0);
      expect(manifest.manifest?.memory.scipPeakRssMB).toBeNull();
      expect(manifest.manifest?.memory.scipPeakRssUnavailableReason).toContain('Phase 01');
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('produces the same fingerprint for a rebuild of unchanged sources', async () => {
    const fixture = await indexFixture('F10-negative', 'f10-rebuild');
    try {
      const loaded = await loadConfig({ projectRoot: fixture.directory });
      const rebuilt = await buildWorkspace({
        projectRoot: fixture.directory,
        loadedConfig: loaded,
      });
      expect(rebuilt.roots[0]?.buildFingerprint).toBe(fixture.build.roots[0]?.buildFingerprint);
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('marks the index stale after a source change', async () => {
    const fixture = await indexFixture('F10-negative', 'f10-stale');
    try {
      const file = path.join(fixture.directory, 'src', 'api.ts');
      fs.appendFileSync(file, '\nexport const added = 1;\n');
      const status = await statusReport({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        self: SELF,
      });
      expect(status.staleness).toBe('stale');
      expect(status.roots[0]?.staleReason).toContain('files-changed');
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('negative fixture semantics', () => {
  it('does not invent references for unreferenced or dynamic-only symbols', async () => {
    const fixture = await indexFixture('F10-negative', 'f10-negative');
    try {
      const never = await queryReferences(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'neverReferenced',
        true,
      );
      expect(never.envelope.items).toHaveLength(0);
      expect(never.envelope.counts.certain).toBe(0);

      const dynamic = await queryReferences(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'viaBracket',
        true,
      );
      expect(dynamic.envelope.items).toHaveLength(0);

      const used = await queryReferences(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'referencedOnce',
        true,
      );
      expect(used.envelope.counts.certain).toBeGreaterThan(0);
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('multi-root isolation', () => {
  it('builds each root separately and routes cwd to one root', async () => {
    const directory = makeProject('F04-multi-root', 'f04');
    try {
      await initProject(directory);
      const loaded = await loadConfig({ projectRoot: directory });
      const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
      expect(build.failedRoots).toEqual([]);
      expect(loaded.config?.workspaces.roots).toHaveLength(2);

      const repoStatus = await statusReport({ projectRoot: directory, cwd: directory, self: SELF });
      expect(repoStatus.roots).toHaveLength(2);
      expect(repoStatus.activeRoot).toBeNull();

      const rootQuery = await querySearch(
        { projectRoot: directory, cwd: directory },
        'uiButton',
        {},
      ).catch((error: unknown) => error);
      expect(isNexusError(rootQuery) && rootQuery.code === 'E16').toBe(true);

      const uiCwd = path.join(directory, 'packages', 'ui');
      const uiStatus = await statusReport({ projectRoot: directory, cwd: uiCwd, self: SELF });
      expect(uiStatus.activeRoot).toBe('f04-ui');
      const uiSearch = await querySearch({ projectRoot: directory, cwd: uiCwd }, 'uiButton', {});
      expect(uiSearch.envelope.items).toHaveLength(1);
      expect(uiSearch.envelope.items[0]?.rootId).toBe('f04-ui');
    } finally {
      cleanup(directory);
    }
  });
});

describe('tsserver Oracle agreement (G3)', () => {
  for (const fixtureName of ['F01-reexport-chain', 'F10-negative']) {
    it(`matches certain references for ${fixtureName}`, async () => {
      const fixture = await indexFixture(fixtureName, `oracle-${fixtureName}`);
      try {
        const store = openReadStore(databasePath(fixture.directory, fixture.rootId));
        expect(store).not.toBeNull();
        if (store === null) return;
        try {
          const symbols = searchSymbols(store, { name: '', limit: 1000 }).filter(
            (symbol) => symbol.isPublic,
          );
          expect(symbols.length).toBeGreaterThan(0);
          const diffs: Array<{ name: string; missing: string[]; extra: string[] }> = [];
          for (const symbol of symbols) {
            const oracle = oracleRefs(
              fixture.directory,
              symbol.path,
              symbol.nameLine,
              symbol.nameCol,
            )
              .filter((reference) => reference.isDefinition !== true)
              .map((reference) => `${reference.path}:${reference.line}:${reference.col}`);
            const product = new Set(
              readReferencesTo(store, symbol.symbolId)
                .filter((reference) => reference.relationClass === 'certain')
                .map((reference) => `${reference.sourceFile}:${reference.line}:${reference.col}`),
            );
            const oracleSet = new Set(oracle);
            const missing = [...oracleSet].filter((key) => !product.has(key)).sort();
            const extra = [...product].filter((key) => !oracleSet.has(key)).sort();
            if (missing.length > 0 || extra.length > 0) {
              diffs.push({ name: symbol.nameChain, missing, extra });
            }
          }
          expect(diffs).toEqual([]);
        } finally {
          store.db.close();
        }
      } finally {
        cleanup(fixture.directory);
      }
    });
  }
});

describe('syntax-only degradation', () => {
  it('indexes files with a broken tsconfig and declares semanticCoverage as null', async () => {
    const directory = makeProject('F10-negative', 'syntax-only');
    try {
      fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{ "compilerOptions": {\n');
      fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, '.nexus', 'nexus.config.json'),
        JSON.stringify({ configVersion: 1, workspaces: { roots: ['f10-negative'] } }),
      );
      const loaded = await loadConfig({ projectRoot: directory });
      const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
      expect(build.failedRoots).toEqual([]);
      const status = await statusReport({ projectRoot: directory, cwd: directory, self: SELF });
      expect(status.roots[0]?.degraded).toContain('syntax-only');
      expect(status.roots[0]?.coverage.semanticCoverage).toBeNull();
      const references = await queryReferences(
        { projectRoot: directory, cwd: directory },
        'referencedOnce',
        true,
      );
      expect(references.envelope.mode).toBe('syntax-only');
      expect(references.envelope.items).toHaveLength(0);
    } finally {
      cleanup(directory);
    }
  });
});

describe('commit recovery and retention', () => {
  it('discards a pending build without touching the committed index', async () => {
    const fixture = await indexFixture('F10-negative', 'recover');
    try {
      const dbPath = databasePath(fixture.directory, fixture.rootId);
      const db = openDatabase(dbPath);
      try {
        db.prepare(
          "insert into build_record(build_id, fingerprint, status, root_id, started_at, files_hash, config_hash, schema_version, analyzer_version_json, root_set_hash, node_version, sqlite_version, platform, degraded_json) values ('pending-test', 'fp', 'pending', ?, ?, 'f', 'c', 1, '{}', 'r', '22.16.0', '3', 'win32-x64', '[]')",
        ).run(fixture.rootId, new Date().toISOString());
      } finally {
        db.close();
      }
      const recovered = recoverPending(dbPath);
      expect(recovered).toBe(1);
      const status = await statusReport({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        self: SELF,
      });
      expect(status.staleness).toBe('fresh');
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('retains at most two committed builds of data', async () => {
    const fixture = await indexFixture('F10-negative', 'retention');
    try {
      const loaded = await loadConfig({ projectRoot: fixture.directory });
      await buildWorkspace({ projectRoot: fixture.directory, loadedConfig: loaded });
      await buildWorkspace({ projectRoot: fixture.directory, loadedConfig: loaded });
      const db = openDatabase(databasePath(fixture.directory, fixture.rootId), { readOnly: true });
      try {
        const rows = db.prepare('select count(distinct build_id) as count from symbols').get() as {
          count?: number;
        };
        expect(rows.count).toBeLessThanOrEqual(2);
        const records = db
          .prepare("select count(*) as count from build_record where status = 'committed'")
          .get() as { count?: number };
        expect(records.count).toBeLessThanOrEqual(2);
      } finally {
        db.close();
      }
    } finally {
      cleanup(fixture.directory);
    }
  });
});
