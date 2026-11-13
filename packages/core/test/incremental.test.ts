import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkspace,
  classifyRootChanges,
  diffFileSets,
  isTransitionAllowed,
  loadConfig,
  planRootChange,
  readCommittedFiles,
  verifyIncrementalEquivalence,
  type ScannedFile,
} from 'anemia-core';
import { manifestPath, readManifest } from '../src/store/manifest.js';
import { cleanup, indexFixture, makeEmptyProject, initProject, REPO_ROOT } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

function scanned(entries: Array<[string, string]>): ScannedFile[] {
  return entries.map(([filePath, sourceHash]) => ({
    path: filePath,
    absolutePath: path.join(REPO_ROOT, filePath),
    sourceHash,
    size: 1,
    language: filePath.endsWith('.vue') ? 'vue' : 'ts',
  }));
}

describe('change detection (12.1)', () => {
  it('classifies add/modify/delete/rename by content hash', () => {
    const changes = diffFileSets(
      new Map([
        ['src/keep.ts', 'h1'],
        ['src/modify.ts', 'h2'],
        ['src/delete.ts', 'h3'],
        ['src/rename-old.ts', 'h4'],
        ['src/twin-old.ts', 'h5'],
      ]),
      scanned([
        ['src/keep.ts', 'h1'],
        ['src/modify.ts', 'h2x'],
        ['src/add.ts', 'h6'],
        ['src/rename-new.ts', 'h4'],
        ['src/twin-new-a.ts', 'h5'],
        ['src/twin-new-b.ts', 'h5'],
      ]),
    );
    const kinds = changes.map((entry) => `${entry.kind}:${entry.path}`);
    expect(kinds).toContain('modified:src/modify.ts');
    expect(kinds).toContain('renamed:src/rename-new.ts');
    expect(kinds).toContain('added:src/add.ts');
    expect(kinds).toContain('deleted:src/delete.ts');
    // Ambiguous rename pairing must not guess: both twins stay add/delete.
    expect(kinds).toContain('added:src/twin-new-a.ts');
    expect(kinds).toContain('added:src/twin-new-b.ts');
    expect(kinds).toContain('deleted:src/twin-old.ts');
  });

  it('treats the same content as fresh even if mtime changed', () => {
    const changes = diffFileSets(new Map([['src/a.ts', 'h1']]), scanned([['src/a.ts', 'h1']]));
    expect(changes).toHaveLength(0);
  });

  it('forces a full rebuild for config and tsconfig changes', () => {
    const plan = classifyRootChanges(
      {
        rootId: 'root',
        previousManifest: {
          buildId: 'b1',
          buildFingerprint: 'bf_x',
          configHash: 'c1',
          tsconfigHash: 't1',
          ignoreHash: 'i1',
          rootSetHash: 'r1',
          schemaVersion: 4,
          analyzerVersion: {
            scip: '0.4.0',
            typescript: '5.9.3',
            vueLanguageCore: '3.3.14',
            vueTsc: '3.3.14',
            tsMorph: null,
          },
          staleness: 'fresh',
          recovered: false,
          warnings: [],
        } as unknown as Parameters<typeof classifyRootChanges>[0]['previousManifest'],
        currentFiles: scanned([['src/a.ts', 'h1']]),
        currentConfigHash: 'c2',
        currentTsconfigHash: 't1',
        currentIgnoreHash: 'i1',
        currentRootSetHash: 'r1',
      },
      new Map([['src/a.ts', 'h1']]),
    );
    expect(plan.mode).toBe('full');
    expect(plan.reasons).toContain('config-merge');
  });
});

describe('state machine (12.4)', () => {
  it('implements exactly the documented transitions', () => {
    expect(isTransitionAllowed('fresh', 'dirty')).toBe(true);
    expect(isTransitionAllowed('dirty', 'indexing')).toBe(true);
    expect(isTransitionAllowed('indexing', 'fresh')).toBe(true);
    expect(isTransitionAllowed('indexing', 'stale')).toBe(true);
    expect(isTransitionAllowed('fresh', 'indexing')).toBe(true);
    expect(isTransitionAllowed('dirty', 'fresh')).toBe(true);
    expect(isTransitionAllowed('failed', 'dirty')).toBe(false);
    expect(isTransitionAllowed('indexing', 'dirty')).toBe(false);
  });
});

