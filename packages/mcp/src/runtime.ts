import fs from 'node:fs';
import path from 'node:path';

import {
  buildWorkspace,
  loadConfig,
  mapUnknownError,
  nexusError,
  statusReport,
  type BuildProgressEvent,
  type StatusReport,
} from 'anemia-core';

import { mcpPackageInfo } from './package-info.js';

export interface McpServerOptions {
  projectRoot: string;
  cwd?: string;
  trustConfig?: boolean;
  readOnly?: boolean;
  watch?: boolean;
  autoBootstrap?: boolean;
  binaryPath?: string;
  serverVersion?: string;
  packageName?: string;
}

export interface BootstrapState {
  state: 'idle' | 'indexing' | 'ready' | 'failed';
  message: string;
  percent: number | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RefreshState {
  running: boolean;
  pending: boolean;
  reason: string | null;
  lastChanged: number;
  lastError: string | null;
}

export interface RuntimeState {
  options: McpServerOptions;
  projectRoot: string;
  cwd: string;
  bootstrap: BootstrapState;
  refresh: RefreshState;
  queryCount: number;
  watcher: fs.FSWatcher | null;
  watchError: string | null;
  debounceTimer: NodeJS.Timeout | null;
  recheckTimer: NodeJS.Timeout | null;
  bootstrapController: AbortController | null;
  refreshController: AbortController | null;
  closed: boolean;
}

const WATCH_DEBOUNCE_MS = 500;
const RECHECK_INTERVAL_MS = 30_000;
const QUERY_RECHECK_EVERY = 50;
const WATCH_IGNORED_SEGMENTS = new Set([
  '.nexus',
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.cache',
  '.turbo',
  'coverage',
]);

export function createRuntime(options: McpServerOptions): RuntimeState {
  return {
    options: {
      ...options,
      projectRoot: path.resolve(options.projectRoot),
      cwd: path.resolve(options.cwd ?? options.projectRoot),
    },
    projectRoot: path.resolve(options.projectRoot),
    cwd: path.resolve(options.cwd ?? options.projectRoot),
    bootstrap: {
      state: 'idle',
      message: 'not started',
      percent: null,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
    },
    refresh: { running: false, pending: false, reason: null, lastChanged: 0, lastError: null },
    queryCount: 0,
    watcher: null,
    watchError: null,
    debounceTimer: null,
    recheckTimer: null,
    bootstrapController: null,
    refreshController: null,
    closed: false,
  };
}

export function serverSelf(
  runtime: RuntimeState,
  packageInfo = mcpPackageInfo(),
): {
  serverVersion: string;
  packageName: string;
  binaryPath: string;
  projectRoot: string;
  nodeVersion: string;
} {
  return {
    serverVersion: runtime.options.serverVersion ?? packageInfo.version,
    packageName: runtime.options.packageName ?? packageInfo.name,
    binaryPath: runtime.options.binaryPath ?? path.basename(process.argv[1] ?? 'nex'),
    projectRoot: '.',
    nodeVersion: process.versions.node,
  };
}

export async function currentStatus(runtime: RuntimeState): Promise<StatusReport> {
  return statusReport({
    projectRoot: runtime.projectRoot,
    cwd: runtime.cwd,
    trustConfig: runtime.options.trustConfig === true,
    self: serverSelf(runtime),
  });
}

export interface ScopeOptions {
  rootId: string | null;
  roots: string | null;
}

function rootsValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'all') return trimmed === 'all' ? 'all' : null;
    return trimmed;
  }
  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length === 0) return null;
    return entries.join(',');
  }
  return null;
}

/**
 * 5.9 / 14.1: `root` wins, then `roots`, otherwise bind the only root. A
 * multi-root workspace without an explicit scope is E16 with candidates, never
 * "pick the first".
 */
