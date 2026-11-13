import path from 'node:path';

import type { RootStatus, StatusReport } from '../status.js';
import { nexusError } from '../errors.js';

/**
 * Query-time root routing (docs/05-data-model.md 5.9). Indexes never cross a
 * root; this module only decides which roots a query may read and reports the
 * candidates when the cwd cannot be attributed to exactly one root.
 */
export type QueryScope = 'root' | 'roots' | 'all';

export interface ScopeCandidate {
  rootId: string;
  rootPath: string;
  indexed: boolean;
  active: boolean;
}

export interface ScopeSelection {
  scope: QueryScope;
  roots: RootStatus[];
  activeRoot: string | null;
  /** Roots that contain cwd in addition to the active root (nested roots). */
  nestedRootIds: string[];
  candidates: ScopeCandidate[];
  failedRoots: string[];
  staleRoots: string[];
}

export interface ScopeOptions {
  projectRoot: string;
  rootId?: string | null;
  roots?: string | 'all' | null;
  cwd: string;
}

function splitRootList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ].sort();
}

function candidateView(all: readonly RootStatus[], activeRoot: string | null): ScopeCandidate[] {
  return all.map((root) => ({
    rootId: root.rootId,
    rootPath: root.rootPath,
    indexed: root.staleness !== 'failed' && root.buildFingerprint !== null,
    active: root.rootId === activeRoot,
  }));
}

function rootsContaining(
  all: readonly RootStatus[],
  projectRoot: string,
  cwd: string,
): RootStatus[] {
  const relative = path.relative(projectRoot, cwd).replaceAll('\\', '/');
  const normalized = relative === '' ? '.' : relative.replace(/\/+$/, '');
  return all.filter((root) => {
    const rootPath = root.rootPath.replaceAll('\\', '/').replace(/\/+$/, '');
    if (rootPath === '' || rootPath === '.') return true;
    return normalized === rootPath || normalized.startsWith(`${rootPath}/`);
  });
}

function e16(status: StatusReport, reason: string): never {
  const candidates = candidateView(status.roots, status.activeRoot);
  throw nexusError('E16', 'working directory does not belong to a single root', {
    reason,
    suggestion: 'Pass --root <rootId> or --roots <id,id> (or --roots all).',
    evidence: { candidates },
  });
}

/**
 * Select the roots for one query. `--root` and `--roots` are mutually
 * exclusive (E00); an unattributable cwd without a scope is E16, never an
 * implicit "search everything".
 */
export function resolveQueryScope(status: StatusReport, options: ScopeOptions): ScopeSelection {
  if (status.state === 'uninitialized') {
    throw nexusError('E01', 'index does not exist', {
      reason: 'no completed build was found under .nexus/',
      suggestion: 'Run `nex init --yes` and `nex build`.',
    });
  }
  const explicitRoot =
    options.rootId !== undefined && options.rootId !== null && options.rootId !== ''
      ? options.rootId
      : null;
  const explicitRoots =
    options.roots !== undefined && options.roots !== null && options.roots !== ''
      ? options.roots
      : null;
  if (explicitRoot !== null && explicitRoots !== null) {
    throw nexusError('E00', '--root and --roots are mutually exclusive', {
      reason: 'both selectors were provided',
      suggestion: 'Pass exactly one of --root or --roots.',
    });
  }

  const all = status.roots;
  const activeRoot = status.activeRoot;
  const candidates = candidateView(all, activeRoot);
  const containing = rootsContaining(all, options.projectRoot, options.cwd);
  const nestedRootIds = containing
    .filter((root) => root.rootId !== activeRoot)
    .map((root) => root.rootId)
    .sort();

  if (explicitRoots === 'all') {
    const usable = all.filter((root) => root.staleness !== 'failed');
    const failedRoots = all
      .filter((root) => root.staleness === 'failed')
      .map((root) => root.rootId)
      .sort();
    if (usable.length === 0) {
      throw nexusError('E19', 'no root is queryable', {
        reason: 'all roots are failed',
        suggestion: 'Run `nex doctor` and rebuild.',
        evidence: { failedRoots },
      });
    }
    return {
      scope: 'all',
      roots: usable,
      activeRoot,
      nestedRootIds,
      candidates,
      failedRoots,
      staleRoots: usable
        .filter((root) => root.staleness !== 'fresh')
        .map((root) => root.rootId)
        .sort(),
    };
  }

  if (explicitRoots !== null) {
    const ids = splitRootList(explicitRoots);
    if (ids.length === 0) {
      throw nexusError('E00', 'empty --roots selection', {
        reason: 'no root id was provided',
        suggestion: 'Pass --roots all or a comma-separated list of root ids.',
        evidence: { candidates },
      });
    }
    const selected: RootStatus[] = [];
    for (const rootId of ids) {
      const found = all.find((root) => root.rootId === rootId);
      if (found === undefined) {
        throw nexusError('E16', 'root id not found', {
          reason: `unknown root: ${rootId}`,
          suggestion: 'Use one of the roots listed by `nex status`.',
          evidence: { candidates },
        });
      }
      selected.push(found);
    }
    return {
      scope: 'roots',
      roots: selected,
      activeRoot,
      nestedRootIds,
      candidates,
      failedRoots: selected
        .filter((root) => root.staleness === 'failed')
        .map((root) => root.rootId),
      staleRoots: selected
        .filter((root) => root.staleness !== 'fresh')
        .map((root) => root.rootId)
        .sort(),
    };
  }

  if (explicitRoot !== null) {
    const found = all.find((root) => root.rootId === explicitRoot);
    if (found === undefined) {
      throw nexusError('E16', 'root id not found', {
        reason: `unknown root: ${explicitRoot}`,
        suggestion: 'Use one of the roots listed by `nex status`.',
        evidence: { candidates },
      });
    }
    return {
      scope: 'root',
      roots: [found],
      activeRoot,
      nestedRootIds,
      candidates,
      failedRoots: found.staleness === 'failed' ? [found.rootId] : [],
      staleRoots: found.staleness === 'fresh' ? [] : [found.rootId],
    };
  }

  if (activeRoot === null) {
    e16(status, 'cwd is at the workspace root or outside every indexed root');
  }
  const active = all.find((root) => root.rootId === activeRoot);
  if (active === undefined) {
    throw nexusError('E16', 'active root is not indexed', {
      reason: `active root ${activeRoot} has no index`,
      suggestion: 'Pass --root explicitly or rebuild.',
      evidence: { candidates },
    });
  }
  return {
    scope: 'root',
    roots: [active],
    activeRoot,
    nestedRootIds,
    candidates,
    failedRoots: active.staleness === 'failed' ? [active.rootId] : [],
    staleRoots: active.staleness === 'fresh' ? [] : [active.rootId],
  };
}
