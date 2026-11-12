import path from 'node:path';

import type {
  ComponentRecord,
  Counts,
  Coverage,
  DependencyRecord,
  QueryEnvelope,
  ReferenceRecord,
  StalenessState,
  SymbolRecord,
} from '../model.js';
import { nexusError } from '../errors.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { statusReport, type RootStatus, type StatusReport, type WarningItem } from '../status.js';
import { databasePath, manifestPath, readManifest } from '../store/manifest.js';
import {
  findSymbolsByName,
  openReadStore,
  readArchitectureModules,
  readArchitectureViolations,
  readCalls,
  readComponent,
  readDependencies,
  readReferencesTo,
  readSymbolById,
  searchSymbols,
  fileCovered,
  type ReadStore,
} from '../store/read.js';
import { readHistory } from '../store/history.js';
import { readSurface } from '../surface/store.js';
import { buildSurfaceLookup, type SurfaceLookup } from '../surface/service.js';
import type { SurfaceEntry, SurfaceInternalRecord } from '../surface/types.js';

export interface QueryOptions {
  projectRoot: string;
  cwd: string;
  rootId?: string | null;
  roots?: string | 'all' | null;
  trustConfig?: boolean;
}

export interface SymbolItem {
  rootId: string;
  symbolId: string;
  name: string;
  nameChain: string;
  kind: string;
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  nameLine: number;
  nameCol: number;
  signature: string;
  visibility: string;
  exportKind: string;
  isPublic: boolean;
  surface: 'public' | 'internal' | 'opaque' | 'unknown';
  api?: SurfaceEntry;
  internalApi?: SurfaceInternalRecord;
  analysisEngine: string;
  isTypeOnly: boolean;
  identityConfidence: string;
  identityEvidence: string[];
  volatile: boolean;
  anonymous: boolean;
  mappingQuality: string;
  component?: ComponentRecord;
  history?: Array<{
    validFromBuild: string;
    validToBuild: string | null;
    status: string;
    confidence: string;
    evidence: unknown;
  }>;
}

export interface ReferenceItem {
  rootId: string;
  path: string;
  line: number;
  col: number;
  kind: string;
  symbolId: string;
  symbolName: string | null;
  sourceSymbolId: string | null;
  sourceName: string | null;
  reason: string;
  relationClass: string;
  confidence: string;
  role: string;
  analysisEngine: string;
}

export type SearchItem = SymbolItem;

interface PreparedContext {
  status: StatusReport;
  loadedConfig: LoadedConfig | null;
  roots: RootStatus[];
  warnings: WarningItem[];
  budget: { layer: string; maxTokens: number | null; maxFiles: number | null };
}

async function prepareContext(options: QueryOptions): Promise<PreparedContext> {
  let loadedConfig: LoadedConfig | null = null;
  const warnings: WarningItem[] = [];
  try {
    loadedConfig = await loadConfig({
      projectRoot: options.projectRoot,
      trustConfig: options.trustConfig === true,
    });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'E17';
    warnings.push({
      code,
      message: error instanceof Error ? error.message : String(error),
      severity: 'warning',
    });
  }
  const status = await statusReport({
    projectRoot: options.projectRoot,
    cwd: options.cwd,
    trustConfig: options.trustConfig === true,
    self: {
      serverVersion: '',
      packageName: '',
      binaryPath: '',
      projectRoot: '.',
      nodeVersion: process.versions.node,
    },
  });
  warnings.push(...status.warnings);
  const config = loadedConfig?.config;
  return {
    status,
    loadedConfig,
    roots: status.roots,
    warnings,
    budget: {
      layer: 'summary',
      maxTokens: config?.defaults.budgets.maxTokens ?? null,
      maxFiles: config?.defaults.budgets.maxFiles ?? null,
    },
  };
}

