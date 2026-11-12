import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { LoadedConfig } from '../config/load.js';
import type { NexusConfig } from '../config/schema.js';
import { nexusError } from '../errors.js';
import { sha256Base32 } from '../util/hash.js';
import { relativePosix } from '../util/paths.js';
import { stableStringify } from '../util/stable-json.js';
import { readManifest, rootDirectory, type RootManifest } from '../store/manifest.js';
import { diffSnapshots } from './diff.js';
import { baselinePath, readBaseline, readSurfaceForManifest, writeBaseline } from './store.js';
import type {
  DeprecatedChain,
  SurfaceBaseline,
  SurfaceDiff,
  SurfaceEntry,
  SurfaceInternalRecord,
  SurfaceOpaqueRecord,
  SurfaceRootSnapshot,
  SurfaceSnapshot,
} from './types.js';

export interface SurfaceLookup {
  entriesBySymbolId: ReadonlyMap<string, SurfaceEntry[]>;
  internalBySymbolId: ReadonlyMap<string, SurfaceInternalRecord>;
}

export function buildSurfaceLookup(surface: SurfaceRootSnapshot | null): SurfaceLookup {
  const entries = new Map<string, SurfaceEntry[]>();
  const internal = new Map<string, SurfaceInternalRecord>();
  if (surface !== null) {
    for (const entry of surface.entries) {
      const list = entries.get(entry.symbolId) ?? [];
      list.push(entry);
      entries.set(entry.symbolId, list);
    }
    for (const record of surface.internal) internal.set(record.symbolId, record);
  }
  return { entriesBySymbolId: entries, internalBySymbolId: internal };
}

function listRootIds(projectRoot: string): string[] {
  const directory = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(directory)) return [];
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function configValue(loaded: LoadedConfig | null): NexusConfig | null {
  return loaded?.config ?? null;
}

export interface SnapshotOptions {
  projectRoot: string;
  loadedConfig: LoadedConfig | null;
  rootId?: string | null;
}

export interface SnapshotResult {
  snapshot: SurfaceSnapshot;
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
}

export function createSurfaceSnapshot(options: SnapshotOptions): SnapshotResult {
  const projectRoot = path.resolve(options.projectRoot);
  const rootIds =
    options.rootId === undefined || options.rootId === null
      ? listRootIds(projectRoot)
      : [options.rootId];
  if (rootIds.length === 0) {
    throw nexusError('E01', 'no indexed root found for API Surface', {
      reason: 'no manifest under .nexus/roots',
      suggestion: 'Run `nex build` before `nex api-snapshot` or `nex api-diff`.',
      evidence: { projectRoot: '.' },
    });
  }
  const roots: Record<string, SurfaceRootSnapshot> = {};
  const warnings: SnapshotResult['warnings'] = [];
  for (const rootId of rootIds) {
    const manifest = readManifest(
      path.join(rootDirectory(projectRoot, rootId), 'manifest.json'),
    ).manifest;
    if (manifest === null) {
      if (options.rootId !== undefined && options.rootId !== null) {
        throw nexusError('E01', 'index does not exist for the requested root', {
          reason: `manifest.json is missing for root ${rootId}`,
          suggestion: 'Run `nex build` first.',
          evidence: { rootId },
        });
      }
      warnings.push({
        code: 'E01',
        message: `root ${rootId}: manifest.json is missing; skipped`,
        severity: 'warning',
      });
      continue;
    }
    const read = readSurfaceForManifest(projectRoot, manifest);
    if (read.surface === null) {
      throw nexusError('E19', 'API Surface is not available for the current build', {
        reason: read.error ?? 'surface.json is missing or stale',
        suggestion: 'Run `nex build` to regenerate surface.json, then retry.',
        evidence: { rootId, buildId: manifest.buildId },
      });
    }
    roots[rootId] = read.surface;
    if (read.surface.warnings.length > 0) {
      for (const warning of read.surface.warnings) {
        warnings.push({ code: 'E11', message: `root ${rootId}: ${warning}`, severity: 'warning' });
      }
    }
  }
  const surfaceHash = aggregateSurfaceHash(roots);
  return {
    snapshot: {
      surfaceVersion: 1,
      surfaceHash,
      roots,
      warnings: [...new Set(warnings.map((warning) => warning.message))].sort(),
    },
    warnings,
  };
}

