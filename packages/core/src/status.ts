import fs from 'node:fs';
import path from 'node:path';

import type { Counts, Coverage, StalenessState, VueAnalysisSummary } from './model.js';
import type { LoadedConfig } from './config/load.js';
import { loadConfig } from './config/load.js';
import { resolveRootConfig } from './config/merge.js';
import { IgnoreMatcher } from './discovery/ignore.js';
import { discoverRoots } from './discovery/roots.js';
import { scanFiles, filesHash, statHash } from './discovery/scan.js';
import { readTsconfig } from './discovery/tsconfig.js';
import { isInside } from './util/paths.js';
import { readManifest, rootDirectory, type RootManifest } from './store/manifest.js';
import { latestCommittedBuild, openDatabase } from './store/db.js';
import { clearStaleIndexingMarker, deriveRootState, readIndexingMarker } from './store/state.js';
import { computeTsconfigHash, tsconfigStat } from './index/invalidation.js';
import { ANALYZER_VERSION } from './index/analyzer.js';
import { readSurface } from './surface/store.js';

export const CAPABILITIES = {
  styleDependency: 'file-level',
  styleSelector: 'none',
  htmlFileRef: 'experimental-off',
  vue: 'sfc-semantic',
  templateReferences: ['component-use', 'template-binding', 'interpolation'],
  apiSurface: 'evidence-sources',
  dependencyGraph: 'file-level',
  callGraph: 'static-ts',
  architectureRules: 'allow-list',
  testRelations: 'reference-call-derived',
  impactAnalysis: 'certain-with-blind-spots',
  auditOrchestration: 'cli-only',
  queryRootRouting: 'root|roots|all',
  incremental: 'root-level',
  crashRecovery: 'matrix-12.3.3',
  stateMachine: 'fresh|dirty|indexing|stale|failed',
  scheduler: 'cooperative',
  mcpFormats: ['lines', 'json'] as string[],
  mcpTools: 'status|search|symbol|references|deps|impact|context|refresh',
  mcpReadOnly: 'seven-tools-no-refresh',
  dynamicUnresolved: 'marked',
} as const;