function selectRoots(context: PreparedContext, options: QueryOptions): RootStatus[] {
  if (context.status.state === 'uninitialized') {
    throw nexusError('E01', 'index does not exist', {
      reason: 'no completed build was found under .nexus/',
      suggestion: 'Run `nex init --yes` and `nex build`.',
    });
  }
  const explicitAll = options.roots === 'all';
  const explicitList =
    typeof options.roots === 'string' && options.roots !== 'all'
      ? options.roots
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      : null;

  if (explicitAll) {
    const usable = context.roots.filter((root) => root.staleness !== 'failed');
    if (usable.length === 0) {
      throw nexusError('E19', 'no root is queryable', {
        reason: 'all roots are failed',
        suggestion: 'Run `nex doctor` and rebuild.',
      });
    }
    return usable;
  }
  if (explicitList !== null && explicitList.length > 0) {
    const selected: RootStatus[] = [];
    for (const rootId of explicitList) {
      const found = context.roots.find((root) => root.rootId === rootId);
      if (found === undefined) {
        throw nexusError('E16', 'root id not found', {
          reason: `unknown root: ${rootId}`,
          suggestion: 'Use one of the roots listed by `nex status`.',
          evidence: { candidates: context.roots.map((root) => root.rootId) },
        });
      }
      selected.push(found);
    }
    return selected;
  }
  if (options.rootId !== undefined && options.rootId !== null && options.rootId !== '') {
    const found = context.roots.find((root) => root.rootId === options.rootId);
    if (found === undefined) {
      throw nexusError('E16', 'root id not found', {
        reason: `unknown root: ${options.rootId}`,
        suggestion: 'Use one of the roots listed by `nex status`.',
        evidence: { candidates: context.roots.map((root) => root.rootId) },
      });
    }
    return [found];
  }
  if (context.status.activeRoot === null) {
    throw nexusError('E16', 'working directory does not belong to a single root', {
      reason: 'cwd is at the workspace root or outside every indexed root',
      suggestion: 'Pass --root <rootId> or --roots <id,id>.',
      evidence: { candidates: context.roots.map((root) => root.rootId) },
    });
  }
  const active = context.roots.find((root) => root.rootId === context.status.activeRoot);
  if (active === undefined) {
    throw nexusError('E16', 'active root is not indexed', {
      reason: `active root ${context.status.activeRoot} has no index`,
      suggestion: 'Pass --root explicitly or rebuild.',
      evidence: { candidates: context.roots.map((root) => root.rootId) },
    });
  }
  return [active];
}

function worstStaleness(roots: readonly RootStatus[]): StalenessState {
  if (roots.some((root) => root.staleness === 'failed')) return 'failed';
  if (roots.some((root) => root.staleness === 'stale')) return 'stale';
  if (roots.some((root) => root.staleness === 'dirty')) return 'dirty';
  if (roots.some((root) => root.staleness === 'indexing')) return 'indexing';
  return 'fresh';
}

function aggregateCoverage(roots: readonly RootStatus[]): Coverage {
  const coverage: Coverage = {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
  };
  for (const root of roots) {
    coverage.filesCovered += root.coverage.filesCovered;
    coverage.filesSkipped += root.coverage.filesSkipped;
    coverage.filesIgnored += root.coverage.filesIgnored;
    coverage.filesFailed += root.coverage.filesFailed;
    coverage.resolved += root.coverage.resolved;
    coverage.unresolved += root.coverage.unresolved;
    coverage.unmapped += root.coverage.unmapped;
    coverage.filteredInternal += root.coverage.filteredInternal ?? 0;
  }
  return coverage;
}

function loadSurfaceLookup(
  projectRoot: string,
  rootId: string,
  context: PreparedContext,
): SurfaceLookup {
  const read = readSurface(projectRoot, rootId);
  if (read.surface === null || !read.matchesManifest) {
    context.warnings.push({
      code: 'E11',
      message: `root ${rootId}: API Surface is unavailable (${read.error ?? 'surface.json does not match manifest'}); surface is reported as unknown`,
      severity: 'warning',
    });
    return buildSurfaceLookup(null);
  }
  return buildSurfaceLookup(read.surface);
}

