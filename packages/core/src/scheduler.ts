import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RootCandidate } from './discovery/roots.js';

/**
 * Global Resource Coordinator (docs/05-data-model.md 5.10).
 *
 * One module decides budget, ordering, concurrency admission, degradation and
 * cancellation. The index layer only reports progress and peaks.
 */
export const DEGRADATION_LADDER = [
  'calls-off',
  'chunked',
  'vue-projection-reduced',
  'serialize',
  'abort-root',
] as const;

export type DegradationStage = (typeof DEGRADATION_LADDER)[number];

export interface ResourceConfig {
  maxMemoryMB: number;
  concurrency: number;
}

export interface ResourceBudget {
  globalBudgetMB: number;
  availableMemMB: number;
  cpuCores: number;
  concurrency: number;
  source: {
    configMaxMemoryMB: number;
    configConcurrency: number;
    availableHalfMB: number;
  };
}

const MIN_ROOT_BUDGET_MB = 64;

export function computeResourceBudget(input: {
  config: ResourceConfig;
  rootCount: number;
  estimatedPeakMB?: number;
  availableMemMB?: number;
  cpuCores?: number;
}): ResourceBudget {
  const availableMemMB =
    input.availableMemMB ?? Math.max(0, Math.floor(os.freemem() / (1024 * 1024)));
  const cpuCores = input.cpuCores ?? Math.max(1, os.cpus().length);
  const availableHalfMB = Math.floor(availableMemMB * 0.5);
  const globalBudgetMB =
    availableHalfMB > 0
      ? Math.min(input.config.maxMemoryMB, availableHalfMB)
      : input.config.maxMemoryMB;
  const estimate = Math.max(
    MIN_ROOT_BUDGET_MB,
    input.estimatedPeakMB ?? Math.floor(globalBudgetMB / Math.max(1, input.rootCount)),
  );
  const byMemory = Math.max(1, Math.floor(globalBudgetMB / estimate));
  const byCpu = Math.max(1, cpuCores - 1);
  const concurrency = Math.max(
    1,
    Math.min(input.config.concurrency, byMemory, byCpu, Math.max(1, input.rootCount)),
  );
  return {
    globalBudgetMB,
    availableMemMB,
    cpuCores,
    concurrency,
    source: {
      configMaxMemoryMB: input.config.maxMemoryMB,
      configConcurrency: input.config.concurrency,
      availableHalfMB,
    },
  };
}

export interface RootWeight {
  rootId: string;
  weight: number;
  estimateMB: number;
}

/** Weights are normalized from the previous build's peak RSS (5.10.3). */
export function computeRootWeights(input: {
  roots: readonly RootCandidate[];
  previousPeakMB: ReadonlyMap<string, number>;
  globalBudgetMB: number;
}): RootWeight[] {
  const peaks = input.roots.map((root) => Math.max(0, input.previousPeakMB.get(root.rootId) ?? 0));
  const total = peaks.reduce((sum, value) => sum + value, 0);
  const fallback = input.globalBudgetMB / Math.max(1, input.roots.length);
  return input.roots.map((root, index) => {
    const peak = peaks[index] ?? 0;
    const weight = total > 0 ? peak / total : 1 / Math.max(1, input.roots.length);
    return {
      rootId: root.rootId,
      weight,
      estimateMB: Math.max(MIN_ROOT_BUDGET_MB, Math.round(peak > 0 ? peak : fallback)),
    };
  });
}