export async function resolveScope(
  runtime: RuntimeState,
  args: Record<string, unknown>,
): Promise<ScopeOptions> {
  const explicitRoot =
    typeof args.root === 'string' && args.root.trim() !== '' ? args.root.trim() : null;
  const explicitRoots = rootsValue(args.roots);
  if (explicitRoot !== null && explicitRoots !== null) {
    throw nexusError('E00', 'root and roots are mutually exclusive', {
      reason: 'both scope selectors were provided',
      suggestion: 'Pass either root or roots.',
    });
  }
  if (explicitRoot !== null) return { rootId: explicitRoot, roots: null };
  if (explicitRoots !== null) return { rootId: null, roots: explicitRoots };

  const status = await currentStatus(runtime);
  if (status.roots.length === 0) {
    if (runtime.bootstrap.state === 'indexing') {
      throw nexusError('E01', 'index is not ready yet', {
        reason: 'auto-bootstrap is still running',
        suggestion: 'Call `status` to read progress, then retry.',
        evidence: { bootstrap: runtime.bootstrap },
      });
    }
    throw nexusError('E01', 'index does not exist', {
      reason: 'no committed index and no root is indexed',
      suggestion: 'Run `nex init --roots all --write-config --yes` then `nex build`.',
      evidence: { bootstrap: runtime.bootstrap },
    });
  }
  if (status.roots.length > 1) {
    throw nexusError('E16', 'workspace root is ambiguous', {
      reason: `${status.roots.length} roots are indexed and no root/roots argument was provided`,
      suggestion: 'Pass root <rootId> or roots ["all"] explicitly.',
      evidence: {
        candidates: status.roots.map((root) => ({
          rootId: root.rootId,
          rootPath: root.rootPath,
          state: root.state,
          staleness: root.staleness,
        })),
      },
    });
  }
  const only = status.roots[0];
  return { rootId: only?.rootId ?? null, roots: null };
}

export function runtimeStatusView(
  runtime: RuntimeState,
  status: StatusReport,
  packageInfo = mcpPackageInfo(),
): Record<string, unknown> {
  const active = status.activeRoot ?? (status.roots.length === 1 ? status.roots[0]?.rootId : null);
  const activeRoot = status.roots.find((root) => root.rootId === active) ?? status.roots[0] ?? null;
  const degraded = [...new Set(status.roots.flatMap((root) => root.degraded))].sort();
  const integrity = activeRoot?.lastIntegrityCheck ??
    status.roots.find((root) => root.lastIntegrityCheck !== null)?.lastIntegrityCheck ?? {
      result: 'not-run',
      at: null,
    };
  const onboarding = status.onboarding;
  const bootstrapIndexing = runtime.bootstrap.state === 'indexing';
  return {
    state: status.state,
    staleness:
      status.state === 'uninitialized' && bootstrapIndexing ? 'indexing' : status.staleness,
    buildFingerprint: activeRoot?.buildFingerprint
      ? activeRoot.buildFingerprint.slice(0, 12)
      : null,
    rootId: active,
    activeRoot: status.activeRoot,
    roots: status.roots.map((root) => ({
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      state: root.state,
      staleness: root.staleness,
      files: root.files,
      symbols: root.symbols,
      references: root.references,
      dependencies: root.dependencies,
      calls: root.calls,
      tests: root.tests,
      buildFingerprintPrefix: root.buildFingerprintPrefix,
      surfaceHash: root.surfaceHash,
      surfaceEntries: root.surfaceEntries,
      degraded: root.degraded,
      staleReason: root.staleReason,
      lastIntegrityCheck: root.lastIntegrityCheck,
      coverage: root.coverage,
    })),
    coverage: status.coverage,
    capabilities: {
      ...status.capabilities,
      relationClasses: ['certain', 'heuristic', 'dynamic-unresolved'],
      mcpFormats: ['lines', 'json'],
    },
    self: serverSelf(runtime, packageInfo),
    lastIntegrityCheck: integrity,
    degraded,
    config: status.config,
    guidance:
      status.state === 'ready' || onboarding === null ? status.guidance : onboarding.nextCommands,
    onboarding,
    bootstrap: runtime.bootstrap,
    warnings: status.warnings,
    projectRoot: status.projectRoot,
  };
}

export function noteQuery(runtime: RuntimeState): void {
  runtime.queryCount += 1;
  if (
    runtime.queryCount % QUERY_RECHECK_EVERY === 0 &&
    runtime.options.watch === true &&
    runtime.options.readOnly !== true
  ) {
    scheduleWatchRefresh(runtime, 'query-recheck');
  }
}

