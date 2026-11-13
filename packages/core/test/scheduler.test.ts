import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GlobalResourceCoordinator,
  buildWorkspace,
  computeResourceBudget,
  computeRootWeights,
  detectAvailableMemoryMB,
  loadConfig,
  orderRootsByDependencies,
  type RootCandidate,
} from 'anemia-core';
import { manifestPath, readManifest } from '../src/store/manifest.js';
import { cleanup, initProject, makeEmptyProject, REPO_ROOT } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

function candidate(rootId: string, relative: string, packageName: string | null): RootCandidate {
  const absolutePath = path.join(REPO_ROOT, relative);
  return {
    rootId,
    rootPath: relative,
    absolutePath,
    packageName,
    tsconfigRelativePath: `${relative}/tsconfig.json`,
    tsconfig: null,
    indexable: true,
    reasons: [],
    sources: ['fixture'],
  };
}

describe('global resource coordinator (5.10)', () => {
  it('derives budget and concurrency from memory, config, CPU and roots', () => {
    const budget = computeResourceBudget({
      config: { maxMemoryMB: 1000, concurrency: 4 },
      rootCount: 3,
      estimatedPeakMB: 250,
      availableMemMB: 4000,
      cpuCores: 8,
    });
    expect(budget.globalBudgetMB).toBe(1000);
    expect(budget.concurrency).toBe(3);
    const squeezed = computeResourceBudget({
      config: { maxMemoryMB: 1000, concurrency: 4 },
      rootCount: 3,
      estimatedPeakMB: 250,
      availableMemMB: 1000,
      cpuCores: 8,
    });
    expect(squeezed.globalBudgetMB).toBe(500);
    expect(squeezed.concurrency).toBe(2);
  });

  it('derives an automatic budget from available memory instead of a fixed 900 MB', () => {
    const roomy = computeResourceBudget({
      config: { concurrency: 1 },
      rootCount: 1,
      availableMemMB: 16384,
      cpuCores: 8,
    });
    expect(roomy.configuredMaxMemoryMB).toBeNull();
    expect(roomy.source.auto).toBe(true);
    expect(roomy.dynamicBudgetMB).toBe(8192);
    expect(roomy.globalBudgetMB).toBe(8192);
    expect(roomy.globalBudgetMB).toBeGreaterThan(900);

    const tight = computeResourceBudget({
      config: { concurrency: 1 },
      rootCount: 1,
      availableMemMB: 1000,
      cpuCores: 8,
    });
    expect(tight.dynamicBudgetMB).toBe(500);
    expect(tight.globalBudgetMB).toBe(500);

    const tiny = computeResourceBudget({
      config: { concurrency: 1 },
      rootCount: 1,
      availableMemMB: 100,
      cpuCores: 8,
    });
    expect(tiny.globalBudgetMB).toBe(100);
    expect(tiny.globalBudgetMB).toBeLessThanOrEqual(tiny.availableMemMB);
  });

  it('keeps an explicit cap but never exceeds half of available memory', () => {
    const explicit = computeResourceBudget({
      config: { maxMemoryMB: 900, concurrency: 1 },
      rootCount: 1,
      availableMemMB: 16384,
      cpuCores: 8,
    });
    expect(explicit.configuredMaxMemoryMB).toBe(900);
    expect(explicit.source.auto).toBe(false);
    expect(explicit.globalBudgetMB).toBe(900);

    const clamped = computeResourceBudget({
      config: { maxMemoryMB: 2000, concurrency: 1 },
      rootCount: 1,
      availableMemMB: 1000,
      cpuCores: 8,
    });
    expect(clamped.globalBudgetMB).toBe(500);
    expect(clamped.source.configMaxMemoryMB).toBe(2000);
  });

  it('detects available memory without throwing', () => {
    const detected = detectAvailableMemoryMB();
    expect(Number.isInteger(detected.availableMemMB)).toBe(true);
    expect(detected.availableMemMB).toBeGreaterThan(0);
    expect(['process', 'os', 'fallback']).toContain(detected.detection);
  });

  it('records the dynamic budget source in the coordinator summary', () => {
    const budget = computeResourceBudget({
      config: { maxMemoryMB: 1000, concurrency: 2 },
      rootCount: 2,
      availableMemMB: 4000,
      cpuCores: 8,
    });
    const roots = [
      candidate('alpha', 'fixtures/F18-scheduler/packages/alpha', '@f18/alpha'),
      candidate('beta', 'fixtures/F18-scheduler/packages/beta', '@f18/beta'),
    ];
    const coordinator = new GlobalResourceCoordinator({
      budget,
      weights: computeRootWeights({
        roots,
        previousPeakMB: new Map(),
        globalBudgetMB: budget.globalBudgetMB,
      }),
    });
    const summary = coordinator.resourceSummary();
    expect(summary.availableMemMB).toBe(4000);
    expect(summary.dynamicBudgetMB).toBe(2000);
    expect(summary.configuredMaxMemoryMB).toBe(1000);
    expect(summary.autoBudget).toBe(false);
    expect(summary.effectiveBudgetMB).toBe(1000);
  });

  it('normalizes root weights from previous peak RSS', () => {
    const roots = [
      candidate('alpha', 'fixtures/F18-scheduler/packages/alpha', '@f18/alpha'),
      candidate('beta', 'fixtures/F18-scheduler/packages/beta', '@f18/beta'),
    ];
    const weights = computeRootWeights({
      roots,
      previousPeakMB: new Map([
        ['alpha', 300],
        ['beta', 100],
      ]),
      globalBudgetMB: 1000,
    });
    expect(weights[0]?.weight).toBeCloseTo(0.75);
    expect(weights[1]?.weight).toBeCloseTo(0.25);
  });

  it('orders roots by declared package dependencies', () => {
    const roots = [
      candidate('gamma', 'fixtures/F18-scheduler/packages/gamma', '@f18/gamma'),
      candidate('beta', 'fixtures/F18-scheduler/packages/beta', '@f18/beta'),
      candidate('alpha', 'fixtures/F18-scheduler/packages/alpha', '@f18/alpha'),
    ];
    const ordered = orderRootsByDependencies(roots).map((root) => root.rootId);
    expect(ordered.indexOf('alpha')).toBeLessThan(ordered.indexOf('beta'));
    expect(ordered.indexOf('beta')).toBeLessThan(ordered.indexOf('gamma'));
  });

  it('walks the five-step ladder in order and aborts at E20', () => {
    const budget = computeResourceBudget({
      config: { maxMemoryMB: 1000, concurrency: 1 },
      rootCount: 1,
      estimatedPeakMB: 1000,
      availableMemMB: 4000,
      cpuCores: 8,
    });
    const roots = [candidate('alpha', 'fixtures/F18-scheduler/packages/alpha', '@f18/alpha')];
    const coordinator = new GlobalResourceCoordinator({
      budget,
      weights: computeRootWeights({
        roots,
        previousPeakMB: new Map([['alpha', 1000]]),
        globalBudgetMB: budget.globalBudgetMB,
      }),
    });
    expect(coordinator.flags()).toEqual({
      disableCalls: false,
      chunked: false,
      reduceVueProjection: false,
      serialized: false,
      abort: false,
    });
    const observed = coordinator.observePeak('alpha', 900);
    expect(observed.degraded).toBe(true);
    expect(coordinator.currentStages()).toEqual(['calls-off']);
    expect(coordinator.flags().disableCalls).toBe(true);
    expect(coordinator.degrade('test-1')).toBe('chunked');
    expect(coordinator.degrade('test-2')).toBe('vue-projection-reduced');
    expect(coordinator.degrade('test-3')).toBe('serialize');
    expect(coordinator.degrade('test-4')).toBe('abort-root');
    expect(coordinator.shouldAbort()).toBe(true);
    expect(coordinator.flags().abort).toBe(true);
  });
});