function toSymbolItem(
  store: ReadStore,
  rootId: string,
  symbol: SymbolRecord,
  withHistory: boolean,
  surface: SurfaceLookup,
): SymbolItem {
  const publicEntries = [...(surface.entriesBySymbolId.get(symbol.symbolId) ?? [])].sort(
    (left, right) => {
      const rank = {
        'manual-override': 0,
        'package-exports': 1,
        'explicit-entry': 2,
        'barrel-derived': 3,
        none: 4,
      } as const;
      const difference = rank[left.primaryEvidenceSource] - rank[right.primaryEvidenceSource];
      if (difference !== 0) return difference;
      return (left.entryPath ?? '') < (right.entryPath ?? '') ? -1 : 1;
    },
  );
  const publicEntry = publicEntries[0];
  const internal = surface.internalBySymbolId.get(symbol.symbolId);
  const item: SymbolItem = {
    rootId,
    symbolId: symbol.symbolId,
    name: symbol.name,
    nameChain: symbol.nameChain,
    kind: symbol.kind,
    path: symbol.path,
    startLine: symbol.declarationLocator.startLine,
    startCol: symbol.declarationLocator.startCol,
    endLine: symbol.declarationLocator.endLine,
    endCol: symbol.declarationLocator.endCol,
    nameLine: symbol.nameLine,
    nameCol: symbol.nameCol,
    signature: symbol.signature,
    visibility: symbol.visibility,
    exportKind: symbol.exportKind,
    isPublic: symbol.isPublic,
    surface: publicEntry !== undefined ? 'public' : internal !== undefined ? 'internal' : 'unknown',
    analysisEngine: symbol.analysisEngine,
    isTypeOnly: symbol.isTypeOnly,
    identityConfidence: symbol.identityConfidence,
    identityEvidence: symbol.identityEvidence,
    volatile: symbol.volatile,
    anonymous: symbol.anonymous,
    mappingQuality: symbol.mappingQuality,
  };
  if (publicEntry !== undefined) item.api = publicEntry;
  if (internal !== undefined) item.internalApi = internal;
  if (symbol.kind === 'component') {
    const component = readComponent(store, symbol.symbolId);
    if (component !== null) item.component = component;
  }
  if (withHistory) {
    item.history = readHistory(store.db, symbol.symbolId).map((row) => ({
      validFromBuild: row.validFromBuild,
      validToBuild: row.validToBuild,
      status: row.status,
      confidence: row.confidence,
      evidence: row.evidence,
    }));
  }
  return item;
}

function resolveSymbol(store: ReadStore, identifier: string): SymbolRecord {
  if (identifier.startsWith('s_')) {
    const symbol = readSymbolById(store, identifier);
    if (symbol === null) {
      throw nexusError('E05', 'symbol does not exist', {
        reason: `symbolId ${identifier} is not present in this index`,
        suggestion: 'Run `nex search <name>` or rebuild the index.',
        evidence: { covered: true },
      });
    }
    return symbol;
  }
  const matches = findSymbolsByName(store, identifier);
  if (matches.length === 0) {
    throw nexusError('E05', 'symbol does not exist', {
      reason: `no symbol named ${identifier} in the covered files`,
      suggestion: 'Run `nex search <name>` to check spelling, or verify the file is in the index.',
      evidence: { covered: true },
    });
  }
  if (matches.length > 1) {
    throw nexusError('E04', 'symbol name is ambiguous', {
      reason: `${matches.length} symbols match ${identifier}`,
      suggestion: 'Pass a symbolId or a fully qualified nameChain.',
      evidence: {
        candidates: matches.slice(0, 20).map((symbol) => ({
          symbolId: symbol.symbolId,
          nameChain: symbol.nameChain,
          path: symbol.path,
          line: symbol.declarationLocator.startLine,
        })),
      },
    });
  }
  return matches[0] as SymbolRecord;
}