export function startBootstrap(runtime: RuntimeState): void {
  if (runtime.options.readOnly === true || runtime.options.autoBootstrap !== true) return;
  if (runtime.bootstrap.state === 'indexing' || runtime.bootstrap.state === 'ready') return;
  runtime.bootstrap = {
    state: 'indexing',
    message: 'checking configuration',
    percent: 0,
    errorCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const controller = new AbortController();
  runtime.bootstrapController = controller;
  void (async () => {
    try {
      const loaded = await loadConfig({
        projectRoot: runtime.projectRoot,
        trustConfig: runtime.options.trustConfig === true,
      });
      if (loaded.config === null) {
        runtime.bootstrap = {
          ...runtime.bootstrap,
          state: 'failed',
          message: 'no configuration; auto-bootstrap never writes configuration',
          errorCode: 'E17',
          finishedAt: new Date().toISOString(),
        };
        return;
      }
      const result = await buildWorkspace({
        projectRoot: runtime.projectRoot,
        loadedConfig: loaded,
        mode: 'build',
        signal: controller.signal,
        onProgress: (event: BuildProgressEvent) => {
          runtime.bootstrap = {
            ...runtime.bootstrap,
            message: event.message,
          };
        },
      });
      const failed = result.failedRoots.length > 0;
      runtime.bootstrap = {
        ...runtime.bootstrap,
        state: failed ? 'failed' : 'ready',
        message: failed
          ? `failed roots: ${result.failedRoots.join(', ')}`
          : `indexed ${result.roots.length} root(s)`,
        percent: failed ? runtime.bootstrap.percent : 100,
        errorCode: failed ? 'E20' : null,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      const nexus = mapUnknownError(error);
      runtime.bootstrap = {
        ...runtime.bootstrap,
        state: 'failed',
        message: nexus.message,
        errorCode: nexus.code,
        finishedAt: new Date().toISOString(),
      };
    }
  })();
}

export function startWatch(runtime: RuntimeState): void {
  if (runtime.options.watch !== true || runtime.options.readOnly === true) return;
  if (runtime.watcher !== null) return;
  try {
    runtime.watcher = fs.watch(runtime.projectRoot, { recursive: true }, (_event, filename) => {
      if (runtime.closed) return;
      if (typeof filename === 'string' && isIgnoredWatchPath(filename)) return;
      scheduleWatchRefresh(runtime, 'fs-event');
    });
    runtime.watcher.on('error', (error) => {
      runtime.watchError = error.message;
    });
  } catch (error) {
    runtime.watchError = error instanceof Error ? error.message : String(error);
  }
  runtime.recheckTimer = setInterval(() => {
    if (runtime.closed) return;
    scheduleWatchRefresh(runtime, 'periodic-recheck');
  }, RECHECK_INTERVAL_MS);
  runtime.recheckTimer.unref();
}

function isIgnoredWatchPath(filename: string): boolean {
  const normalized = filename.replaceAll('\\', '/');
  return normalized.split('/').some((segment) => WATCH_IGNORED_SEGMENTS.has(segment));
}

export function scheduleWatchRefresh(runtime: RuntimeState, reason: string): void {
  if (runtime.closed || runtime.options.readOnly === true) return;
  if (runtime.debounceTimer !== null) clearTimeout(runtime.debounceTimer);
  runtime.debounceTimer = setTimeout(() => {
    runtime.debounceTimer = null;
    void runWatchRefresh(runtime, reason);
  }, WATCH_DEBOUNCE_MS);
  runtime.debounceTimer.unref();
}

async function runWatchRefresh(runtime: RuntimeState, reason: string): Promise<void> {
  if (runtime.closed) return;
  if (runtime.refresh.running) {
    runtime.refresh.pending = true;
    return;
  }
  runtime.refresh.running = true;
  runtime.refresh.reason = reason;
  runtime.refresh.pending = false;
  const controller = new AbortController();
  runtime.refreshController = controller;
  try {
    const loaded = await loadConfig({
      projectRoot: runtime.projectRoot,
      trustConfig: runtime.options.trustConfig === true,
    });
    if (loaded.config === null) {
      runtime.refresh.lastError = 'configuration is missing';
      return;
    }
    const result = await buildWorkspace({
      projectRoot: runtime.projectRoot,
      loadedConfig: loaded,
      mode: 'update',
      refreshGuard: { maxChangedFiles: 200, rejectFullRebuild: true },
      lockWaitMs: 0,
      signal: controller.signal,
    });
    runtime.refresh.lastChanged = result.roots.reduce(
      (sum, root) => sum + (root.changed?.total ?? 0),
      0,
    );
    runtime.refresh.lastError = null;
  } catch (error) {
    runtime.refresh.lastError = mapUnknownError(error).message;
  } finally {
    runtime.refresh.running = false;
    runtime.refreshController = null;
    if (runtime.refresh.pending && !runtime.closed) {
      scheduleWatchRefresh(runtime, 'queued');
    }
  }
}

export async function closeRuntime(runtime: RuntimeState): Promise<void> {
  runtime.closed = true;
  if (runtime.debounceTimer !== null) {
    clearTimeout(runtime.debounceTimer);
    runtime.debounceTimer = null;
  }
  if (runtime.recheckTimer !== null) {
    clearInterval(runtime.recheckTimer);
    runtime.recheckTimer = null;
  }
  runtime.watcher?.close();
  runtime.watcher = null;
  runtime.bootstrapController?.abort();
  runtime.refreshController?.abort();
}