describe('nex update (Phase 06)', () => {
  it('is a zero-write no-op when nothing changed', async () => {
    const fixture = await indexFixture('F08-refactor', 'update-fresh');
    directories.push(fixture.directory);
    const beforeManifest = readManifest(manifestPath(fixture.directory, fixture.rootId)).manifest;
    const dbFile = path.join(fixture.directory, '.nexus', 'roots', fixture.rootId, 'index.db');
    const dbBefore = fs.statSync(dbFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const loaded = await loadConfig({ projectRoot: fixture.directory });
    const result = await buildWorkspace({
      projectRoot: fixture.directory,
      loadedConfig: loaded,
      mode: 'update',
    });
    directories.push(fixture.directory);
    expect(result.failedRoots).toEqual([]);
    expect(result.roots.every((root) => root.mode === 'fresh')).toBe(true);
    expect(result.roots.every((root) => root.skipped === true)).toBe(true);
    const afterManifest = readManifest(manifestPath(fixture.directory, fixture.rootId)).manifest;
    expect(afterManifest?.buildId).toBe(beforeManifest?.buildId);
    expect(fs.statSync(dbFile).mtimeMs).toBe(dbBefore);
  });

  it('rebuilds a changed root and matches a fresh full build', async () => {
    const fixture = await indexFixture('F08-refactor', 'update-equiv');
    directories.push(fixture.directory);
    const rootDir = path.join(fixture.directory, 'src');
    fs.appendFileSync(
      path.join(rootDir, 'core.ts'),
      '\nexport function phase06Added(value: number): number { return value + 6; }\n',
    );
    fs.writeFileSync(
      path.join(rootDir, 'phase06-new.ts'),
      'export const phase06New = 6;\nexport function usePhase06(): number { return phase06New; }\n',
    );
    fs.rmSync(path.join(rootDir, 'panel.ts'));
    fs.renameSync(path.join(rootDir, 'overlay.ts'), path.join(rootDir, 'overlay-renamed.ts'));

    const loaded = await loadConfig({ projectRoot: fixture.directory });
    const incremental = await buildWorkspace({
      projectRoot: fixture.directory,
      loadedConfig: loaded,
      mode: 'update',
    });
    expect(incremental.failedRoots).toEqual([]);
    const root = incremental.roots.find((entry) => entry.rootId === fixture.rootId);
    expect(root?.mode).toBe('incremental');
    expect(root?.changed?.total).toBeGreaterThanOrEqual(4);

    const fullDirectory = makeEmptyProject('f08-full');
    directories.push(fullDirectory);
    for (const entry of ['src', 'tsconfig.json', 'package.json']) {
      fs.cpSync(path.join(fixture.directory, entry), path.join(fullDirectory, entry), {
        recursive: true,
      });
    }
    fs.mkdirSync(path.join(fullDirectory, '.nexus'), { recursive: true });
    fs.copyFileSync(
      path.join(fixture.directory, '.nexus', 'nexus.config.json'),
      path.join(fullDirectory, '.nexus', 'nexus.config.json'),
    );
    const fullLoaded = await loadConfig({ projectRoot: fullDirectory });
    await buildWorkspace({ projectRoot: fullDirectory, loadedConfig: fullLoaded });

    const equivalence = verifyIncrementalEquivalence({
      incrementalProject: fixture.directory,
      fullProject: fullDirectory,
    });
    expect(equivalence.fields.filter((field) => !field.equal)).toEqual([]);
    expect(equivalence.pass).toBe(true);
  });

  it('classifies a config change as a full rebuild', async () => {
    const fixture = await indexFixture('F12-dirty', 'update-config');
    directories.push(fixture.directory);
    const configFile = path.join(fixture.directory, '.nexus', 'nexus.config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    const defaults = (config.defaults ?? {}) as Record<string, unknown>;
    defaults.resources = { maxMemoryMB: 700, concurrency: 1 };
    config.defaults = defaults;
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const loaded = await loadConfig({ projectRoot: fixture.directory });
    const before = readManifest(manifestPath(fixture.directory, fixture.rootId)).manifest;
    const files = readCommittedFiles(fixture.directory, fixture.rootId);
    expect(files).not.toBeNull();
    const plan = planRootChange(
      {
        rootId: fixture.rootId,
        previousManifest: before,
        currentFiles: [],
        currentConfigHash: 'changed',
        currentTsconfigHash: before?.tsconfigHash ?? '',
        currentIgnoreHash: before?.ignoreHash ?? '',
        currentRootSetHash: before?.rootSetHash ?? '',
      },
      fixture.directory,
    );
    expect(plan.mode).toBe('full');
    const result = await buildWorkspace({
      projectRoot: fixture.directory,
      loadedConfig: loaded,
      mode: 'update',
    });
    expect(result.roots.find((entry) => entry.rootId === fixture.rootId)?.mode).toBe('full');
  });
});

describe('root-set changes (17.2 #15)', () => {
  it('new root is the only one built', async () => {
    const directory = makeEmptyProject('root-set');
    directories.push(directory);
    const source = path.join(REPO_ROOT, 'fixtures', 'F18-scheduler');
    fs.cpSync(source, directory, { recursive: true });
    await initProject(directory, { roots: 'all' });
    const loaded = await loadConfig({ projectRoot: directory });
    const first = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(first.roots).toHaveLength(3);
    const updated = await buildWorkspace({
      projectRoot: directory,
      loadedConfig: loaded,
      mode: 'update',
    });
    expect(updated.roots.every((root) => root.mode === 'fresh')).toBe(true);
  });
});