function reasonFor(reference: ReferenceRecord, target: SymbolRecord): string {
  if (reference.role.startsWith('template:')) {
    if (reference.role === 'template:component-use') return 'component-use';
    if (reference.role === 'template:interpolation') return 'interpolation';
    if (reference.role === 'template:dynamic-argument') return 'template-binding';
    return 'template-binding';
  }
  if (reference.relationClass === 'heuristic') return 'heuristic-match';
  if (reference.kind === 'import') return target.isPublic ? 'public-api' : 'same-module';
  if (reference.sourceFile === target.path) return 'same-module';
  return target.isPublic ? 'public-api' : 'same-module';
}

function envelope<T>(input: {
  command: string;
  roots: readonly RootStatus[];
  items: T[];
  coverage: Coverage;
  staleness: StalenessState;
  buildFingerprint: string | null;
  warnings: WarningItem[];
  budget: PreparedContext['budget'];
  notes: string[];
  mode: 'normal' | 'syntax-only' | 'scoped';
}): QueryEnvelope<T> {
  const total = input.items.length;
  const counts: Counts = {
    total,
    returned: total,
    certain: 0,
    heuristic: 0,
    dynamicUnresolved: 0,
    partial: input.staleness === 'fresh' ? 0 : total,
  };
  return {
    command: input.command,
    rootId: input.roots.length === 1 ? (input.roots[0]?.rootId ?? null) : null,
    counts,
    coverage: input.coverage,
    truncated: false,
    nextCursor: null,
    staleness: input.staleness,
    buildFingerprint: input.buildFingerprint,
    identityAmbiguous: false,
    degraded: [...new Set(input.roots.flatMap((root) => root.degraded))].sort(),
    items: input.items,
    warnings: input.warnings,
    budget: input.budget,
    mode: input.mode,
    notes: input.notes,
  };
}

export interface SymbolQueryResult {
  envelope: QueryEnvelope<SymbolItem>;
  symbol: SymbolRecord;
}

export async function querySymbol(
  options: QueryOptions,
  identifier: string,
  withHistory: boolean,
): Promise<SymbolQueryResult> {
  const context = await prepareContext(options);
  const roots = selectRoots(context, options);
  if (roots.length !== 1) {
    throw nexusError('E24', 'multi-root symbol queries are not provided in Phase 01', {
      reason: 'symbol lookup assumes a single root',
      suggestion: 'Pass --root <rootId>.',
    });
  }
  const root = roots[0] as RootStatus;
  const store = openReadStore(databasePath(options.projectRoot, root.rootId));
  if (store === null) {
    throw nexusError('E01', 'index does not exist', {
      reason: 'no committed build in index.db',
      suggestion: 'Run `nex build`.',
      evidence: { rootId: root.rootId },
    });
  }
  try {
    const symbol = resolveSymbol(store, identifier);
    const item = toSymbolItem(
      store,
      root.rootId,
      symbol,
      withHistory,
      loadSurfaceLookup(options.projectRoot, root.rootId, context),
    );
    const result = envelope({
      command: 'symbol',
      roots,
      items: [item],
      coverage: aggregateCoverage(roots),
      staleness: worstStaleness(roots),
      buildFingerprint: root.buildFingerprint,
      warnings: context.warnings,
      budget: context.budget,
      notes: [],
      mode: root.degraded.includes('syntax-only') ? 'syntax-only' : 'normal',
    });
    return { envelope: result, symbol };
  } finally {
    store.db.close();
  }
}

export interface ReferencesQueryResult {
  envelope: QueryEnvelope<ReferenceItem>;
  symbol: SymbolRecord;
}