function aggregateSurfaceHash(roots: Record<string, SurfaceRootSnapshot>): string {
  const canonical = Object.keys(roots)
    .sort()
    .map((rootId) => ({ rootId, surfaceHash: roots[rootId]?.surfaceHash ?? '' }));
  return `sh_${sha256Base32(stableStringify(canonical), 16)}`;
}

function baselineFileFor(
  projectRoot: string,
  loaded: LoadedConfig | null,
  rootId?: string | null,
): string {
  const config = configValue(loaded);
  const relative = config?.surface.baselinePath ?? 'nexus.baseline.json';
  void rootId;
  return baselinePath(projectRoot, relative);
}

export interface SnapshotWriteResult {
  baseline: SurfaceBaseline;
  path: string;
  overwritten: boolean;
  surfaceHash: string;
}

export function writeBaselineSnapshot(
  options: SnapshotOptions & { yes: boolean },
): SnapshotWriteResult {
  const projectRoot = path.resolve(options.projectRoot);
  const filePath = baselineFileFor(projectRoot, options.loadedConfig, options.rootId);
  const existed = fs.existsSync(filePath);
  if (existed && !options.yes) {
    throw nexusError('E00', 'refusing to overwrite the existing API baseline', {
      reason: `baseline already exists at ${path
        .relative(projectRoot, filePath)
        .replaceAll('\\', '/')}`,
      suggestion: 'Re-run `nex api-snapshot --yes` to overwrite it explicitly.',
      evidence: { path: path.relative(projectRoot, filePath).replaceAll('\\', '/') },
    });
  }
  const previous = existed ? readBaseline(filePath) : { baseline: null, error: null };
  const snapshot = createSurfaceSnapshot(options).snapshot;
  const roots: SurfaceBaseline['roots'] = {};
  for (const rootId of Object.keys(snapshot.roots).sort()) {
    const root = snapshot.roots[rootId] as SurfaceRootSnapshot;
    roots[rootId] = {
      rootPath: root.rootPath,
      packageName: root.packageName,
      buildFingerprint: root.buildFingerprint,
      surfaceHash: root.surfaceHash,
      entries: preserveSince(root.entries, previous.baseline?.roots[rootId]?.entries ?? []),
      internal: root.internal,
      opaque: root.opaque,
      deprecated: root.deprecated,
    };
  }
  const baseline: SurfaceBaseline = {
    baselineVersion: 1,
    surfaceHash: snapshot.surfaceHash,
    roots,
  };
  writeBaseline(filePath, baseline);
  return {
    baseline,
    path: path.relative(projectRoot, filePath).replaceAll('\\', '/'),
    overwritten: existed,
    surfaceHash: snapshot.surfaceHash,
  };
}

function preserveSince(
  entries: readonly SurfaceEntry[],
  previous: readonly SurfaceEntry[],
): SurfaceEntry[] {
  const byKey = new Map(
    previous.map((entry) => [
      `${entry.name}\u0000${entry.entryPath ?? ''}\u0000${entry.condition ?? ''}`,
      entry,
    ]),
  );
  return entries.map((entry) => {
    const prior = byKey.get(
      `${entry.name}\u0000${entry.entryPath ?? ''}\u0000${entry.condition ?? ''}`,
    );
    if (prior === undefined || prior.since === 'unknown') return entry;
    return { ...entry, since: prior.since };
  });
}

function isGitRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(value) && !value.includes('..');
}

export interface DiffOptions extends SnapshotOptions {
  base?: string | null;
}

export interface DiffResult {
  diff: SurfaceDiff;
  baseline: SurfaceBaseline;
  baseLabel: string;
}