describe('F18 scheduler integration', () => {
  it('builds all three roots and preserves the previous index on cancellation', async () => {
    const directory = makeEmptyProject('f18-sched');
    directories.push(directory);
    fs.cpSync(path.join(REPO_ROOT, 'fixtures', 'F18-scheduler'), directory, {
      recursive: true,
    });
    await initProject(directory, { roots: 'all' });
    const loaded = await loadConfig({ projectRoot: directory });
    const first = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(first.failedRoots).toEqual([]);
    expect(first.roots).toHaveLength(3);
    const before = new Map(
      first.roots.map((root) => [
        root.rootId,
        readManifest(manifestPath(directory, root.rootId)).manifest?.buildId,
      ]),
    );
    fs.appendFileSync(
      path.join(directory, 'packages', 'alpha', 'src', 'index.ts'),
      '\nexport const phase06Cancelled = true;\n',
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await buildWorkspace({
      projectRoot: directory,
      loadedConfig: loaded,
      mode: 'update',
      signal: controller.signal,
    });
    expect(cancelled.failedRoots).toHaveLength(3);
    expect(cancelled.roots.every((root) => root.errorCode === 'E20')).toBe(true);
    for (const root of cancelled.roots) {
      const manifest = readManifest(manifestPath(directory, root.rootId)).manifest;
      expect(manifest?.buildId).toBe(before.get(root.rootId));
    }
  });

  it('isolates a failing root and keeps its previous index', async () => {
    const directory = makeEmptyProject('f18-isolate');
    directories.push(directory);
    fs.cpSync(path.join(REPO_ROOT, 'fixtures', 'F18-scheduler'), directory, {
      recursive: true,
    });
    await initProject(directory, { roots: 'all' });
    const loaded = await loadConfig({ projectRoot: directory });
    const first = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
    expect(first.failedRoots).toEqual([]);
    const gamma = first.roots.find((root) => root.rootId.includes('gamma'));
    expect(gamma).toBeDefined();
    const gammaBefore = readManifest(manifestPath(directory, gamma?.rootId ?? '')).manifest;
    // Remove every source file of gamma; the writer rejects an empty build (E23).
    fs.rmSync(path.join(directory, 'packages', 'gamma', 'src'), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(path.join(directory, 'packages', 'gamma', 'src'));
    const second = await buildWorkspace({
      projectRoot: directory,
      loadedConfig: loaded,
      mode: 'update',
    });
    expect(second.failedRoots.length).toBe(1);
    expect(second.failedRoots[0]).toBe(gamma?.rootId);
    const gammaAfter = readManifest(manifestPath(directory, gamma?.rootId ?? '')).manifest;
    expect(gammaAfter?.state).toBe('stale');
    expect(gammaAfter?.buildId).toBe(gammaBefore?.buildId);
    const others = second.roots.filter((root) => root.ok);
    expect(others.length).toBe(2);
  });
});