export async function queryReferences(
  options: QueryOptions,
  identifier: string,
  includeHeuristic: boolean,
  includeTemplate = true,
): Promise<ReferencesQueryResult> {
  const context = await prepareContext(options);
  const roots = selectRoots(context, options);
  if (roots.length !== 1) {
    throw nexusError('E24', 'multi-root reference queries are not provided in Phase 01', {
      reason: 'reference sets are not merged across roots',
      suggestion: 'Pass --root <rootId>.',
    });
  }
  const root = roots[0] as RootStatus;
  const store = openReadStore(databasePath(options.projectRoot, root.rootId));
  if (store === null) {
    throw nexusError('E01', 'index does not exist', {
      reason: 'no committed build in index.db',
      suggestion: 'Run `nex build`.',
      evidence: { rootId: root.rootId },
    });
  }
  try {
    const symbol = resolveSymbol(store, identifier);
    const rows = readReferencesTo(store, symbol.symbolId).filter(
      (row) =>
        (includeHeuristic || row.relationClass !== 'heuristic') &&
        (includeTemplate || !row.role.startsWith('template:')),
    );
    const items: ReferenceItem[] = rows.map((row) => ({
      rootId: root.rootId,
      path: row.sourceFile,
      line: row.line,
      col: row.col,
      kind: row.kind,
      symbolId: symbol.symbolId,
      symbolName: symbol.nameChain,
      sourceSymbolId: row.sourceSymbolId,
      sourceName: row.sourceName,
      reason: reasonFor(row, symbol),
      relationClass: row.relationClass,
      confidence: row.confidence,
      role: row.role,
      analysisEngine: row.analysisEngine,
    }));
    const result = envelope({
      command: 'references',
      roots,
      items,
      coverage: aggregateCoverage(roots),
      staleness: worstStaleness(roots),
      buildFingerprint: root.buildFingerprint,
      warnings: context.warnings,
      budget: context.budget,
      notes: includeTemplate ? [] : ['template edges are not included (--no-template)'],
      mode: root.degraded.includes('syntax-only') ? 'syntax-only' : 'normal',
    });
    result.counts.certain = rows.filter((row) => row.relationClass === 'certain').length;
    result.counts.heuristic = rows.filter((row) => row.relationClass === 'heuristic').length;
    result.counts.dynamicUnresolved = rows.filter(
      (row) => row.relationClass === 'dynamic-unresolved',
    ).length;
    result.identityAmbiguous = symbol.volatile && symbol.identityConfidence !== 'high';
    return { envelope: result, symbol };
  } finally {
    store.db.close();
  }
}

export interface SearchQueryResult {
  envelope: QueryEnvelope<SearchItem>;
  notes: string[];
}

export async function querySearch(
  options: QueryOptions,
  term: string,
  filters: { kind?: string; pathPrefix?: string; publicOnly?: boolean },
): Promise<SearchQueryResult> {
  const context = await prepareContext(options);
  const roots = selectRoots(context, options);
  const items: SearchItem[] = [];
  const notes: string[] = [];
  for (const root of roots) {
    const store = openReadStore(databasePath(options.projectRoot, root.rootId));
    if (store === null) {
      notes.push(`root ${root.rootId}: no committed index`);
      continue;
    }
    try {
      const symbols = searchSymbols(store, {
        name: term,
        kind: filters.kind,
        pathPrefix: filters.pathPrefix,
        publicOnly: filters.publicOnly,
      });
      const lookup = loadSurfaceLookup(options.projectRoot, root.rootId, context);
      for (const symbol of symbols) {
        items.push(toSymbolItem(store, root.rootId, symbol, false, lookup));
      }
      if (symbols.length === 0) {
        notes.push(`root ${root.rootId}: no matches within the covered files`);
      }
    } finally {
      store.db.close();
    }
  }
  items.sort((left, right) => {
    if (left.rootId !== right.rootId) return left.rootId < right.rootId ? -1 : 1;
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.startLine - right.startLine;
  });
  const buildFingerprint = roots.length === 1 ? (roots[0]?.buildFingerprint ?? null) : null;
  if (roots.length > 1)
    notes.push('multiple roots: buildFingerprint is omitted; see status.roots[]');
  return {
    envelope: envelope({
      command: 'search',
      roots,
      items,
      coverage: aggregateCoverage(roots),
      staleness: worstStaleness(roots),
      buildFingerprint,
      warnings: context.warnings,
      budget: context.budget,
      notes,
      mode: 'normal',
    }),
    notes,
  };
}

