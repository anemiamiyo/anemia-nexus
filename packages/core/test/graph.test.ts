import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkspace,
  loadConfig,
  openReadStore,
  queryDependencies,
  querySymbol,
  statusReport,
  type NexusConfig,
} from 'anemia-core';

import { cleanup, initProject, makeProject } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

function readConfig(directory: string): NexusConfig {
  return JSON.parse(
    fs.readFileSync(path.join(directory, '.nexus', 'nexus.config.json'), 'utf8'),
  ) as NexusConfig;
}

function writeConfig(directory: string, config: NexusConfig): void {
  fs.writeFileSync(
    path.join(directory, '.nexus', 'nexus.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function styleTypes(items: ReadonlyArray<{ depType: string; relationClass: string }>): Set<string> {
  return new Set(items.map((item) => item.depType));
}

describe('Phase 04 graph', () => {
  it('F13 yields all five S1 style edge kinds without style symbols', async () => {
    const directory = makeProject('F13-style-deps', 'f13');
    directories.push(directory);
    await initProject(directory);
    const config = readConfig(directory);
    config.style.aliases = { '@styles': 'src/styles' };
    config.architecture = {
      modules: [{ name: 'app', include: ['src/main.ts'], allow: [] }],
    };
    config.surface.entries = ['src/main.ts'];
    writeConfig(directory, config);
    const loaded = await loadConfig({ projectRoot: directory });
    const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(build.failedRoots).toEqual([]);
    const rootId = loaded.config?.workspaces.roots[0] ?? '';
    expect(rootId).not.toBe('');

    const app = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/styles/app.scss',
      'style',
      false,
    );
    expect(styleTypes(app.envelope.items)).toEqual(
      new Set(['style-use', 'style-forward', 'style-import']),
    );
    for (const item of app.envelope.items) {
      expect(item.relationClass).toBe('certain');
      expect(item.evidence).toMatchObject({ sourceOfTruth: 'style-lexer' });
    }

    const vue = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/App.vue',
      'style',
      false,
    );
    expect(styleTypes(vue.envelope.items)).toEqual(new Set(['style-src']));

    const script = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/main.ts',
      'style',
      false,
    );
    expect(styleTypes(script.envelope.items)).toEqual(new Set(['style-import']));
    expect(script.envelope.items[0]?.analysisEngine).toBe('script-side');

    const edges = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/styles/edge-cases.scss',
      'style',
      false,
    );
    const reasons = new Set(edges.envelope.items.map((item) => item.unresolvedReason));
    expect(reasons.has('dynamic-path')).toBe(true);
    expect(reasons.has('not-found')).toBe(true);
    expect(reasons.has('sass-builtin')).toBe(true);
    expect(reasons.has('external-package')).toBe(true);
    const alias = edges.envelope.items.find((item) => item.relationClass === 'heuristic');
    expect(alias?.confidence).toBe('heuristic');
    expect(alias?.targetFile).toBe('src/styles/base.css');

    const store = openReadStore(path.join(directory, '.nexus', 'roots', rootId, 'index.db'));
    expect(store).not.toBeNull();
    try {
      const rows = store?.db
        .prepare(
          "select count(*) as count from symbols where path like '%.scss' or path like '%.css' or path like '%.less'",
        )
        .get() as { count?: number };
      expect(rows.count).toBe(0);
    } finally {
      store?.db.close();
    }

    const symbol = await querySymbol(
      { projectRoot: directory, cwd: directory, rootId },
      'main',
      false,
    );
    expect(symbol.envelope.items[0]?.api?.ownerModule).toBe('app');

    const blind = edges.data.blindSpots as Array<{
      category: string;
      affectedFiles: number;
      potentiallyAffectedSymbols: number | null;
      manualCheckHint: string;
    }>;
    expect(blind.some((spot) => spot.category === 'style' && spot.affectedFiles > 0)).toBe(true);
    for (const spot of blind) {
      expect(typeof spot.affectedFiles).toBe('number');
      expect(
        spot.potentiallyAffectedSymbols === null ||
          typeof spot.potentiallyAffectedSymbols === 'number',
      ).toBe(true);
      expect(spot.manualCheckHint.length).toBeGreaterThan(0);
    }
    const tmpDirectory = path.join(directory, '.nexus', 'tmp');
    expect(fs.existsSync(tmpDirectory) ? fs.readdirSync(tmpDirectory).length : 0).toBe(0);
  }, 120_000);

  it('F06 marks dynamic and heuristic calls without promoting them to certain', async () => {
    const directory = makeProject('F06-dynamic', 'f06');
    directories.push(directory);
    await initProject(directory);
    const loaded = await loadConfig({ projectRoot: directory });
    const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(build.failedRoots).toEqual([]);
    const rootId = loaded.config?.workspaces.roots[0] ?? '';

    const deps = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/main.ts',
      'file',
      false,
    );
    const dynamicImport = deps.envelope.items.find((item) => item.depType === 'dynamic-import');
    expect(dynamicImport?.relationClass).toBe('dynamic-unresolved');
    expect(dynamicImport?.unresolvedReason).toBe('dynamic-import');

    const calls = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'caller',
      'call',
      false,
    );
    const resolutions = new Set(calls.envelope.items.map((item) => item.confidence));
    expect(resolutions.has('direct')).toBe(true);
    expect(resolutions.has('heuristic')).toBe(true);
    expect(resolutions.has('unresolved')).toBe(true);
    expect(calls.envelope.items.some((item) => item.unresolvedReason === 'eval')).toBe(true);
    expect(calls.envelope.items.some((item) => item.unresolvedReason === 'dynamic-callee')).toBe(
      true,
    );
    expect(calls.envelope.counts.certain).toBe(1);
    expect(calls.envelope.counts.heuristic).toBe(1);
  }, 120_000);

  it('F14 keeps cross-root edges only when declared and exports-resolvable', async () => {
    const directory = makeProject('F14-multi-root', 'f14');
    directories.push(directory);
    await initProject(directory);
    const config = readConfig(directory);
    config.architecture = {
      modules: [
        { name: 'app', include: ['packages/app/**'], allow: [] },
        { name: 'ui', include: ['packages/ui/**'], allow: ['app'] },
        { name: 'lib', include: ['packages/lib/**'], allow: [] },
      ],
    };
    writeConfig(directory, config);
    const loaded = await loadConfig({ projectRoot: directory });
    const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(build.failedRoots).toEqual([]);
    const roots = [...(loaded.config?.workspaces.roots ?? [])];
    expect(roots.sort()).toEqual(['f14-app', 'f14-lib', 'f14-ui']);

    const deps = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId: 'f14-app' },
      'packages/app/src/main.ts',
      'file',
      false,
    );
    const certain = deps.envelope.items.filter((item) => item.relationClass === 'certain');
    expect(certain).toHaveLength(1);
    expect(certain[0]?.depType).toBe('cross-package');
    expect(certain[0]?.targetFile).toBe('packages/ui/src/index.ts');
    const reasons = deps.envelope.items
      .map((item) => item.unresolvedReason)
      .filter((reason): reason is string => reason !== null);
    expect(reasons).toContain('package-boundary:exports-mismatch');
    expect(reasons).toContain('package-boundary:root-not-indexed');
    expect(reasons).toContain('package-boundary:undeclared-dependency');
    expect(reasons).toContain('outside-root');
    expect(deps.envelope.counts.dynamicUnresolved).toBe(4);

    const moduleView = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId: 'f14-app' },
      'app',
      'module',
      false,
    );
    const violations = moduleView.data.violations as Array<{ ruleId: string }>;
    expect(violations.some((violation) => violation.ruleId === 'arch/app->ui')).toBe(true);

    const status = await statusReport({
      projectRoot: directory,
      cwd: directory,
      self: {
        serverVersion: '',
        packageName: '',
        binaryPath: '',
        projectRoot: '.',
        nodeVersion: process.versions.node,
      },
    });
    expect(status.capabilities.dependencyGraph).toBe('file-level');
    expect(status.capabilities.styleDependency).toBe('file-level');
    expect(status.roots.every((root) => root.dependencies >= 0)).toBe(true);
  }, 180_000);

  it('F01 exposes file dependencies and static call edges with evidence', async () => {
    const directory = makeProject('F01-reexport-chain', 'f01-graph');
    directories.push(directory);
    await initProject(directory);
    const loaded = await loadConfig({ projectRoot: directory });
    const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(build.failedRoots).toEqual([]);
    const rootId = loaded.config?.workspaces.roots[0] ?? '';

    const deps = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/consumer.ts',
      'file',
      false,
    );
    expect(deps.envelope.items.length).toBeGreaterThanOrEqual(5);
    expect(deps.envelope.counts.certain).toBe(deps.envelope.items.length);
    expect(deps.envelope.items.every((item) => item.evidence !== null)).toBe(true);

    const secondBuild = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(secondBuild.roots[0]?.buildFingerprint).toBe(build.roots[0]?.buildFingerprint);
    const depsAgain = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'src/consumer.ts',
      'file',
      false,
    );
    expect(JSON.stringify(depsAgain.envelope.items)).toBe(JSON.stringify(deps.envelope.items));

    const calls = await queryDependencies(
      { projectRoot: directory, cwd: directory, rootId },
      'add',
      'call',
      true,
    );
    expect(calls.envelope.counts.certain).toBe(2);
    expect(calls.envelope.items[0]?.calleeName).toBe('add');
    expect(calls.envelope.items.every((item) => item.analysisEngine === 'ts-ast')).toBe(true);
  }, 120_000);
});