export function diffCurrentSurface(options: DiffOptions): DiffResult {
  const projectRoot = path.resolve(options.projectRoot);
  const current = createSurfaceSnapshot(options);
  const configured =
    configValue(options.loadedConfig)?.surface.baselinePath ?? 'nexus.baseline.json';
  const base = options.base ?? configured;
  const absolute = path.resolve(projectRoot, base);
  const configuredAbsolute = path.resolve(projectRoot, configured);
  let baseline: SurfaceBaseline;
  let baseLabel: string;
  if (options.base === undefined || options.base === null) {
    if (!fs.existsSync(configuredAbsolute)) {
      throw nexusError('E01', 'API baseline not found', {
        reason: `no baseline file at ${relativePosix(projectRoot, configuredAbsolute)}`,
        suggestion: 'Run `nex api-snapshot --yes` first, or pass --base <ref|file>.',
        evidence: { path: relativePosix(projectRoot, configuredAbsolute) },
      });
    }
  }
  if (fs.existsSync(absolute)) {
    const read = readBaseline(absolute);
    if (read.baseline === null) {
      throw nexusError('E19', 'API baseline is not readable', {
        reason: read.error ?? 'invalid baseline',
        suggestion: 'Regenerate it with `nex api-snapshot --yes` or pass another --base.',
        evidence: { base },
      });
    }
    baseline = read.baseline;
    baseLabel = path.relative(projectRoot, absolute).replaceAll('\\', '/');
  } else if (isGitRef(base)) {
    const relation = path.relative(projectRoot, configuredAbsolute).replaceAll('\\', '/');
    let gitPrefix: string;
    try {
      gitPrefix = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
        encoding: 'utf8',
        timeout: 15_000,
      }).trim();
    } catch {
      gitPrefix = '';
    }
    const gitPath = `${gitPrefix}${relation}`;
    let raw: string;
    try {
      raw = execFileSync('git', ['-C', projectRoot, 'show', `${base}:${gitPath}`], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      throw nexusError('E01', 'API baseline is not available at the requested base', {
        reason: `git show ${base}:${gitPath} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        suggestion: 'Pass an existing file with --base, or commit `nexus.baseline.json` first.',
        evidence: { base, path: gitPath },
      });
    }
    try {
      baseline = JSON.parse(raw) as SurfaceBaseline;
    } catch {
      throw nexusError('E19', 'API baseline at the requested ref is not valid JSON', {
        reason: `git show ${base}:${gitPath} did not parse`,
        suggestion: 'Check the committed baseline or regenerate it.',
        evidence: { base, path: gitPath },
      });
    }
    if (baseline.baselineVersion !== 1 || typeof baseline.roots !== 'object') {
      throw nexusError('E19', 'API baseline at the requested ref has an unsupported shape', {
        reason: 'missing baselineVersion or roots',
        suggestion: 'Regenerate the baseline with the current version.',
        evidence: { base },
      });
    }
    baseLabel = `${base}:${gitPath}`;
  } else {
    throw nexusError('E01', 'API baseline not found', {
      reason: `no file at ${absolute} and --base is not a git ref`,
      suggestion: 'Run `nex api-snapshot --yes` first, or pass --base <ref|file>.',
      evidence: { base },
    });
  }

  const diff = diffSnapshots(current.snapshot, baseline);
  diff.base = baseLabel;
  diff.warnings = [...current.warnings, ...diff.warnings];
  diff.notes = [
    'api-diff only compares public Surface entries plus the exported internal layer.',
    'Symbols outside the indexed root are not part of the comparison.',
  ];
  return { diff, baseline, baseLabel };
}

export interface BaselineSummary {
  entries: number;
  internal: number;
  opaque: number;
  deprecated: number;
  roots: number;
}

export function summarizeBaseline(baseline: SurfaceBaseline): BaselineSummary {
  let entries = 0;
  let internal = 0;
  let opaque = 0;
  let deprecated = 0;
  for (const root of Object.values(baseline.roots)) {
    entries += root.entries.length;
    internal += root.internal.length;
    opaque += root.opaque.length;
    deprecated += root.deprecated.length;
  }
  return { entries, internal, opaque, deprecated, roots: Object.keys(baseline.roots).length };
}

export function deprecationsForRoot(
  entries: readonly SurfaceEntry[],
  deprecated: readonly DeprecatedChain[],
): Map<string, DeprecatedChain[]> {
  const result = new Map<string, DeprecatedChain[]>();
  void entries;
  for (const chain of deprecated) {
    const list = result.get(chain.symbolId) ?? [];
    list.push(chain);
    result.set(chain.symbolId, list);
  }
  return result;
}

export type { SurfaceBaseline, SurfaceDiff, SurfaceRootSnapshot, SurfaceSnapshot };
export type { SurfaceEntry, SurfaceInternalRecord, SurfaceOpaqueRecord, RootManifest };