export function manifestFor(projectRoot: string, rootId: string): ReturnType<typeof readManifest> {
  return readManifest(manifestPath(projectRoot, rootId));
}

export function absoluteRootPath(projectRoot: string, rootPath: string): string {
  return path.resolve(projectRoot, rootPath);
}

export type DependencyQueryType = 'file' | 'module' | 'style' | 'call';

export interface DependencyItem {
  kind: 'dependency' | 'call' | 'module-edge' | 'violation';
  rootId: string;
  sourceFile: string;
  targetFile: string | null;
  sourceModule: string | null;
  targetModule: string | null;
  depType: string;
  specifier: string | null;
  line: number;
  col: number;
  relationClass: string;
  confidence: string;
  analysisEngine: string;
  unresolvedReason: string | null;
  isCrossRoot?: boolean;
  evidence: unknown;
  callerSymbolId?: string | null;
  calleeSymbolId?: string | null;
  callerName?: string | null;
  calleeName?: string | null;
  edgeCount?: number;
  edgeCounts?: { certain: number; heuristic: number; dynamicUnresolved: number };
  ruleId?: string;
}

export interface DependencyQueryResult {
  envelope: QueryEnvelope<DependencyItem>;
  type: DependencyQueryType;
  target: string;
  reverse: boolean;
  data: {
    modules: Array<{
      name: string;
      allow: string[] | null;
      fileCount: number;
      symbolCount: number;
    }>;
    violations: unknown[];
    blindSpots: unknown[];
    crossRootEdges: unknown[];
  };
}

