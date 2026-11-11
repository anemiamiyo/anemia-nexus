import path from 'node:path';

import type {
  Counts,
  Coverage,
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
  readReferencesTo,
  readSymbolById,
  searchSymbols,
  type ReadStore,
} from '../store/read.js';
import { readHistory } from '../store/history.js';

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
  surface: 'unknown';
  analysisEngine: string;
  isTypeOnly: boolean;
  identityConfidence: string;
  identityEvidence: string[];
  volatile: boolean;
  anonymous: boolean;
  mappingQuality: string;
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
  };
  for (const root of roots) {
    coverage.filesCovered += root.coverage.filesCovered;
    coverage.filesSkipped += root.coverage.filesSkipped;
    coverage.filesIgnored += root.coverage.filesIgnored;
    coverage.filesFailed += root.coverage.filesFailed;
    coverage.resolved += root.coverage.resolved;
    coverage.unresolved += root.coverage.unresolved;
    coverage.unmapped += root.coverage.unmapped;
  }
  return coverage;
}

function toSymbolItem(
  store: ReadStore,
  rootId: string,
  symbol: SymbolRecord,
  withHistory: boolean,
): SymbolItem {
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
    surface: 'unknown',
    analysisEngine: symbol.analysisEngine,
    isTypeOnly: symbol.isTypeOnly,
    identityConfidence: symbol.identityConfidence,
    identityEvidence: symbol.identityEvidence,
    volatile: symbol.volatile,
    anonymous: symbol.anonymous,
    mappingQuality: symbol.mappingQuality,
  };
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
    const item = toSymbolItem(store, root.rootId, symbol, withHistory);
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
      (row) => includeHeuristic || row.relationClass !== 'heuristic',
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
      notes: [],
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
      for (const symbol of symbols) items.push(toSymbolItem(store, root.rootId, symbol, false));
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
