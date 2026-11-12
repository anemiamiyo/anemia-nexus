import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildWorkspace,
  createSurfaceSnapshot,
  diffCurrentSurface,
  diffSnapshots,
  isNexusError,
  loadConfig,
  readBaseline,
  readSurface,
  writeBaselineSnapshot,
} from 'anemia-core';
import { cleanup, indexFixture, initProject, makeProject, type IndexedFixture } from './helpers.js';

function publicEntries(fixture: IndexedFixture) {
  const read = readSurface(fixture.directory, fixture.rootId);
  expect(read.error).toBeNull();
  expect(read.matchesManifest).toBe(true);
  return read.surface!;
}

describe('F07 API Surface', () => {
  let fixture: IndexedFixture;

  beforeAll(async () => {
    fixture = await indexFixture('F07-api-surface', 'f07-surface');
  }, 180_000);

  afterAll(() => {
    cleanup(fixture.directory);
  });

  it('matches the manually reviewed golden envelope', () => {
    const surface = publicEntries(fixture);
    const golden = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, 'expected', 'surface-golden.json'), 'utf8'),
    ) as {
      public: Record<string, { primaryEvidenceSource: string; exportKind?: string }>;
      internal: string[];
      opaque: string[];
      forbiddenPublic: string[];
    };
    for (const name of Object.keys(golden.public)) {
      const entries = surface.entries.filter((entry) => entry.name === name);
      expect(entries.length, name).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.primaryEvidenceSource, name).not.toBe('none');
        expect(entry.exportKind, name).toMatch(/^(type|value|both)$/);
      }
    }
    for (const name of golden.internal) {
      expect(
        surface.internal.some((entry) => entry.name === name),
        name,
      ).toBe(true);
    }
    for (const name of golden.forbiddenPublic) {
      expect(
        surface.entries.some((entry) => entry.name === name),
        name,
      ).toBe(false);
    }
    for (const reason of golden.opaque) {
      expect(
        surface.opaque.some((entry) => entry.name === reason),
        reason,
      ).toBe(true);
    }
  });

  it('assigns evidence sources and export kinds for package exports', () => {
    const surface = publicEntries(fixture);
    const add = surface.entries.filter((entry) => entry.name === 'add' && entry.entryPath === '.');
    expect(add.length).toBe(3);
    for (const entry of add) {
      expect(entry.primaryEvidenceSource).toBe('package-exports');
      expect(entry.evidenceSources).toContain('package-exports');
      expect(entry.evidenceSources).toContain('barrel-derived');
      expect(entry.derived).toBe(true);
      expect(entry.exportKind).toBe('value');
      expect(entry.symbolId).toMatch(/^s_/);
    }
    expect(new Set(add.map((entry) => entry.condition))).toEqual(
      new Set(['types', 'import', 'require']),
    );

    const numeric = surface.entries.find(
      (entry) => entry.name === 'Numeric' && entry.condition === 'types',
    );
    expect(numeric).toBeDefined();
    expect(numeric?.exportKind).toBe('type');
    expect(numeric?.isTypeOnly).toBe(true);
    expect(numeric?.runtimePresent).toBe(false);

    const both = surface.entries.find(
      (entry) => entry.name === 'Both' && entry.condition === 'types',
    );
    expect(both?.exportKind).toBe('both');
    expect(both?.runtimePresent).toBe(true);
    expect(both?.signatures?.length).toBe(2);
  });

  it('resolves subpaths, wildcard exports and multi-layer barrels', () => {
    const surface = publicEntries(fixture);
    const feature = surface.entries.find((entry) => entry.name === 'feature');
    expect(feature?.entryPath).toBe('./advanced/feature');
    expect(feature?.primaryEvidenceSource).toBe('package-exports');
    expect(feature?.derived).toBe(false);

    const format = surface.entries.filter((entry) => entry.name === 'format');
    expect(format.some((entry) => entry.entryPath === './utils')).toBe(true);
    for (const entry of format) {
      expect(entry.evidenceSources).toContain('barrel-derived');
      expect(entry.derived).toBe(true);
    }
  });

  it('keeps non-exported symbols out of the public surface and records opaque exports', () => {
    const surface = publicEntries(fixture);
    expect(surface.entries.some((entry) => entry.name === 'internalHelper')).toBe(false);
    expect(surface.internal.some((entry) => entry.name === 'internalHelper')).toBe(true);
    expect(surface.opaque.some((entry) => entry.reason === 'export-equals')).toBe(true);
    for (const entry of surface.entries) {
      expect(entry.primaryEvidenceSource).not.toBe('none');
      expect(entry.exportKind).toMatch(/^(type|value|both)$/);
    }
  });

  it('resolves deprecated successors by symbolId and keeps no-successor visible', () => {
    const surface = publicEntries(fixture);
    const oldAdd = surface.deprecated.find((entry) => entry.name === 'oldAdd');
    expect(oldAdd?.status).toBe('resolved');
    expect(oldAdd?.successorName).toBe('add');
    expect(oldAdd?.successorId).toMatch(/^s_/);
    expect(oldAdd?.suggestion).toContain('nex references oldAdd');
    expect(surface.entries.find((entry) => entry.name === 'oldAdd')?.stability).toBe('deprecated');

    const doomed = surface.deprecated.find((entry) => entry.name === 'doomed');
    expect(doomed?.status).toBe('no-successor');
    expect(doomed?.removalVersion).toBe('2.0.0');
  });

  it('writes a deterministic baseline and refuses an implicit overwrite', () => {
    const first = writeBaselineSnapshot({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
      yes: true,
    });
    const firstBytes = fs.readFileSync(path.join(fixture.directory, first.path), 'utf8');
    const second = writeBaselineSnapshot({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
      yes: true,
    });
    const secondBytes = fs.readFileSync(path.join(fixture.directory, second.path), 'utf8');
    expect(secondBytes).toBe(firstBytes);
    expect(first.baseline.baselineVersion).toBe(1);
    expect(first.baseline.roots[fixture.rootId]?.entries.length).toBeGreaterThan(0);

    let error: unknown;
    try {
      writeBaselineSnapshot({
        projectRoot: fixture.directory,
        loadedConfig: fixture.loaded,
        yes: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(isNexusError(error) && error.code === 'E00').toBe(true);
  });

  it('reads a committed baseline from a git ref', () => {
    writeBaselineSnapshot({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
      yes: true,
    });
    execFileSync('git', ['init', '-q'], { cwd: fixture.directory });
    execFileSync('git', ['add', 'nexus.baseline.json'], { cwd: fixture.directory });
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=phase03', 'commit', '-qm', 'baseline'],
      { cwd: fixture.directory },
    );
    const result = diffCurrentSurface({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
      base: 'HEAD',
    });
    expect(result.diff.counts.total).toBe(0);
    expect(result.baseLabel).toBe('HEAD:nexus.baseline.json');
  });

  it('reports a clean diff and classifies each severity from a mutated baseline', () => {
    writeBaselineSnapshot({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
      yes: true,
    });
    const clean = diffCurrentSurface({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
    });
    expect(clean.diff.counts.total).toBe(0);

    const current = createSurfaceSnapshot({
      projectRoot: fixture.directory,
      loadedConfig: fixture.loaded,
    }).snapshot;
    const baselineRead = readBaseline(path.join(fixture.directory, 'nexus.baseline.json'));
    expect(baselineRead.error).toBeNull();
    const baseline = JSON.parse(JSON.stringify(baselineRead.baseline));
    const root = baseline.roots[fixture.rootId];
    root.entries = root.entries.filter(
      (entry: { name: string; condition: string | null }) =>
        !(entry.name === 'add' && entry.condition === 'types'),
    );
    const format = root.entries.find(
      (entry: { name: string; condition: string | null }) =>
        entry.name === 'format' && entry.condition === 'types',
    );
    format.normalizedSignature = `${format.normalizedSignature} /* mutated */`;
    const ghost = { ...format, name: 'ghostExport', symbolId: 's_ghost' };
    root.entries.push(ghost);
    root.internal[0].normalizedSignature = `${root.internal[0].normalizedSignature} /* changed */`;

    const diff = diffSnapshots(current, baseline);
    expect(diff.counts.additive).toBeGreaterThan(0);
    expect(diff.counts.breaking).toBeGreaterThan(0);
    expect(diff.counts.ambiguous).toBeGreaterThan(0);
    expect(diff.counts.internal).toBeGreaterThan(0);
    for (const item of diff.items) {
      expect(item.evidence.symbolId === null || item.evidence.symbolId.startsWith('s_')).toBe(true);
      expect(item.rationale.length).toBeGreaterThan(0);
      expect(item.id).toMatch(/^sd_/);
    }
  });

  it('changes surfaceHash when the evidence source set changes', async () => {
    const directory = makeProject('F07-api-surface', 'f07-hash');
    try {
      await initProject(directory, { skipTypecheck: true });
      const loaded = await loadConfig({ projectRoot: directory });
      const rootId = loaded.config?.workspaces.roots[0] ?? '';
      await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
      const first = readSurface(directory, rootId).surface!;
      const packagePath = path.join(directory, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        exports: Record<string, unknown>;
      };
      packageJson.exports['.'] = './src/index.ts';
      fs.writeFileSync(
        packagePath,
        `${JSON.stringify(packageJson, null, 2)}
`,
      );
      const reloaded = await loadConfig({ projectRoot: directory });
      await buildWorkspace({ projectRoot: directory, loadedConfig: reloaded });
      const second = readSurface(directory, rootId).surface!;
      expect(second.surfaceHash).not.toBe(first.surfaceHash);
      const conditions = new Set(
        second.entries.filter((entry) => entry.name === 'add').map((entry) => entry.condition),
      );
      expect(conditions).toEqual(new Set([null]));
    } finally {
      cleanup(directory);
    }
  }, 180_000);

  it('applies manual overrides without inventing a public entry', async () => {
    const manual = await indexFixture('F07-api-surface', 'f07-manual');
    try {
      const configPath = path.join(manual.directory, '.nexus', 'nexus.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        surface: { manual: unknown[] };
      };
      config.surface.manual = [
        { name: 'internalHelper', exposure: 'public', reason: 'fixture override' },
      ];
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const loaded = await loadConfig({ projectRoot: manual.directory });
      await buildWorkspace({ projectRoot: manual.directory, loadedConfig: loaded });
      const surface = readSurface(manual.directory, manual.rootId).surface!;
      const entry = surface.entries.find((candidate) => candidate.name === 'internalHelper');
      expect(entry).toBeDefined();
      expect(entry?.primaryEvidenceSource).toBe('manual-override');
      expect(entry?.entryPath).toBeNull();
    } finally {
      cleanup(manual.directory);
    }
  }, 180_000);
});