function normalizeTargetPath(projectRoot: string, target: string): string {
  const absolute = path.resolve(projectRoot, target);
  const relative = path.relative(projectRoot, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function dependencyItem(rootId: string, dependency: DependencyRecord): DependencyItem {
  return {
    kind: 'dependency',
    rootId,
    sourceFile: dependency.sourceFile,
    targetFile: dependency.targetFile,
    sourceModule: dependency.sourceModule ?? null,
    targetModule: dependency.targetModule ?? null,
    depType: dependency.depType,
    specifier: dependency.specifier,
    line: dependency.line,
    col: dependency.col,
    relationClass: dependency.relationClass,
    confidence: dependency.confidence,
    analysisEngine: dependency.analysisEngine,
    unresolvedReason: dependency.unresolvedReason,
    isCrossRoot: dependency.isCrossRoot,
    evidence: dependency.evidence,
  };
}

export async function queryDependencies(
  options: QueryOptions,
  target: string,
  type: DependencyQueryType,
  reverse: boolean,
): Promise<DependencyQueryResult> {
  if (!['file', 'module', 'style', 'call'].includes(type)) {
    throw nexusError('E00', 'invalid deps type', {
      reason: `expected file, module, style or call, received ${JSON.stringify(type)}`,
      suggestion: 'Use --type file|module|style|call.',
    });
  }
  if (target.trim() === '') {
    throw nexusError('E00', 'deps requires a target', {
      reason: 'no file, module, style file or symbol was provided',
      suggestion: 'Run `nex deps <file>` or `nex deps --type module <name>`.',
    });
  }
  const context = await prepareContext(options);
  const roots = selectRoots(context, options);
  if (roots.length !== 1) {
    throw nexusError('E24', 'multi-root deps queries are not provided in Phase 04', {
      reason:
        'dependency graphs are per root; cross-root edges are returned with their source root',
      suggestion: 'Pass --root <rootId>.',
    });
  }
  const root = roots[0] as RootStatus;
  const store = openReadStore(databasePath(options.projectRoot, root.rootId));
  if (store === null) {
    throw nexusError('E01', 'index does not exist', {
      reason: 'no committed build in index.db',
      suggestion: 'Run `nex build`.',
    });
  }
  try {
    const notes: string[] = [];
    const modules = readArchitectureModules(store).map((module) => ({
      name: module.name,
      allow: module.allow,
      fileCount: module.fileCount,
      symbolCount: module.symbolCount,
    }));
    const violations = readArchitectureViolations(store);
    const manifest = manifestFor(options.projectRoot, root.rootId).manifest;
    const blindSpots = Array.isArray(manifest?.blindSpots) ? manifest.blindSpots : [];
    const items: DependencyItem[] = [];

    if (type === 'call') {
      const symbol = resolveSymbol(store, target);
      const calls = readCalls(
        store,
        reverse ? { calleeSymbolId: symbol.symbolId } : { callerSymbolId: symbol.symbolId },
      );
      for (const call of calls) {
        const callerName =
          call.callerSymbolId === null
            ? null
            : (readSymbolById(store, call.callerSymbolId)?.nameChain ?? null);
        const calleeName =
          call.calleeSymbolId === null
            ? null
            : (readSymbolById(store, call.calleeSymbolId)?.nameChain ?? null);
        items.push({
          kind: 'call',
          rootId: root.rootId,
          sourceFile: call.callerFile,
          targetFile: call.calleeFile,
          sourceModule: null,
          targetModule: null,
          depType: 'call',
          specifier: null,
          line: call.line,
          col: call.col,
          relationClass: call.relationClass,
          confidence: call.confidence,
          analysisEngine: call.analysisEngine,
          unresolvedReason: call.unresolvedReason,
          evidence: call.evidence,
          callerSymbolId: call.callerSymbolId,
          calleeSymbolId: call.calleeSymbolId,
          callerName,
          calleeName,
        });
      }
      notes.push('call edges are static TS/TSX calls; Vue script calls are not claimed');
    } else if (type === 'module') {
      if (modules.length === 0) {
        throw nexusError('E00', 'architecture modules are not configured', {
          reason: 'deps --type module needs explicit architecture.modules[].include patterns',
          suggestion: 'Add architecture.modules to .nexus/nexus.config.json and rebuild.',
        });
      }
      if (!modules.some((module) => module.name === target)) {
        throw nexusError('E05', 'architecture module does not exist', {
          reason: `no module named ${target}`,
          suggestion: 'Use one of the configured module names.',
          evidence: { modules: modules.map((module) => module.name) },
        });
      }
      const all = readDependencies(store, { limit: 20000 });
      const byEdge = new Map<string, DependencyItem>();
      for (const dependency of all) {
        if (dependency.sourceModule == null || dependency.targetModule == null) continue;
        if (reverse ? dependency.targetModule !== target : dependency.sourceModule !== target)
          continue;
        const key = `${dependency.sourceModule}\\u0000${dependency.targetModule}\\u0000${dependency.depType}`;
        const existing = byEdge.get(key);
        if (existing === undefined) {
          byEdge.set(key, {
            ...dependencyItem(root.rootId, dependency),
            kind: 'module-edge',
            sourceFile: dependency.sourceModule,
            targetFile: dependency.targetModule,
            edgeCount: 1,
            edgeCounts: {
              certain: dependency.relationClass === 'certain' ? 1 : 0,
              heuristic: dependency.relationClass === 'heuristic' ? 1 : 0,
              dynamicUnresolved: dependency.relationClass === 'dynamic-unresolved' ? 1 : 0,
            },
          });
        } else {
          existing.edgeCount = (existing.edgeCount ?? 0) + 1;
          const counts = existing.edgeCounts as DependencyItem['edgeCounts'];
          if (counts !== undefined) {
            if (dependency.relationClass === 'certain') counts.certain += 1;
            else if (dependency.relationClass === 'heuristic') counts.heuristic += 1;
            else counts.dynamicUnresolved += 1;
          }
        }
      }
      items.push(...byEdge.values());
      for (const violation of violations) {
        if (reverse ? violation.toModule !== target : violation.fromModule !== target) continue;
        items.push({
          kind: 'violation',
          rootId: root.rootId,
          sourceFile: violation.sourceFile,
          targetFile: violation.targetFile,
          sourceModule: violation.fromModule,
          targetModule: violation.toModule,
          depType: violation.depType,
          specifier: null,
          line: violation.line,
          col: violation.col,
          relationClass: violation.relationClass,
          confidence: violation.confidence,
          analysisEngine: violation.analysisEngine,
          unresolvedReason: null,
          evidence: violation.evidence,
          ruleId: violation.ruleId,
        });
      }
      notes.push('module edges aggregate file-level dependencies; counts are edge counts');
    } else {
      const normalized = normalizeTargetPath(options.projectRoot, target);
      const all = readDependencies(store, { limit: 20000 });
      const styleOnly = type === 'style';
      for (const dependency of all) {
        if (styleOnly && !dependency.depType.startsWith('style-')) continue;
        const sourceMatches =
          dependency.sourceFile === normalized ||
          dependency.sourceFile.startsWith(`${normalized}/`);
        const targetMatches =
          dependency.targetFile === normalized ||
          (dependency.targetFile ?? '').startsWith(`${normalized}/`);
        if (reverse ? !targetMatches : !sourceMatches) continue;
        items.push(dependencyItem(root.rootId, dependency));
      }
      if (items.some((item) => item.isCrossRoot === true)) {
        notes.push(
          'crossRootEdges are listed with the source root; the target root is not expanded',
        );
      }
      if (items.length === 0) {
        if (styleOnly) {
          notes.push(
            `no style dependency matched ${normalized}; check alias-unresolved, ignored and not-covered`,
          );
        } else if (!fileCovered(store, normalized)) {
          notes.push(`not-covered: ${normalized} is not in this index`);
        } else {
          notes.push(`not-found: no dependency edge matched ${normalized}`);
        }
      }
    }

    items.sort((left, right) => {
      if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
      if (left.line !== right.line) return left.line - right.line;
      if (left.col !== right.col) return left.col - right.col;
      return left.depType < right.depType ? -1 : 1;
    });
    const result = envelope({
      command: 'deps',
      roots,
      items,
      coverage: aggregateCoverage(roots),
      staleness: worstStaleness(roots),
      buildFingerprint: root.buildFingerprint,
      warnings: context.warnings,
      budget: context.budget,
      notes,
      mode: root.degraded.includes('syntax-only') ? 'syntax-only' : 'normal',
    });
    if (type === 'module') {
      for (const item of items) {
        result.counts.certain +=
          item.edgeCounts?.certain ?? (item.relationClass === 'certain' ? 1 : 0);
        result.counts.heuristic +=
          item.edgeCounts?.heuristic ?? (item.relationClass === 'heuristic' ? 1 : 0);
        result.counts.dynamicUnresolved +=
          item.edgeCounts?.dynamicUnresolved ??
          (item.relationClass === 'dynamic-unresolved' ? 1 : 0);
      }
    } else {
      result.counts.certain = items.filter((item) => item.relationClass === 'certain').length;
      result.counts.heuristic = items.filter((item) => item.relationClass === 'heuristic').length;
      result.counts.dynamicUnresolved = items.filter(
        (item) => item.relationClass === 'dynamic-unresolved',
      ).length;
    }
    const crossRootEdges = items.filter(
      (item) => item.kind === 'dependency' && item.isCrossRoot === true,
    );
    return {
      envelope: result,
      type,
      target,
      reverse,
      data: {
        modules,
        violations,
        blindSpots,
        crossRootEdges,
      },
    };
  } finally {
    store.db.close();
  }
}
