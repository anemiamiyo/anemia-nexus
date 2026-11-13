import fs from 'node:fs';
import path from 'node:path';

import type {
  BlindSpot,
  Coverage,
  Counts,
  ReferenceRecord,
  SymbolRecord,
  TestRecord,
} from '../model.js';
import type { RootStatus } from '../status.js';
import type { LoadedConfig } from '../config/load.js';
import type { SurfaceDiff, SurfaceEntry } from '../surface/types.js';
import { nexusError } from '../errors.js';
import { prepareContext, selectScope, type QueryOptions } from '../query/service.js';
import { databasePath, manifestPath, readManifest } from '../store/manifest.js';
import {
  fileCovered,
  findSymbolsByName,
  openReadStore,
  readArchitectureViolations,
  readCalls,
  readDependencies,
  readReferencesTo,
  readSymbolById,
  readSymbolsForFile,
  readTestsForFile,
  readTestsForSymbol,
  type ReadStore,
} from '../store/read.js';
import { readSurface } from '../surface/store.js';
import { buildSurfaceLookup, diffCurrentSurface } from '../surface/service.js';
import { findRelatedDocs, type DocMatch } from './docs.js';

export type ImpactTargetKind = 'file' | 'symbol' | 'style';

export interface ImpactOptions extends QueryOptions {
  target: string;
  symbol?: string | null;
  depth?: number;
  includeTemplate?: boolean;
  base?: string | null;
}

export interface ImpactTarget {
  kind: ImpactTargetKind;
  rootId: string;
  filePath: string | null;
  symbolId: string | null;
  name: string | null;
  nameChain: string | null;
  line: number;
  col: number;
}

export interface ImpactItem {
  rootId: string;
  kind: 'file' | 'symbol';
  path: string;
  line: number;
  col: number;
  symbolId: string | null;
  name: string | null;
  kindOfSymbol: string | null;
  depth: number;
  relationClass: string;
  confidence: string;
  reason: string;
  analysisEngine: string;
  evidence?: unknown;
}

export interface ImpactRiskReason {
  rule: string;
  detail: string;
  file?: string;
  line?: number;
  relationClass?: string;
  confidence?: string;
}

export interface ImpactRisk {
  level: 'Low' | 'Medium' | 'High' | 'Critical';
  reasons: ImpactRiskReason[];
}

export interface StyleDependent {
  rootId: string;
  sourceFile: string;
  line: number;
  depType: string;
  confidence: string;
  relationClass: string;
  analysisEngine: string;
}

export interface RootImpactReport {
  rootId: string;
  rootPath: string;
  target: ImpactTarget;
  direct: { count: number; items: ImpactItem[] };
  indirect: {
    depth: number;
    count: number;
    items: ImpactItem[];
    truncated: boolean;
    nextCursor: string | null;
  };
  surface: {
    affected: SurfaceEntry[];
    diffLevel: 'breaking' | 'additive' | 'internal' | 'ambiguous' | 'none' | 'not-available';
    basis: 'current-vs-baseline' | 'not-available';
    diff: SurfaceDiff | null;
  };
  components: {
    affected: Array<{ rootId: string; symbolId: string; name: string; path: string; line: number }>;
  };
  types: {
    affected: Array<{ rootId: string; symbolId: string; name: string; path: string; line: number }>;
  };
  tests: {
    related: TestRecord[];
    suggestedCommands: string[];
  };
  docs: { related: DocMatch[]; searchedFiles: number; truncated: boolean; note: string };
  architecture: { violations: unknown[]; modules: string[] };
  blindSpots: BlindSpot[];
  styleDependents: StyleDependent[];
  counts: Counts;
  impactFanout: number;
  risk: ImpactRisk;
  staleness: string;
  buildFingerprint: string | null;
  coverage: Coverage;
  notes: string[];
}

export interface ImpactResult {
  scope: 'root' | 'roots' | 'all';
  reports: RootImpactReport[];
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  notes: string[];
  staleRoots: string[];
  failedRoots: string[];
  completeness: 'complete' | 'partial';
  degraded: string[];
  budget: { layer: string; maxTokens: number | null; maxFiles: number | null };
}

const MAX_ITEMS = 2000;
const MAX_DEPTH = 10;
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less']);