function readPackageDependencies(root: RootCandidate): string[] {
  try {
    const packageFile = path.join(root.absolutePath, 'package.json');
    if (!fs.existsSync(packageFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * Topological order: a depended-on root builds first (docs/05-data-model.md
 * 5.8.2). Cycles and unresolved packages fall back to stable `rootId` order.
 */
export function orderRootsByDependencies(roots: readonly RootCandidate[]): RootCandidate[] {
  const byPackage = new Map<string, RootCandidate>();
  for (const root of roots) {
    if (root.packageName !== null) byPackage.set(root.packageName, root);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const root of roots) {
    const edges = new Set<string>();
    for (const name of readPackageDependencies(root)) {
      const target = byPackage.get(name);
      if (target !== undefined && target.rootId !== root.rootId) edges.add(target.rootId);
    }
    dependencies.set(root.rootId, edges);
  }
  const ordered: RootCandidate[] = [];
  const remaining = new Map(roots.map((root) => [root.rootId, root]));
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((root) => {
        const edges = dependencies.get(root.rootId) ?? new Set<string>();
        for (const target of edges) if (remaining.has(target)) return false;
        return true;
      })
      .sort((left, right) =>
        left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0,
      );
    if (ready.length === 0) {
      // Cycle: stable order, never crash the build.
      const rest = [...remaining.values()].sort((left, right) =>
        left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0,
      );
      ordered.push(...rest);
      break;
    }
    const next = ready[0] as RootCandidate;
    ordered.push(next);
    remaining.delete(next.rootId);
  }
  return ordered;
}

export interface DegradationFlags {
  disableCalls: boolean;
  chunked: boolean;
  reduceVueProjection: boolean;
  serialized: boolean;
  abort: boolean;
}

export interface CoordinatorOptions {
  budget: ResourceBudget;
  weights: readonly RootWeight[];
  onEvent?: (event: {
    stage: DegradationStage;
    reason: string;
    peakMB: number;
    budgetMB: number;
  }) => void;
}

/**
 * Admission + degradation controller. Its order is fixed and must never be
 * rearranged (docs/05-data-model.md 5.10.4).
 */
export class GlobalResourceCoordinator {
  private level = 0;
  private readonly budget: ResourceBudget;
  private readonly weights: readonly RootWeight[];
  private readonly onEvent: CoordinatorOptions['onEvent'];
  private readonly peaks = new Map<string, number>();

  constructor(options: CoordinatorOptions) {
    this.budget = options.budget;
    this.weights = options.weights;
    this.onEvent = options.onEvent;
  }

  get globalBudgetMB(): number {
    return this.budget.globalBudgetMB;
  }

  get concurrency(): number {
    return this.level >= 3 ? 1 : this.budget.concurrency;
  }

  rootBudgetMB(rootId: string): number {
    const weight = this.weights.find((entry) => entry.rootId === rootId);
    if (weight === undefined) {
      return Math.max(
        MIN_ROOT_BUDGET_MB,
        Math.floor(this.budget.globalBudgetMB / Math.max(1, this.weights.length)),
      );
    }
    return Math.max(MIN_ROOT_BUDGET_MB, Math.round(this.budget.globalBudgetMB * weight.weight));
  }

  flags(): DegradationFlags {
    return {
      disableCalls: this.level >= 1,
      chunked: this.level >= 2,
      reduceVueProjection: this.level >= 3,
      serialized: this.level >= 3,
      abort: this.level >= 4,
    };
  }

  currentStages(): DegradationStage[] {
    return DEGRADATION_LADDER.slice(0, this.level);
  }

  /** Called after each root build with its sampled peak. */
  observePeak(
    rootId: string,
    peakMB: number,
  ): { degraded: boolean; stage: DegradationStage | null } {
    this.peaks.set(rootId, peakMB);
    const budgetMB = this.rootBudgetMB(rootId);
    if (budgetMB <= 0 || peakMB < budgetMB * 0.85) {
      return { degraded: false, stage: null };
    }
    if (this.level >= DEGRADATION_LADDER.length - 1) {
      this.level = DEGRADATION_LADDER.length;
      const stage = DEGRADATION_LADDER[this.level - 1] as DegradationStage;
      this.onEvent?.({ stage, reason: 'rss-over-85-percent', peakMB, budgetMB });
      return { degraded: true, stage };
    }
    this.level += 1;
    const stage = DEGRADATION_LADDER[this.level - 1] as DegradationStage;
    this.onEvent?.({ stage, reason: 'rss-over-85-percent', peakMB, budgetMB });
    return { degraded: true, stage };
  }

  /** Explicit pressure injection used by tests and by failed RSS probes. */
  degrade(reason: string): DegradationStage | null {
    if (this.level >= DEGRADATION_LADDER.length) return null;
    this.level += 1;
    const stage = DEGRADATION_LADDER[this.level - 1] as DegradationStage;
    this.onEvent?.({
      stage,
      reason,
      peakMB: 0,
      budgetMB: this.globalBudgetMB,
    });
    return stage;
  }

  shouldAbort(): boolean {
    return this.level >= DEGRADATION_LADDER.length;
  }

  resourceSummary(): {
    budgetMB: number;
    concurrency: number;
    peakRssMBGlobal: number;
    degradedStages: string[];
  } {
    return {
      budgetMB: this.globalBudgetMB,
      concurrency: this.concurrency,
      peakRssMBGlobal: Math.max(0, ...this.peaks.values()),
      degradedStages: [...this.currentStages()],
    };
  }
}