export interface WarningItem {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface SelfInfo {
  serverVersion: string;
  packageName: string;
  binaryPath: string;
  projectRoot: string;
  nodeVersion: string;
}

export interface RootStatus {
  rootId: string;
  rootPath: string;
  packageName: string | null;
  state: 'ready' | 'stale' | 'failed';
  staleness: StalenessState;
  files: number;
  symbols: number;
  references: number;
  dependencies: number;
  calls: number;
  tests: number;
  styleEdges: number;
  crossRootEdges: number;
  architectureViolations: number;
  blindSpotCount: number;
  buildFingerprint: string | null;
  buildFingerprintPrefix: string | null;
  surfaceHash: string | null;
  surfaceEntries: number;
  degraded: string[];
  coverage: Coverage;
  vue: VueAnalysisSummary | null;
  staleReason: string[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastIntegrityCheck: RootManifest['lastIntegrityCheck'] | null;
  error: string | null;
}

export interface ConfigStatus {
  sourceKind: 'json' | 'ts' | 'none';
  path: string | null;
  authorization: 'none' | 'flag' | 'trust-file';
  needsTrust: boolean;
  valid: boolean;
  warning: string | null;
}

export interface OnboardingCandidate {
  rootId: string;
  rootPath: string;
  indexable: boolean;
}

export interface OnboardingInfo {
  state: 'uninitialized' | 'ready';
  environment: {
    nodeVersion: string;
    nodeSatisfied: boolean;
    configKind: ConfigStatus['sourceKind'];
    needsTrust: boolean;
    tsconfig: { found: boolean; path: string | null };
    git: 'available' | 'missing-or-worktree';
    typecheck: 'not-run';
  };
  candidates: OnboardingCandidate[];
  nextCommands: string[];
  estimateSeconds: { min: number; max: number; basis: string };
  assets: string[];
}

export interface StatusReport {
  state: 'uninitialized' | 'ready';
  staleness: StalenessState | 'uninitialized';
  activeRoot: string | null;
  roots: RootStatus[];
  coverage: Coverage;
  counts: Counts;
  capabilities: typeof CAPABILITIES;
  self: SelfInfo;
  config: ConfigStatus;
  guidance: string[];
  onboarding: OnboardingInfo | null;
  warnings: WarningItem[];
  projectRoot: string;
}

const EMPTY_COVERAGE: Coverage = {
  filesCovered: 0,
  filesSkipped: 0,
  filesIgnored: 0,
  filesFailed: 0,
  resolved: 0,
  unresolved: 0,
  unmapped: 0,
  filteredInternal: 0,
};

function relativeDisplay(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replaceAll('\\', '/');
  return relative === '' ? '.' : relative;
}

function listManifestRoots(
  projectRoot: string,
): Array<{ rootId: string; manifest: RootManifest | null; error: string | null }> {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(rootsDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const output: Array<{ rootId: string; manifest: RootManifest | null; error: string | null }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.lock')) continue;
    const read = readManifest(path.join(rootsDir, entry.name, 'manifest.json'));
    output.push({ rootId: entry.name, manifest: read.manifest, error: read.error });
  }
  output.sort((left, right) =>
    left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0,
  );
  return output;
}

export interface VerifyFreshnessInput {
  projectRoot: string;
  manifest: RootManifest;
  loadedConfig: LoadedConfig | null;
}

export function verifyFreshness(input: VerifyFreshnessInput): {
  staleness: StalenessState;
  reasons: string[];
} {
  const { manifest, projectRoot } = input;
  const config = input.loadedConfig?.config ?? null;
  let currentConfigHash: string | null = null;
  let currentTsconfigHash: string | null = null;
  if (config !== null) {
    try {
      const effective = resolveRootConfig(config, manifest.rootId, config.roots[manifest.rootId]);
      currentConfigHash = effective.configHash;
      const rootAbs = path.resolve(projectRoot, manifest.rootPath);
      const stat = tsconfigStat(rootAbs);
      if (
        manifest.tsconfigHash !== undefined &&
        manifest.tsconfigHash !== '' &&
        manifest.tsconfigMtimeMs === stat.mtimeMs &&
        manifest.tsconfigSize === stat.size
      ) {
        currentTsconfigHash = manifest.tsconfigHash;
      } else {
        currentTsconfigHash = computeTsconfigHash(
          rootAbs,
          manifest.tsconfig ?? `${manifest.rootPath}/tsconfig.json`,
        );
      }
    } catch {
      currentConfigHash = null;
      currentTsconfigHash = null;
    }
  }
  let currentFilesHash: string | null = null;
  let scanFailed = false;
  if (config !== null && typeof manifest.filesHash === 'string' && manifest.filesHash !== '') {
    try {
      const effective = resolveRootConfig(config, manifest.rootId, config.roots[manifest.rootId]);
      const rootAbs = path.resolve(projectRoot, manifest.rootPath);
      const tsconfig = readTsconfig(
        rootAbs,
        manifest.tsconfig ?? `${manifest.rootPath}/tsconfig.json`,
      );
      const ignore = new IgnoreMatcher(effective.ignore);
      const scanOptions = {
        projectRoot,
        rootPath: rootAbs,
        absoluteRoot: rootAbs,
        ignore,
        tsconfigFileNames: tsconfig.ok ? tsconfig.fileNames : undefined,
      };
      let changed = true;
      if (manifest.statHash !== undefined && manifest.statHash !== '') {
        // Fast path: stat-only probe. A match proves the file set/size/mtime is
        // unchanged, so the content hash cannot have changed under normal use.
        const quick = scanFiles({ ...scanOptions, statOnly: true });
        if (statHash(quick.files) === manifest.statHash) {
          changed = false;
          currentFilesHash = manifest.filesHash;
        }
      }
      if (changed) {
        const scan = scanFiles(scanOptions);
        currentFilesHash = filesHash(scan.files);
      }
    } catch {
      scanFailed = true;
    }
  }
  const surfaceMatchesManifest: boolean | null = (() => {
    try {
      return readSurface(projectRoot, manifest.rootId).matchesManifest;
    } catch {
      return null;
    }
  })();
  clearStaleIndexingMarker(projectRoot, manifest.rootId);
  const marker = readIndexingMarker(projectRoot, manifest.rootId);
  const derivation = deriveRootState({
    manifest,
    manifestExists: true,
    currentFilesHash,
    currentConfigHash,
    currentTsconfigHash,
    currentAnalyzerVersion: ANALYZER_VERSION,
    marker,
    surfaceMatchesManifest,
  });
  if (scanFailed) {
    return { staleness: 'stale', reasons: [...derivation.reasons, 'freshness-check-failed'] };
  }
  return { staleness: derivation.state, reasons: derivation.reasons };
}

export function findActiveRoot(
  projectRoot: string,
  roots: readonly { rootId: string; rootPath: string }[],
  cwd: string,
): string | null {
  const cwdAbs = path.resolve(cwd);
  let best: { rootId: string; length: number } | null = null;
  for (const root of roots) {
    const rootAbs = path.resolve(projectRoot, root.rootPath);
    if (!isInside(rootAbs, cwdAbs)) continue;
    if (path.resolve(rootAbs) === cwdAbs) {
      // cwd exactly at a root counts as inside it
    }
    if (best === null || rootAbs.length > best.length) {
      best = { rootId: root.rootId, length: rootAbs.length };
    }
  }
  return best?.rootId ?? null;
}

function nodeVersionSatisfied(version: string): boolean {
  const [majorRaw, minorRaw] = version.split('.');
  const major = Number.parseInt(majorRaw ?? '0', 10);
  const minor = Number.parseInt(minorRaw ?? '0', 10);
  return major > 22 || (major === 22 && minor >= 16);
}

/**
 * 22.2 onboarding block: environment checks, candidate roots, copy-paste
 * commands, an honest time estimate and the integration-asset commands. The
 * same object is rendered by pretty and lines so information parity holds.
 */
export function buildOnboarding(
  projectRoot: string,
  config: ConfigStatus,
  state: 'uninitialized' | 'ready' = 'uninitialized',
): OnboardingInfo {
  const candidates: OnboardingCandidate[] = (() => {
    try {
      return discoverRoots({ projectRoot }).candidates.map((candidate) => ({
        rootId: candidate.rootId,
        rootPath: candidate.rootPath,
        indexable: candidate.indexable,
      }));
    } catch {
      return [];
    }
  })();
  const rootTsconfig = path.join(projectRoot, 'tsconfig.json');
  const tsconfigFound =
    fs.existsSync(rootTsconfig) ||
    candidates.some((candidate) =>
      fs.existsSync(path.join(projectRoot, candidate.rootPath, 'tsconfig.json')),
    );
  const firstCandidate = candidates[0];
  return {
    state,
    environment: {
      nodeVersion: process.versions.node,
      nodeSatisfied: nodeVersionSatisfied(process.versions.node),
      configKind: config.sourceKind,
      needsTrust: config.needsTrust,
      tsconfig: {
        found: tsconfigFound,
        path: tsconfigFound
          ? fs.existsSync(rootTsconfig)
            ? 'tsconfig.json'
            : `${firstCandidate?.rootPath ?? '.'}/tsconfig.json`
          : null,
      },
      git: fs.existsSync(path.join(projectRoot, '.git')) ? 'available' : 'missing-or-worktree',
      typecheck: 'not-run',
    },
    candidates,
    nextCommands: ['nex init --roots all --write-config --yes', 'nex build', 'nex status'],
    estimateSeconds: {
      min: 5,
      max: 120,
      basis: 'unverified estimate; actual time depends on project size and machine',
    },
    assets: ['nex print mcp-config', 'nex print agents', 'nex print skill'],
  };
}

function emptyStatus(
  projectRoot: string,
  self: SelfInfo,
  config: ConfigStatus,
  warnings: WarningItem[],
): StatusReport {
  return {
    state: 'uninitialized',
    staleness: 'uninitialized',
    activeRoot: null,
    roots: [],
    coverage: { ...EMPTY_COVERAGE },
    counts: { total: 0, returned: 0, certain: 0, heuristic: 0, dynamicUnresolved: 0, partial: 0 },
    capabilities: CAPABILITIES,
    self,
    config,
    guidance: ['nex init --yes', 'nex build', 'nex status'],
    onboarding: buildOnboarding(projectRoot, config),
    warnings,
    projectRoot: relativeDisplay(projectRoot, projectRoot),
  };
}

export interface StatusOptions {
  projectRoot: string;
  cwd?: string;
  trustConfig?: boolean;
  self: SelfInfo;
}

/**
 * `status` never throws and never returns E01 (docs/22-onboarding.md 22.2,
 * docs/16-nfr-and-errors.md 16.3 rule 2). Configuration or DB failures become
 * diagnosable warnings.
 */
export async function statusReport(options: StatusOptions): Promise<StatusReport> {
  const projectRoot = path.resolve(options.projectRoot);
  const warnings: WarningItem[] = [];
  const configStatus: ConfigStatus = {
    sourceKind: 'none',
    path: null,
    authorization: 'none',
    needsTrust: false,
    valid: false,
    warning: null,
  };

  if (!fs.existsSync(path.join(projectRoot, '.nexus'))) {
    return emptyStatus(projectRoot, options.self, configStatus, warnings);
  }

  let loadedConfig: LoadedConfig | null = null;
  try {
    loadedConfig = await loadConfig({ projectRoot, trustConfig: options.trustConfig === true });
    if (loadedConfig.config !== null) {
      configStatus.valid = true;
      configStatus.sourceKind = loadedConfig.sourceKind;
      configStatus.path =
        loadedConfig.sourcePath === null
          ? null
          : relativeDisplay(projectRoot, loadedConfig.sourcePath);
      configStatus.authorization = loadedConfig.authorization;
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'E17';
    const message = error instanceof Error ? error.message : String(error);
    configStatus.needsTrust = code === 'E18';
    configStatus.warning = `${code}: ${message}`;
    warnings.push({ code, message, severity: 'warning' });
  }

  const manifests = listManifestRoots(projectRoot);
  if (manifests.length === 0) {
    const status = emptyStatus(projectRoot, options.self, configStatus, warnings);
    status.guidance = ['nex init --yes', 'nex build', 'nex status'];
    return status;
  }

  const roots: RootStatus[] = [];
  for (const entry of manifests) {
    if (entry.manifest === null) {
      roots.push({
        rootId: entry.rootId,
        rootPath: entry.rootId,
        packageName: null,
        state: 'failed',
        staleness: 'failed',
        files: 0,
        symbols: 0,
        references: 0,
        dependencies: 0,
        calls: 0,
        tests: 0,
        styleEdges: 0,
        crossRootEdges: 0,
        architectureViolations: 0,
        blindSpotCount: 0,
        buildFingerprint: null,
        buildFingerprintPrefix: null,
        surfaceHash: null,
        surfaceEntries: 0,
        degraded: [],
        coverage: { ...EMPTY_COVERAGE },
        vue: null,
        staleReason: [entry.error ?? 'manifest unreadable'],
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCode: null,
        lastIntegrityCheck: null,
        error: entry.error,
      });
      warnings.push({
        code: 'E07',
        message: `root ${entry.rootId}: ${entry.error ?? 'manifest unreadable'}`,
        severity: 'warning',
      });
      continue;
    }
    const manifest = entry.manifest;
    let freshness: { staleness: StalenessState; reasons: string[] };
    try {
      freshness = verifyFreshness({ projectRoot, manifest, loadedConfig });
    } catch (error) {
      freshness = {
        staleness: 'stale',
        reasons: [`freshness-error:${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const dbPath = path.join(rootDirectory(projectRoot, manifest.rootId), 'index.db');
    const dbMissing = !fs.existsSync(dbPath);
    let dbMismatch = false;
    let dbCorrupt = false;
    if (!dbMissing) {
      let db;
      try {
        db = openDatabase(dbPath, { readOnly: true });
        try {
          const committed = latestCommittedBuild(db);
          if (
            committed !== null &&
            (committed.buildId !== manifest.buildId ||
              committed.fingerprint !== manifest.buildFingerprint)
          ) {
            dbMismatch = true;
          }
        } finally {
          db.close();
        }
      } catch {
        dbCorrupt = true;
      }
    }
    if (dbMismatch) {
      freshness = { staleness: 'stale', reasons: [...freshness.reasons, 'db-manifest-mismatch'] };
    }
    if (dbCorrupt) {
      freshness = { staleness: 'failed', reasons: [...freshness.reasons, 'database-unreadable'] };
    }
    const state: RootStatus['state'] =
      freshness.staleness === 'failed' || dbMissing
        ? 'failed'
        : freshness.staleness === 'fresh'
          ? 'ready'
          : 'stale';
    roots.push({
      rootId: manifest.rootId,
      rootPath: manifest.rootPath,
      packageName: manifest.packageName,
      state,
      staleness: dbMissing ? 'failed' : freshness.staleness,
      files: manifest.counts?.files ?? 0,
      symbols: manifest.counts?.symbols ?? 0,
      references: manifest.counts?.references ?? 0,
      dependencies: manifest.graph?.dependencies ?? manifest.counts?.dependencies ?? 0,
      calls: manifest.graph?.calls ?? manifest.counts?.calls ?? 0,
      tests: manifest.graph?.tests ?? manifest.counts?.tests ?? 0,
      styleEdges: manifest.graph?.styleEdges ?? 0,
      crossRootEdges: manifest.graph?.crossRootEdges ?? 0,
      architectureViolations: manifest.graph?.architectureViolations ?? 0,
      blindSpotCount: Array.isArray(manifest.blindSpots) ? manifest.blindSpots.length : 0,
      buildFingerprint: manifest.buildFingerprint || null,
      buildFingerprintPrefix:
        manifest.buildFingerprint === '' ? null : manifest.buildFingerprint.slice(0, 12),
      surfaceHash: manifest.surfaceHash ?? null,
      surfaceEntries: manifest.surfaceEntries ?? 0,
      degraded: Array.isArray(manifest.degraded) ? manifest.degraded : [],
      coverage: {
        ...EMPTY_COVERAGE,
        ...(manifest.coverage ?? {}),
        filteredInternal: manifest.coverage?.filteredInternal ?? 0,
      },
      vue: manifest.vue ?? null,
      staleReason: dbMissing
        ? ['index.db missing']
        : dbCorrupt
          ? [...freshness.reasons, 'database-unreadable']
          : freshness.reasons,
      lastSuccessAt: manifest.lastSuccessAt ?? null,
      lastFailureAt: manifest.lastFailureAt ?? null,
      lastFailureCode: manifest.lastFailureCode ?? null,
      lastIntegrityCheck: manifest.lastIntegrityCheck ?? null,
      error: dbMissing ? 'index.db missing' : dbCorrupt ? 'database unreadable' : null,
    });
  }

  const coverage: Coverage = { ...EMPTY_COVERAGE };
  for (const root of roots) {
    coverage.filesCovered += root.coverage.filesCovered;
    coverage.filesSkipped += root.coverage.filesSkipped;
    coverage.filesIgnored += root.coverage.filesIgnored;
    coverage.filesFailed += root.coverage.filesFailed;
    coverage.resolved += root.coverage.resolved;
    coverage.unresolved += root.coverage.unresolved;
    coverage.unmapped += root.coverage.unmapped;
    coverage.filteredInternal += root.coverage.filteredInternal ?? 0;
    coverage.styleFiles = (coverage.styleFiles ?? 0) + (root.coverage.styleFiles ?? 0);
    coverage.styleEdges = (coverage.styleEdges ?? 0) + (root.coverage.styleEdges ?? 0);
    coverage.styleResolved = (coverage.styleResolved ?? 0) + (root.coverage.styleResolved ?? 0);
    coverage.styleUnresolved =
      (coverage.styleUnresolved ?? 0) + (root.coverage.styleUnresolved ?? 0);
    coverage.dependencies = (coverage.dependencies ?? 0) + (root.coverage.dependencies ?? 0);
    coverage.calls = (coverage.calls ?? 0) + (root.coverage.calls ?? 0);
    coverage.crossRootEdges = (coverage.crossRootEdges ?? 0) + (root.coverage.crossRootEdges ?? 0);
    coverage.architectureViolations =
      (coverage.architectureViolations ?? 0) + (root.coverage.architectureViolations ?? 0);
  }

  const activeRoot = findActiveRoot(
    projectRoot,
    roots.map((root) => ({ rootId: root.rootId, rootPath: root.rootPath })),
    options.cwd ?? process.cwd(),
  );
  const staleness: StatusReport['staleness'] = roots.some((root) => root.staleness === 'failed')
    ? 'failed'
    : roots.some((root) => root.staleness === 'stale')
      ? 'stale'
      : roots.some((root) => root.staleness === 'dirty')
        ? 'dirty'
        : roots.some((root) => root.staleness === 'indexing')
          ? 'indexing'
          : 'fresh';

  const guidance: string[] =
    staleness === 'fresh'
      ? [
          `nex references <symbol> --root ${activeRoot ?? roots[0]?.rootId ?? '<rootId>'}`,
          'nex symbol <name>',
          'nex doctor',
        ]
      : staleness === 'dirty' || staleness === 'indexing'
        ? ['nex update', 'nex status', 'nex doctor']
        : ['nex update', 'nex build', 'nex doctor'];

  return {
    state: 'ready',
    staleness,
    activeRoot,
    roots,
    coverage,
    counts: {
      total: roots.length,
      returned: roots.length,
      certain: 0,
      heuristic: 0,
      dynamicUnresolved: 0,
      partial: staleness === 'fresh' ? 0 : roots.length,
    },
    capabilities: CAPABILITIES,
    self: options.self,
    config: configStatus,
    guidance,
    // 22.2 only needs the onboarding block before the first usable index. A
    // ready project must not pay for a root discovery scan on every query.
    onboarding: null,
    warnings,
    projectRoot: relativeDisplay(projectRoot, projectRoot),
  };
}

export function discoverRootPaths(
  projectRoot: string,
): Array<{ rootId: string; rootPath: string; packageName: string | null }> {
  try {
    const discovery = discoverRoots({ projectRoot });
    return discovery.candidates.map((candidate) => ({
      rootId: candidate.rootId,
      rootPath: candidate.rootPath,
      packageName: candidate.packageName,
    }));
  } catch {
    return [];
  }
}