function normalizeTargetPath(projectRoot: string, target: string): string {
  const absolute = path.resolve(projectRoot, target);
  const relative = path.relative(projectRoot, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replaceAll('\\', '/');
  }
  return target.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isStylePath(filePath: string): boolean {
  return STYLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveSymbol(store: ReadStore, identifier: string): SymbolRecord {
  if (identifier.startsWith('s_')) {
    const symbol = readSymbolById(store, identifier);
    if (symbol === null) {
      throw nexusError('E05', 'symbol does not exist', {
        reason: `symbolId ${identifier} is not present in this index`,
        suggestion: 'Run `nex search <name>` or rebuild the index.',
      });
    }
    return symbol;
  }
  const matches = findSymbolsByName(store, identifier);
  if (matches.length === 0) {
    throw nexusError('E05', 'symbol does not exist', {
      reason: `no symbol named ${identifier} in the covered files`,
      suggestion: 'Run `nex search <name>` to check spelling.',
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

function symbolTarget(rootId: string, symbol: SymbolRecord): ImpactTarget {
  return {
    kind: 'symbol',
    rootId,
    filePath: symbol.path,
    symbolId: symbol.symbolId,
    name: symbol.name,
    nameChain: symbol.nameChain,
    line: symbol.declarationLocator.startLine,
    col: symbol.declarationLocator.startCol,
  };
}

function fileTarget(rootId: string, filePath: string, kind: ImpactTargetKind): ImpactTarget {
  return {
    kind,
    rootId,
    filePath,
    symbolId: null,
    name: path.posix.basename(filePath),
    nameChain: null,
    line: 1,
    col: 0,
  };
}

function resolveTarget(
  store: ReadStore,
  projectRoot: string,
  rootId: string,
  options: ImpactOptions,
  strict: boolean,
): ImpactTarget | null {
  if (options.symbol !== undefined && options.symbol !== null && options.symbol !== '') {
    try {
      return symbolTarget(rootId, resolveSymbol(store, options.symbol));
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }
  const raw = options.target;
  if (raw.trim() === '') {
    throw nexusError('E00', 'impact requires a target', {
      reason: 'no file, symbol or style file was provided',
      suggestion: 'Run `nex impact <file>` or `nex impact --symbol <name>`.',
    });
  }
  const normalized = normalizeTargetPath(projectRoot, raw);
  if (isStylePath(normalized)) return fileTarget(rootId, normalized, 'style');
  const pathLike =
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.startsWith('.') ||
    /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(raw);
  if (pathLike || fileCovered(store, normalized)) {
    return fileTarget(rootId, normalized, 'file');
  }
  try {
    return symbolTarget(rootId, resolveSymbol(store, raw));
  } catch (error) {
    if (error instanceof Error && 'code' in error && String(error.code) === 'E04') throw error;
    if (strict) {
      throw nexusError('E05', 'impact target does not exist', {
        reason: `${raw} is neither a covered file nor a symbol in this root`,
        suggestion: 'Pass a project-relative file path or a symbol name; use `nex search` first.',
        evidence: { rootId, covered: false },
      });
    }
    return null;
  }
}

function toCoverage(root: RootStatus): Coverage {
  return { ...root.coverage, filteredInternal: root.coverage.filteredInternal ?? 0 };
}

function relationCounts(
  items: readonly ImpactItem[],
): Pick<Counts, 'certain' | 'heuristic' | 'dynamicUnresolved'> {
  return {
    certain: items.filter((item) => item.relationClass === 'certain').length,
    heuristic: items.filter((item) => item.relationClass === 'heuristic').length,
    dynamicUnresolved: items.filter((item) => item.relationClass === 'dynamic-unresolved').length,
  };
}

function commandSuggestions(loadedConfig: LoadedConfig | null, projectRoot: string): string[] {
  const suggestions: string[] = [];
  const allow = loadedConfig?.config?.commands.allow ?? [];
  for (const command of allow) {
    if (/(^|[-_])test($|[-_])|test/i.test(command.id)) {
      suggestions.push(`nex verify --only ${command.id}`);
    }
  }
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as unknown;
    if (typeof raw === 'object' && raw !== null) {
      const scripts = (raw as Record<string, unknown>).scripts;
      if (typeof scripts === 'object' && scripts !== null && 'test' in scripts) {
        suggestions.push('npm test');
      }
    }
  } catch {
    // package.json is optional; no suggestion is better than a fabricated one.
  }
  return [...new Set(suggestions)];
}

function targetedBlindSpots(input: {
  target: ImpactTarget;
  covered: boolean;
  unresolvedConsumers: number;
  tests: readonly TestRecord[];
  affectedFiles: number;
  affectedSymbols: number;
}): BlindSpot[] {
  const output: BlindSpot[] = [];
  if (!input.covered) {
    output.push({
      category: 'coverage',
      missReason: 'target-not-covered',
      affectedFiles: 1,
      potentiallyAffectedSymbols: null,
      estimateMethod: 'target file is not in the index; the consumer set cannot be bounded',
      manualCheckHint: `nex deps ${input.target.filePath ?? input.target.name ?? ''} --explain`,
      sample: input.target.filePath === null ? [] : [input.target.filePath],
      sourceQuery: 'nex deps <target> --explain',
    });
  }
  if (input.unresolvedConsumers > 0) {
    output.push({
      category: 'code',
      missReason: 'unresolved-consumer',
      affectedFiles: input.affectedFiles,
      potentiallyAffectedSymbols: input.affectedSymbols,
      estimateMethod:
        'unique symbols reached through certain/heuristic edges; dynamic-unresolved consumers cannot be enumerated',
      manualCheckHint: 'nex references <symbol> --include-heuristic  # inspect ! rows',
      sample: [],
      sourceQuery: 'nex references <symbol> --include-heuristic',
    });
  }
  if (input.tests.length === 0) {
    output.push({
      category: 'code',
      missReason: 'test-relations-missing',
      affectedFiles: input.affectedFiles,
      potentiallyAffectedSymbols: null,
      estimateMethod:
        'no test relation was derived from references/calls; dynamic test discovery and string-keyed suites are not claimed',
      manualCheckHint: 'nex search --path test  # inspect the suite manually',
      sample: [],
      sourceQuery: 'nex search --path test',
    });
  }
  return output;
}

interface RootContext {
  loadedConfig: LoadedConfig | null;
  includeTemplate: boolean;
  projectRoot: string;
  base: string | null;
}

type DependencyLike = {
  sourceFile: string;
  line: number;
  col: number;
  relationClass: string;
  confidence: string;
  analysisEngine: string;
  evidence?: unknown;
};

function analyzeRootImpact(
  root: RootStatus,
  store: ReadStore,
  target: ImpactTarget,
  depth: number,
  context: RootContext,
): RootImpactReport {
  const notes: string[] = [];
  const targetPath = target.filePath;
  const symbolsInFile = targetPath === null ? [] : readSymbolsForFile(store, targetPath);
  const targetSymbol = target.symbolId === null ? null : readSymbolById(store, target.symbolId);
  const directFiles = new Map<string, ImpactItem>();
  const directSymbols = new Map<string, ImpactItem>();
  const indirectFiles = new Map<string, ImpactItem>();
  const indirectSymbols = new Map<string, ImpactItem>();
  const visitedFiles = new Set<string>(targetPath === null ? [] : [targetPath]);
  const visitedSymbols = new Set<string>(targetSymbol === null ? [] : [targetSymbol.symbolId]);
  const styleDependents: StyleDependent[] = [];
  const targetDependencies =
    targetPath === null
      ? []
      : readDependencies(store, { limit: 20000 }).filter(
          (dependency) =>
            dependency.targetFile === targetPath ||
            (dependency.targetFile ?? '').startsWith(`${targetPath}/`),
        );

  const addDirectFile = (dependency: DependencyLike, reason: string): void => {
    const file = dependency.sourceFile;
    if (file === targetPath || visitedFiles.has(file) || directFiles.has(file)) return;
    directFiles.set(file, {
      rootId: root.rootId,
      kind: 'file',
      path: file,
      line: dependency.line,
      col: dependency.col,
      symbolId: null,
      name: path.posix.basename(file),
      kindOfSymbol: null,
      depth: 1,
      relationClass: dependency.relationClass,
      confidence: dependency.confidence,
      reason,
      analysisEngine: dependency.analysisEngine,
      evidence: dependency.evidence,
    });
  };

  const addDirectSymbol = (
    symbolId: string | null,
    file: string,
    line: number,
    col: number,
    relationClass: string,
    confidence: string,
    reason: string,
    analysisEngine: string,
    evidence?: unknown,
  ): void => {
    if (symbolId === null) return;
    if (symbolId === target.symbolId || directSymbols.has(symbolId)) return;
    const record = readSymbolById(store, symbolId);
    directSymbols.set(symbolId, {
      rootId: root.rootId,
      kind: 'symbol',
      path: record?.path ?? file,
      line,
      col,
      symbolId,
      name: record?.nameChain ?? null,
      kindOfSymbol: record?.kind ?? null,
      depth: 1,
      relationClass,
      confidence,
      reason,
      analysisEngine,
      evidence,
    });
  };

  for (const dependency of targetDependencies) {
    if (target.kind === 'style' && !dependency.depType.startsWith('style-')) continue;
    addDirectFile(dependency, target.kind === 'style' ? 'style-consumer' : 'direct-importer');
    if (target.kind === 'style') {
      styleDependents.push({
        rootId: root.rootId,
        sourceFile: dependency.sourceFile,
        line: dependency.line,
        depType: dependency.depType,
        confidence: dependency.confidence,
        relationClass: dependency.relationClass,
        analysisEngine: dependency.analysisEngine,
      });
    }
  }

  const referenceConsumers = (symbol: SymbolRecord): ReferenceRecord[] =>
    readReferencesTo(store, symbol.symbolId);

  const symbolSeeds =
    target.kind === 'symbol' && targetSymbol !== null ? [targetSymbol] : symbolsInFile;
  for (const symbol of symbolSeeds) {
    for (const reference of referenceConsumers(symbol)) {
      if (!context.includeTemplate && reference.role.startsWith('template:')) continue;
      if (reference.sourceFile === symbol.path) continue;
      addDirectFile(
        {
          sourceFile: reference.sourceFile,
          relationClass: reference.relationClass,
          confidence: reference.confidence,
          analysisEngine: reference.analysisEngine,
          line: reference.line,
          col: reference.col,
          evidence: {
            sourceOfTruth: 'references',
            analysisVersion: '',
            constraints: [],
            missReason: reference.unresolvedReason,
          },
        },
        'direct-reference',
      );
      addDirectSymbol(
        reference.sourceSymbolId,
        reference.sourceFile,
        reference.line,
        reference.col,
        reference.relationClass,
        reference.confidence,
        'direct-reference',
        reference.analysisEngine,
      );
    }
    for (const call of readCalls(store, { calleeSymbolId: symbol.symbolId })) {
      if (call.callerFile === symbol.path) continue;
      addDirectSymbol(
        call.callerSymbolId,
        call.callerFile,
        call.line,
        call.col,
        call.relationClass,
        call.confidence,
        'direct-caller',
        call.analysisEngine,
        call.evidence,
      );
      if (!directFiles.has(call.callerFile)) {
        directFiles.set(call.callerFile, {
          rootId: root.rootId,
          kind: 'file',
          path: call.callerFile,
          line: call.line,
          col: call.col,
          symbolId: null,
          name: path.posix.basename(call.callerFile),
          kindOfSymbol: null,
          depth: 1,
          relationClass: call.relationClass,
          confidence: call.confidence,
          reason: 'direct-caller',
          analysisEngine: call.analysisEngine,
          evidence: call.evidence,
        });
      }
    }
  }

  for (const item of directFiles.values()) visitedFiles.add(item.path);
  for (const item of directSymbols.values()) {
    if (item.symbolId !== null) visitedSymbols.add(item.symbolId);
  }

  const queue: Array<{ type: 'file' | 'symbol'; key: string; depth: number }> = [];
  for (const item of directFiles.values()) queue.push({ type: 'file', key: item.path, depth: 1 });
  for (const item of directSymbols.values()) {
    if (item.symbolId !== null) queue.push({ type: 'symbol', key: item.symbolId, depth: 1 });
  }

  let truncated = false;
  const maxDepth = Math.min(Math.max(depth, 1), MAX_DEPTH);
  while (queue.length > 0) {
    const entry = queue.shift() as { type: 'file' | 'symbol'; key: string; depth: number };
    if (entry.depth >= maxDepth) continue;
    if (
      directFiles.size + directSymbols.size + indirectFiles.size + indirectSymbols.size >=
      MAX_ITEMS
    ) {
      truncated = true;
      break;
    }
    if (entry.type === 'file') {
      const reverse = readDependencies(store, { limit: 20000 }).filter(
        (dependency) => dependency.targetFile === entry.key,
      );
      for (const dependency of reverse) {
        if (visitedFiles.has(dependency.sourceFile)) continue;
        visitedFiles.add(dependency.sourceFile);
        indirectFiles.set(dependency.sourceFile, {
          rootId: root.rootId,
          kind: 'file',
          path: dependency.sourceFile,
          line: dependency.line,
          col: dependency.col,
          symbolId: null,
          name: path.posix.basename(dependency.sourceFile),
          kindOfSymbol: null,
          depth: entry.depth + 1,
          relationClass: dependency.relationClass,
          confidence: dependency.confidence,
          reason: 'indirect-importer',
          analysisEngine: dependency.analysisEngine,
          evidence: dependency.evidence,
        });
        queue.push({ type: 'file', key: dependency.sourceFile, depth: entry.depth + 1 });
      }
    } else {
      const symbol = readSymbolById(store, entry.key);
      if (symbol === null) continue;
      for (const reference of referenceConsumers(symbol)) {
        if (!context.includeTemplate && reference.role.startsWith('template:')) continue;
        if (reference.sourceFile === symbol.path) continue;
        if (!visitedFiles.has(reference.sourceFile)) {
          visitedFiles.add(reference.sourceFile);
          indirectFiles.set(reference.sourceFile, {
            rootId: root.rootId,
            kind: 'file',
            path: reference.sourceFile,
            line: reference.line,
            col: reference.col,
            symbolId: null,
            name: path.posix.basename(reference.sourceFile),
            kindOfSymbol: null,
            depth: entry.depth + 1,
            relationClass: reference.relationClass,
            confidence: reference.confidence,
            reason: 'indirect-reference',
            analysisEngine: reference.analysisEngine,
          });
          queue.push({ type: 'file', key: reference.sourceFile, depth: entry.depth + 1 });
        }
        if (reference.sourceSymbolId !== null && !visitedSymbols.has(reference.sourceSymbolId)) {
          visitedSymbols.add(reference.sourceSymbolId);
          const record = readSymbolById(store, reference.sourceSymbolId);
          indirectSymbols.set(reference.sourceSymbolId, {
            rootId: root.rootId,
            kind: 'symbol',
            path: record?.path ?? reference.sourceFile,
            line: reference.line,
            col: reference.col,
            symbolId: reference.sourceSymbolId,
            name: record?.nameChain ?? null,
            kindOfSymbol: record?.kind ?? null,
            depth: entry.depth + 1,
            relationClass: reference.relationClass,
            confidence: reference.confidence,
            reason: 'indirect-reference',
            analysisEngine: reference.analysisEngine,
          });
          queue.push({ type: 'symbol', key: reference.sourceSymbolId, depth: entry.depth + 1 });
        }
      }
      for (const call of readCalls(store, { calleeSymbolId: symbol.symbolId })) {
        if (call.callerSymbolId !== null && !visitedSymbols.has(call.callerSymbolId)) {
          visitedSymbols.add(call.callerSymbolId);
          const record = readSymbolById(store, call.callerSymbolId);
          indirectSymbols.set(call.callerSymbolId, {
            rootId: root.rootId,
            kind: 'symbol',
            path: record?.path ?? call.callerFile,
            line: call.line,
            col: call.col,
            symbolId: call.callerSymbolId,
            name: record?.nameChain ?? null,
            kindOfSymbol: record?.kind ?? null,
            depth: entry.depth + 1,
            relationClass: call.relationClass,
            confidence: call.confidence,
            reason: 'indirect-caller',
            analysisEngine: call.analysisEngine,
          });
          queue.push({ type: 'symbol', key: call.callerSymbolId, depth: entry.depth + 1 });
        }
      }
    }
  }

  const direct = [...directFiles.values(), ...directSymbols.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.col - right.col ||
      (left.symbolId ?? '').localeCompare(right.symbolId ?? ''),
  );
  const indirect = [...indirectFiles.values(), ...indirectSymbols.values()].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.col - right.col,
  );
  const allItems = [...direct, ...indirect];
  const counts = relationCounts(allItems);
  const affectedFiles = new Set([...(targetPath === null ? [] : [targetPath])]);
  for (const item of allItems) affectedFiles.add(item.path);
  const affectedSymbolIds = new Set<string>();
  if (target.symbolId !== null) affectedSymbolIds.add(target.symbolId);
  for (const symbol of symbolsInFile) affectedSymbolIds.add(symbol.symbolId);
  for (const item of allItems) if (item.symbolId !== null) affectedSymbolIds.add(item.symbolId);
  const impactFanout = affectedSymbolIds.size;

  // Surface: entries whose symbol is affected (directly or through a file).
  const surfaceRead = readSurface(context.projectRoot, root.rootId);
  const surfaceLookup = buildSurfaceLookup(
    surfaceRead.surface !== null && surfaceRead.matchesManifest ? surfaceRead.surface : null,
  );
  const affectedSymbolPaths = new Map<string, string>();
  for (const symbol of symbolsInFile) affectedSymbolPaths.set(symbol.symbolId, symbol.path);
  for (const item of allItems) {
    if (item.symbolId !== null) affectedSymbolPaths.set(item.symbolId, item.path);
  }
  for (const item of allItems) {
    if (item.symbolId !== null && item.path !== undefined)
      affectedSymbolPaths.set(item.symbolId, item.path);
  }
  const surfaceEntries = new Set<SurfaceEntry>();
  if (surfaceRead.surface !== null && surfaceRead.matchesManifest) {
    for (const entry of surfaceRead.surface.entries) {
      const entryPath = affectedSymbolPaths.get(entry.symbolId);
      if (
        affectedSymbolIds.has(entry.symbolId) ||
        (entryPath !== undefined && affectedFiles.has(entryPath))
      ) {
        surfaceEntries.add(entry);
      }
    }
  }
  let surfaceDiff: SurfaceDiff | null = null;
  let diffLevel: RootImpactReport['surface']['diffLevel'] = 'not-available';
  if (surfaceRead.surface !== null && surfaceRead.matchesManifest) {
    try {
      const diff = diffCurrentSurface({
        projectRoot: context.projectRoot,
        loadedConfig: context.loadedConfig,
        rootId: root.rootId,
        base: context.base,
      });
      surfaceDiff = diff.diff;
      const relevant = diff.diff.items.filter(
        (item) =>
          (item.evidence.symbolId !== null && affectedSymbolIds.has(item.evidence.symbolId)) ||
          (item.name !== '' &&
            [...affectedSymbolIds].some((id) =>
              surfaceLookup.entriesBySymbolId.get(id)?.some((entry) => entry.name === item.name),
            )),
      );
      if (relevant.some((item) => item.severity === 'breaking')) diffLevel = 'breaking';
      else if (relevant.some((item) => item.severity === 'additive')) diffLevel = 'additive';
      else if (relevant.some((item) => item.severity === 'ambiguous')) diffLevel = 'ambiguous';
      else if (relevant.some((item) => item.severity === 'internal')) diffLevel = 'internal';
      else diffLevel = 'none';
    } catch (error) {
      notes.push(
        `surface diff not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    notes.push('surface.json is unavailable or stale; surface impact is reported as unknown');
  }

  const components = new Map<string, RootImpactReport['components']['affected'][number]>();
  const types = new Map<string, RootImpactReport['types']['affected'][number]>();
  const registerSymbol = (symbol: SymbolRecord): void => {
    const record = {
      rootId: root.rootId,
      symbolId: symbol.symbolId,
      name: symbol.nameChain,
      path: symbol.path,
      line: symbol.declarationLocator.startLine,
    };
    if (symbol.kind === 'component') components.set(symbol.symbolId, record);
    if (['interface', 'type', 'class', 'enum'].includes(symbol.kind))
      types.set(symbol.symbolId, record);
  };
  for (const symbol of symbolsInFile) registerSymbol(symbol);
  for (const item of allItems) {
    if (item.symbolId === null) continue;
    const record = readSymbolById(store, item.symbolId);
    if (record !== null) registerSymbol(record);
  }
  // Template consumers make the containing component affected.
  for (const item of allItems) {
    if (item.symbolId === null) continue;
    for (const reference of readReferencesTo(store, item.symbolId)) {
      if (!reference.role.startsWith('template:')) continue;
      const component = readSymbolsForFile(store, reference.sourceFile).find(
        (symbol) => symbol.kind === 'component',
      );
      if (component !== undefined) registerSymbol(component);
    }
  }

  const tests = new Map<string, TestRecord>();
  for (const symbolId of affectedSymbolIds) {
    for (const test of readTestsForSymbol(store, symbolId)) {
      tests.set(`${test.testFile}|${test.targetSymbolId ?? ''}|${test.line}`, test);
    }
  }
  if (targetPath !== null) {
    for (const test of readTestsForFile(store, targetPath)) {
      tests.set(`${test.testFile}|${test.targetSymbolId ?? ''}|${test.line}`, test);
    }
  }
  const relatedTests = [...tests.values()].sort(
    (left, right) => left.testFile.localeCompare(right.testFile) || left.line - right.line,
  );

  const docTerms = [
    target.name ?? '',
    target.nameChain ?? '',
    targetPath === null ? '' : path.posix.basename(targetPath),
    targetPath ?? '',
  ].filter((term) => term.length >= 3);
  const docs = findRelatedDocs({
    projectRoot: context.projectRoot,
    ignore: context.loadedConfig?.config?.defaults.ignore ?? {
      dirs: [],
      files: [],
      globs: [],
      include: [],
      modes: ['build', 'update', 'watch'],
      pruneWatcher: true,
    },
    terms: docTerms,
  });

  const violations = readArchitectureViolations(store).filter(
    (violation) =>
      affectedFiles.has(violation.sourceFile) || affectedFiles.has(violation.targetFile),
  );
  const modules = [
    ...new Set(
      allItems
        .map((item) => item.path)
        .map((file) => readManifestFileModule(store, file))
        .filter((module): module is string => module !== null),
    ),
  ].sort();

  const manifest = readManifest(manifestPath(context.projectRoot, root.rootId)).manifest;
  const baseBlindSpots = Array.isArray(manifest?.blindSpots) ? manifest.blindSpots : [];
  const unresolvedConsumers = allItems.filter(
    (item) => item.relationClass === 'dynamic-unresolved',
  ).length;
  const blindSpots = [
    ...baseBlindSpots,
    ...targetedBlindSpots({
      target,
      covered: targetPath === null ? true : fileCovered(store, targetPath),
      unresolvedConsumers,
      tests: relatedTests,
      affectedFiles: affectedFiles.size,
      affectedSymbols: impactFanout,
    }),
  ];

  const reasons: ImpactRiskReason[] = [];
  let level: ImpactRisk['level'] = 'Low';
  const raise = (next: ImpactRisk['level']): void => {
    const order = { Low: 0, Medium: 1, High: 2, Critical: 3 } as const;
    if (order[next] > order[level]) level = next;
  };
  if (surfaceEntries.size > 0) {
    raise('High');
    reasons.push({
      rule: 'surface-hit',
      detail: `${surfaceEntries.size} public Surface entr${surfaceEntries.size === 1 ? 'y is' : 'ies are'} in the affected set`,
    });
  }
  if (diffLevel === 'breaking') {
    raise('Critical');
    reasons.push({
      rule: 'surface-breaking',
      detail:
        'the current index differs from the baseline with a breaking Surface change in the affected set',
    });
  } else if (diffLevel === 'additive') {
    raise('High');
    reasons.push({
      rule: 'surface-additive',
      detail: 'an additive Surface change is in the affected set',
    });
  }
  if (violations.length > 0) {
    raise('Critical');
    reasons.push({
      rule: 'architecture-violation',
      detail: `${violations.length} architecture violation(s) touch affected files`,
      file: violations[0]?.sourceFile,
      line: violations[0]?.line,
      relationClass: violations[0]?.relationClass,
      confidence: violations[0]?.confidence,
    });
  }
  if (unresolvedConsumers > 0) {
    raise('High');
    reasons.push({
      rule: 'unresolved-consumer',
      detail: `${unresolvedConsumers} affected relation(s) are dynamic-unresolved and cannot be bounded statically`,
    });
  }
  if (modules.length > 1) {
    raise('Medium');
    reasons.push({
      rule: 'cross-module',
      detail: `affected files belong to ${modules.length} architecture modules: ${modules.join(', ')}`,
    });
  }
  if (relatedTests.length > 0) {
    raise('Medium');
    reasons.push({
      rule: 'related-tests',
      detail: `${relatedTests.length} test relation(s) cover the affected symbols`,
    });
  }
  if (target.kind === 'style') {
    raise('Medium');
    reasons.push({
      rule: 'style-file-level',
      detail: `style impact is file-level; ${styleDependents.length} static consumer(s); selector impact is not claimed`,
    });
    if ((level as string) === 'Critical') level = 'High';
  }
  if (reasons.length === 0) {
    reasons.push({
      rule: 'local-change',
      detail: 'no Surface hit, no architecture violation and no cross-module consumer was found',
    });
  }
  for (const item of direct.slice(0, 5)) {
    reasons.push({
      rule: 'consumer-evidence',
      detail: `${item.reason} at ${item.path}:${item.line}:${item.col}`,
      file: item.path,
      line: item.line,
      relationClass: item.relationClass,
      confidence: item.confidence,
    });
  }

  const countTotal = allItems.length;
  return {
    rootId: root.rootId,
    rootPath: root.rootPath,
    target,
    direct: { count: direct.length, items: direct },
    indirect: {
      depth: maxDepth,
      count: indirect.length,
      items: indirect,
      truncated,
      nextCursor: truncated ? `impact:${maxDepth}:${allItems.length}` : null,
    },
    surface: {
      affected: [...surfaceEntries].sort((left, right) => left.name.localeCompare(right.name)),
      diffLevel,
      basis: diffLevel === 'not-available' ? 'not-available' : 'current-vs-baseline',
      diff: surfaceDiff,
    },
    components: { affected: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    types: { affected: [...types.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    tests: {
      related: relatedTests,
      suggestedCommands: commandSuggestions(context.loadedConfig, context.projectRoot),
    },
    docs: {
      related: docs.matches,
      searchedFiles: docs.searchedFiles,
      truncated: docs.truncated,
      note: docs.note,
    },
    architecture: {
      violations,
      modules,
    },
    blindSpots,
    styleDependents,
    counts: {
      total: countTotal,
      returned: countTotal,
      certain: counts.certain,
      heuristic: counts.heuristic,
      dynamicUnresolved: counts.dynamicUnresolved,
      partial: root.staleness === 'fresh' ? 0 : countTotal,
    },
    impactFanout,
    risk: { level, reasons },
    staleness: root.staleness,
    buildFingerprint: root.buildFingerprint,
    coverage: toCoverage(root),
    notes,
  };
}

function readManifestFileModule(store: ReadStore, file: string): string | null {
  const row = store.db
    .prepare('select owner_module from files where build_id = ? and path = ?')
    .get(store.build.buildId, file) as { owner_module?: unknown } | undefined;
  return typeof row?.owner_module === 'string' ? row.owner_module : null;
}

export async function analyzeImpact(options: ImpactOptions): Promise<ImpactResult> {
  const context = await prepareContext(options);
  const selection = selectScope(context, options);
  const depth = Math.min(Math.max(options.depth ?? 3, 1), MAX_DEPTH);
  const reports: RootImpactReport[] = [];
  const notes: string[] = [];
  const strict = selection.roots.length === 1;
  for (const root of selection.roots) {
    const store = openReadStore(databasePath(options.projectRoot, root.rootId));
    if (store === null) {
      if (strict) {
        throw nexusError('E01', 'index does not exist', {
          reason: 'no committed build in index.db',
          suggestion: 'Run `nex build`.',
          evidence: { rootId: root.rootId },
        });
      }
      notes.push(`root ${root.rootId}: no committed index`);
      continue;
    }
    try {
      const target = resolveTarget(store, options.projectRoot, root.rootId, options, strict);
      if (target === null) {
        notes.push(`root ${root.rootId}: target is not present`);
        continue;
      }
      reports.push(
        analyzeRootImpact(root, store, target, depth, {
          loadedConfig: context.loadedConfig,
          includeTemplate: options.includeTemplate !== false,
          projectRoot: options.projectRoot,
          base: options.base ?? null,
        }),
      );
    } finally {
      store.db.close();
    }
  }
  if (reports.length === 0) {
    throw nexusError('E05', 'impact target does not exist', {
      reason: `target ${options.symbol ?? options.target} is not present in the selected roots`,
      suggestion: 'Pass a project-relative file path or a symbol name; use `nex search` first.',
      evidence: { roots: selection.roots.map((root) => root.rootId) },
    });
  }
  const nestedNote =
    selection.nestedRootIds.length > 0
      ? `cwd is inside nested roots ${[selection.activeRoot ?? '', ...selection.nestedRootIds]
          .filter((entry) => entry !== '')
          .join(', ')}; the longest root path wins`
      : null;
  if (nestedNote !== null) notes.push(nestedNote);
  return {
    scope: selection.scope,
    reports,
    warnings: context.warnings,
    notes,
    staleRoots: selection.staleRoots,
    failedRoots: selection.failedRoots,
    completeness:
      selection.staleRoots.length === 0 && selection.failedRoots.length === 0
        ? 'complete'
        : 'partial',
    degraded: [...new Set(selection.roots.flatMap((root) => root.degraded))].sort(),
    budget: context.budget,
  };
}

/** Flatten one or more root reports into the CLI/json contract of 10.3. */
export function impactData(result: ImpactResult): Record<string, unknown> {
  const first = result.reports[0] as RootImpactReport;
  const direct = result.reports.flatMap((report) => report.direct.items);
  const indirect = result.reports.flatMap((report) => report.indirect.items);
  const coverage =
    result.reports.length === 1
      ? first.coverage
      : result.reports.reduce<Coverage>(
          (total, report) => ({
            filesCovered: total.filesCovered + report.coverage.filesCovered,
            filesSkipped: total.filesSkipped + report.coverage.filesSkipped,
            filesIgnored: total.filesIgnored + report.coverage.filesIgnored,
            filesFailed: total.filesFailed + report.coverage.filesFailed,
            resolved: total.resolved + report.coverage.resolved,
            unresolved: total.unresolved + report.coverage.unresolved,
            unmapped: total.unmapped + report.coverage.unmapped,
            filteredInternal: total.filteredInternal + report.coverage.filteredInternal,
          }),
          {
            filesCovered: 0,
            filesSkipped: 0,
            filesIgnored: 0,
            filesFailed: 0,
            resolved: 0,
            unresolved: 0,
            unmapped: 0,
            filteredInternal: 0,
          },
        );
  const rank = {
    breaking: 4,
    additive: 3,
    ambiguous: 2,
    internal: 1,
    none: 0,
    'not-available': -1,
  } as const;
  const diffLevel = result.reports.reduce(
    (worst, report) =>
      rank[report.surface.diffLevel] > rank[worst] ? report.surface.diffLevel : worst,
    first.surface.diffLevel,
  );
  const surface =
    result.reports.length === 1
      ? first.surface
      : {
          affected: [
            ...new Map(
              result.reports
                .flatMap((report) => report.surface.affected)
                .map((entry) => [`${entry.symbolId}|${entry.entryPath ?? ''}`, entry]),
            ).values(),
          ],
          diffLevel,
          basis: first.surface.basis,
          diff: null,
        };
  const counts = result.reports.reduce(
    (total, report) => ({
      total: total.total + report.counts.total,
      returned: total.returned + report.counts.returned,
      certain: total.certain + report.counts.certain,
      heuristic: total.heuristic + report.counts.heuristic,
      dynamicUnresolved: total.dynamicUnresolved + report.counts.dynamicUnresolved,
      partial: total.partial + report.counts.partial,
    }),
    { total: 0, returned: 0, certain: 0, heuristic: 0, dynamicUnresolved: 0, partial: 0 },
  );
  const order = { Low: 0, Medium: 1, High: 2, Critical: 3 } as const;
  const risk = result.reports.reduce(
    (worst, report) => (order[report.risk.level] > order[worst.level] ? report.risk : worst),
    first.risk,
  );
  return {
    command: 'impact',
    scope: result.scope,
    target: first.target,
    direct: { count: direct.length, items: direct },
    indirect: {
      depth: first.indirect.depth,
      count: indirect.length,
      items: indirect,
      truncated: result.reports.some((report) => report.indirect.truncated),
      nextCursor:
        result.reports.find((report) => report.indirect.nextCursor !== null)?.indirect.nextCursor ??
        null,
    },
    surface,
    components: { affected: result.reports.flatMap((report) => report.components.affected) },
    types: { affected: result.reports.flatMap((report) => report.types.affected) },
    tests: {
      related: result.reports.flatMap((report) => report.tests.related),
      suggestedCommands: [
        ...new Set(result.reports.flatMap((report) => report.tests.suggestedCommands)),
      ],
    },
    docs: first.docs,
    architecture: {
      violations: result.reports.flatMap((report) => report.architecture.violations),
      modules: [...new Set(result.reports.flatMap((report) => report.architecture.modules))],
    },
    blindSpots: result.reports.flatMap((report) => report.blindSpots),
    styleDependents: result.reports.flatMap((report) => report.styleDependents),
    counts,
    impactFanout: result.reports.reduce((total, report) => total + report.impactFanout, 0),
    risk,
    staleness:
      result.completeness === 'complete' &&
      result.reports.every((report) => report.staleness === 'fresh')
        ? 'fresh'
        : 'stale',
    buildFingerprint: result.reports.length === 1 ? first.buildFingerprint : null,
    coverage,
    staleRoots: result.staleRoots,
    failedRoots: result.failedRoots,
    completeness: result.completeness,
    degraded: result.degraded,
    budget: result.budget,
    truncated:
      result.reports.some((report) => report.indirect.truncated) ||
      result.reports.some((report) => report.docs.truncated),
    nextCursor:
      result.reports.find((report) => report.indirect.nextCursor !== null)?.indirect.nextCursor ??
      null,
    warnings: result.warnings,
    notes: result.notes,
    byRoot:
      result.reports.length > 1
        ? result.reports.map((report) => ({
            rootId: report.rootId,
            rootPath: report.rootPath,
            staleness: report.staleness,
            buildFingerprint: report.buildFingerprint,
            counts: report.counts,
            coverage: report.coverage,
            items: [...report.direct.items, ...report.indirect.items],
            risk: report.risk,
            target: report.target,
          }))
        : undefined,
  };
}
