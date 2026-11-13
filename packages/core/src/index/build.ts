import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import ts from 'typescript';

import type { LoadedConfig } from '../config/load.js';
import { resolveRootConfig, type EffectiveRootConfig } from '../config/merge.js';
import { nexusError, mapUnknownError } from '../errors.js';
import { isInside, relativePosix } from '../util/paths.js';
import { discoverRoots, type RootCandidate } from '../discovery/roots.js';
import { IgnoreMatcher } from '../discovery/ignore.js';
import {
  scanFiles,
  filesHash,
  statHash,
  type ScanResult,
  type ScannedFile,
} from '../discovery/scan.js';
import { readTsconfig } from '../discovery/tsconfig.js';
import { ANALYZER_VERSION, VUE_LANGUAGE_CORE_VERSION, VUE_PROJECTOR_VERSION } from './analyzer.js';
import { collectDeclarations, createSyntaxProgram } from './declarations.js';
import type {
  ComponentRecord,
  DeclarationRecord,
  ReferenceRecord,
  VueAnalysisSummary,
  VueFileMetaRecord,
} from '../model.js';
import {
  assignIdentities,
  mapSymbolsAndReferences,
  symbolsFromAssignments,
  locatorKey,
  type IdentityAssignment,
  type MappingResult,
  type MappingStats,
  type PreviousIdentity,
} from './mapping.js';
import {
  computeBuildFingerprint,
  computeRootSetHash,
  platformId,
  SCHEMA_VERSION,
  type BuildFingerprintFields,
} from './fingerprint.js';
import { readScipIndex, runScipIndex, type ScipDocument, type ScipIndexData } from './scip.js';
import {
  commitBuild,
  readPreviousIdentities,
  recoverPending,
  type MappingRow,
} from '../store/commit.js';
import { probeSqlite } from '../store/db.js';
import {
  databasePath,
  dbSizes,
  manifestPath,
  readManifest,
  rootDirectory,
  writeManifestAtomic,
  type RootManifest,
} from '../store/manifest.js';
import { withRootLock } from '../store/lock.js';
import { crashPoint } from '../store/inject.js';
import { beginIndexing, endIndexing, updateIndexingPhase } from '../store/state.js';
import { recoverWorkspace } from '../store/recovery.js';
import {
  buildWorkspaceSnapshot,
  reconcileWorkspace,
  writeWorkspaceAtomic,
} from '../store/workspace.js';
import {
  GlobalResourceCoordinator,
  computeResourceBudget,
  computeRootWeights,
  orderRootsByDependencies,
  type DegradationFlags,
} from '../scheduler.js';
import {
  computeTsconfigHash,
  planRootChange,
  tsconfigStat,
  type RootChangePlan,
} from './invalidation.js';
import { headCommit } from '../audit/git.js';
import { projectVueFile, type VueProjection } from '../vue/project.js';
import {
  collectVueSymbols,
  type ComponentDraft,
  type VueDeclaration,
} from '../vue/declarations.js';
import { mapVueSymbolsAndReferences, type VueMappingResult } from '../vue/references.js';
import { writeShadowProject, type ShadowProject } from '../vue/shadow.js';
import { buildSurface } from '../surface/builder.js';
import { writeSurface } from '../surface/store.js';
import type { SurfaceRootSnapshot } from '../surface/types.js';
import { buildGraph, type GraphBuildResult } from '../graph/builder.js';
import {
  CrossRootResolver,
  loadWorkspaceRootInfo,
  type WorkspaceRootInfo,
} from '../graph/cross-root.js';

export interface BuildProgressEvent {
  type:
    | 'root-start'
    | 'scan'
    | 'vue'
    | 'scip'
    | 'write'
    | 'root-done'
    | 'root-failed'
    | 'workspace-done';
  rootId: string;
  message: string;
}

export interface RootBuildResult {
  rootId: string;
  ok: boolean;
  buildId: string | null;
  buildFingerprint: string | null;
  files: number;
  symbols: number;
  references: number;
  dependencies?: number;
  calls?: number;
  tests?: number;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  coverage: RootManifest['coverage'] | null;
  vue?: VueAnalysisSummary;
  degraded: string[];
  /** Phase 06 */
  mode?: 'fresh' | 'incremental' | 'full';
  skipped?: boolean;
  changed?: RootManifest['changed'];
  peakRssMB?: number;
  degradedStages?: string[];
  invalidatedFiles?: string[];
}

export interface BuildResult {
  roots: RootBuildResult[];
  failedRoots: string[];
  totalMs: number;
  resources?: {
    budgetMB: number;
    concurrency: number;
    peakRssMBGlobal: number;
    degradedStages: string[];
  };
  recovery?: {
    repaired: string[];
    invalid: string[];
  };
}

export interface BuildOptions {
  projectRoot: string;
  loadedConfig: LoadedConfig;
  onProgress?: (event: BuildProgressEvent) => void;
  serial?: boolean;
  /** All selected roots; used only for declared-package boundary resolution. */
  workspaceRoots?: readonly WorkspaceRootInfo[];
  /** Phase 06: `update` skips fresh roots and classifies each root first. */
  mode?: 'build' | 'update';
  /** Only build these roots (already validated against discovery). */
  selectedRootIds?: readonly string[];
  /** `--rebuild-affected`: force a full rebuild for every changed root. */
  forceFull?: boolean;
  /** `--files <glob>`: treat matching files as changed. */
  forcedGlobs?: readonly string[];
  /** `--budget-mb`: per-root budget hint (capped by the global budget). */
  budgetMB?: number;
  /** Cancellation (docs/05-data-model.md 5.10.3). */
  signal?: AbortSignal;
  /** Coordinator snapshot for the manifest (set by buildWorkspace). */
  resourceInfo?: {
    budgetMB: number;
    concurrency: number;
    peakRssMBGlobal: number;
    degradedStages: string[];
  };
}

interface RootAnalysis {
  scan: ScanResult;
  tsconfigOk: boolean;
  assignments: IdentityAssignment[];
  collisions: number;
  mapping: MappingResult;
  vueMapping: VueMappingResult | null;
  vueDeclarationSet: ReadonlySet<DeclarationRecord>;
  components: ComponentRecord[];
  vueFileMeta: VueFileMetaRecord[];
  surface: SurfaceRootSnapshot;
  graph: GraphBuildResult;
  vue: VueAnalysisSummary;
  degraded: string[];
  timings: {
    scanMs: number;
    analyzeMs: number;
    vueMs: number;
    scipMs: number;
    mapMs: number;
    graphMs: number;
  };
}

function emit(options: BuildOptions, event: BuildProgressEvent): void {
  options.onProgress?.(event);
}

function memorySampler(): { stop: () => number } {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const current = process.memoryUsage().rss;
    if (current > peak) peak = current;
  }, 50);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.round((peak / (1024 * 1024)) * 10) / 10;
    },
  };
}

export function clearTmp(projectRoot: string): void {
  const tmp = path.join(projectRoot, '.nexus', 'tmp');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // tmp is disposable; doctor reports leftovers
  }
}

function normalizeScipPaths(index: ScipIndexData, rootPath: string): ScipIndexData {
  const prefix = rootPath === '.' ? '' : rootPath.replace(/\/+$/, '');
  if (prefix === '') return index;
  return {
    ...index,
    documents: index.documents.map((document) => ({
      ...document,
      path: `${prefix}/${document.path.replace(/^\.\//, '')}`,
    })),
  };
}

function sourceFileMap(
  program: ts.Program,
  rootAbs: string,
  projectRoot: string,
): Map<string, ts.SourceFile> {
  const map = new Map<string, ts.SourceFile>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!isInside(rootAbs, sourceFile.fileName)) continue;
    map.set(relativePosix(projectRoot, sourceFile.fileName), sourceFile);
  }
  return map;
}

function toPreviousIdentities(
  rows: Map<string, { symbolId: string; confidence: string; evidence: string[] }>,
): Map<string, PreviousIdentity> {
  const map = new Map<string, PreviousIdentity>();
  for (const [key, row] of rows) {
    map.set(key, {
      locatorKey: key,
      symbolId: row.symbolId,
      confidence:
        row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low'
          ? row.confidence
          : 'high',
      evidence: row.evidence,
    });
  }
  return map;
}

function* mappingRows(input: {
  assignments: readonly IdentityAssignment[];
  vueDeclarationSet: ReadonlySet<DeclarationRecord>;
  vueMapping: VueMappingResult | null;
}): Generator<MappingRow> {
  for (const assignment of input.assignments) {
    const declaration = assignment.declaration;
    const quality = assignment.mappingQuality;
    if (input.vueDeclarationSet.has(declaration)) {
      const vueDeclaration = declaration as VueDeclaration;
      const anchor = vueDeclaration.generatedAnchor;
      const anchorRef =
        anchor === null
          ? `vue:${vueDeclaration.path}#component`
          : `vue:${vueDeclaration.path}#${anchor.nameLine}:${anchor.nameCol}`;
      const scipSymbol = input.vueMapping?.scipSymbolBySymbolId.get(assignment.symbolId) ?? null;
      yield {
        symbolId: assignment.symbolId,
        engine: 'scip',
        engineRef: scipSymbol ?? '',
        matchQuality: quality,
        evidence: {
          anchor: `${vueDeclaration.path}:${vueDeclaration.nameLine}:${vueDeclaration.nameCol}`,
          descriptor: scipSymbol === null ? '' : scipSymbol.slice(-160),
        },
        analyzerVersion: ANALYZER_VERSION.scip,
      };
      yield {
        symbolId: assignment.symbolId,
        engine: 'ts',
        engineRef: anchorRef,
        matchQuality: anchor === null ? 'unmapped' : quality,
        evidence: { projector: VUE_PROJECTOR_VERSION, synthetic: anchor === null },
        analyzerVersion: ANALYZER_VERSION.typescript,
      };
      yield {
        symbolId: assignment.symbolId,
        engine: 'vue',
        engineRef: anchorRef,
        matchQuality: anchor === null ? 'exact' : quality,
        evidence: {
          projector: VUE_PROJECTOR_VERSION,
          languageCoreVersion: VUE_LANGUAGE_CORE_VERSION,
        },
        analyzerVersion: VUE_LANGUAGE_CORE_VERSION,
      };
      continue;
    }
    const scipSymbol = input.vueMapping?.scipSymbolBySymbolId.get(assignment.symbolId) ?? null;
    void scipSymbol;
    yield {
      symbolId: assignment.symbolId,
      engine: 'scip',
      engineRef: assignment.scipSymbol ?? '',
      matchQuality: quality,
      evidence: {
        anchor: `${declaration.path}:${declaration.nameLine}:${declaration.nameCol}`,
        descriptor: assignment.scipSymbol === null ? '' : assignment.scipSymbol.slice(-160),
      },
      analyzerVersion: ANALYZER_VERSION.scip,
    };
    yield {
      symbolId: assignment.symbolId,
      engine: 'ts',
      engineRef: locatorKey(declaration),
      matchQuality: quality,
      evidence: { kind: declaration.kind, nameChain: declaration.nameChain },
      analyzerVersion: ANALYZER_VERSION.typescript,
    };
  }
}

function emptyStats(eligible = 0): MappingStats {
  return {
    eligible,
    exact: 0,
    structural: 0,
    conflict: 0,
    ambiguous: 0,
    unmapped: eligible,
    mappingSuccessRate: 0,
    falseMatchCount: 0,
    collisions: 0,
  };
}

function unmappedMapping(
  assignments: readonly IdentityAssignment[],
  reason: string,
): MappingResult {
  return {
    symbols: symbolsFromAssignments(assignments, 'unmapped'),
    references: [],
    scipSymbolBySymbolId: new Map(assignments.map((assignment) => [assignment.symbolId, null])),
    scipSymbolToSymbolId: new Map(),
    stats: emptyStats(assignments.length),
    unmappedReasonCounts: { [reason]: assignments.length },
    externalReferences: 0,
    localOrUnmappedReferences: 0,
  };
}

function mergeMappings(
  ts: MappingResult,
  vue: MappingResult | null,
  collisions: number,
): MappingResult {
  if (vue === null) {
    const stats = { ...ts.stats, collisions };
    stats.mappingSuccessRate =
      stats.eligible === 0 ? 0 : (stats.exact + stats.structural) / stats.eligible;
    return {
      ...ts,
      stats,
      scipSymbolBySymbolId: new Map(ts.scipSymbolBySymbolId),
      scipSymbolToSymbolId: new Map(ts.scipSymbolToSymbolId),
    };
  }
  const stats: MappingStats = {
    eligible: ts.stats.eligible + vue.stats.eligible,
    exact: ts.stats.exact + vue.stats.exact,
    structural: ts.stats.structural + vue.stats.structural,
    conflict: ts.stats.conflict + vue.stats.conflict,
    ambiguous: ts.stats.ambiguous + vue.stats.ambiguous,
    unmapped: ts.stats.unmapped + vue.stats.unmapped,
    mappingSuccessRate: 0,
    falseMatchCount: ts.stats.falseMatchCount + vue.stats.falseMatchCount,
    collisions,
  };
  stats.mappingSuccessRate =
    stats.eligible === 0 ? 0 : (stats.exact + stats.structural) / stats.eligible;
  const unmappedReasonCounts: Record<string, number> = { ...ts.unmappedReasonCounts };
  for (const [reason, count] of Object.entries(vue.unmappedReasonCounts)) {
    unmappedReasonCounts[reason] = (unmappedReasonCounts[reason] ?? 0) + count;
  }
  const symbols = [...ts.symbols, ...vue.symbols].sort((left, right) =>
    left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0,
  );
  const references = [...ts.references, ...vue.references].sort(compareReferences);
  return {
    symbols,
    references,
    scipSymbolBySymbolId: new Map([...ts.scipSymbolBySymbolId, ...vue.scipSymbolBySymbolId]),
    scipSymbolToSymbolId: new Map([...ts.scipSymbolToSymbolId, ...vue.scipSymbolToSymbolId]),
    stats,
    unmappedReasonCounts,
    externalReferences: ts.externalReferences + vue.externalReferences,
    localOrUnmappedReferences: ts.localOrUnmappedReferences + vue.localOrUnmappedReferences,
  };
}

/**
 * Yield array entries while releasing each slot, so the write phase does not
 * keep a second full copy alive next to the SQLite statements
 * (docs/21-phase-00.md: compute-while-writing).
 */
function* drain<T>(items: T[]): Generator<T> {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as T;
    items[index] = undefined as unknown as T;
    yield item;
  }
  items.length = 0;
}

function* withBuildId(
  references: Iterable<ReferenceRecord>,
  buildId: string,
): Generator<ReferenceRecord> {
  for (const reference of references) {
    yield { ...reference, buildId };
  }
}

function compareReferences(left: ReferenceRecord, right: ReferenceRecord): number {
  if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.col !== right.col) return left.col - right.col;
  const leftTarget = left.targetSymbolId ?? '';
  const rightTarget = right.targetSymbolId ?? '';
  return leftTarget < rightTarget ? -1 : leftTarget > rightTarget ? 1 : 0;
}

function zeroVueSummary(files: number): VueAnalysisSummary {
  return {
    files,
    projected: 0,
    failed: 0,
    symbols: 0,
    mappedSymbols: 0,
    unmappedSymbols: 0,
    filteredInternal: 0,
    components: 0,
    propsCoverage: { resolved: 0, total: 0, unresolved: [] },
    templateEdges: { total: 0, certain: 0, heuristic: 0, dynamicUnresolved: 0 },
    unmappedReasons: {},
    errors: [],
  };
}

function buildVueSummary(input: {
  vueFiles: number;
  projections: readonly VueProjection[];
  declarations: readonly VueDeclaration[];
  components: readonly ComponentDraft[];
  vueMapping: VueMappingResult | null;
  declarationFilteredInternal: number;
  errors: readonly string[];
}): VueAnalysisSummary {
  const syntheticComponents = input.declarations.filter(
    (declaration) => declaration.syntheticComponent,
  ).length;
  const stats = input.vueMapping?.stats;
  const propsCoverage: VueAnalysisSummary['propsCoverage'] = {
    resolved: 0,
    total: 0,
    unresolved: [],
  };
  for (const component of input.components) {
    propsCoverage.resolved += component.propsCoverage.resolved;
    propsCoverage.total += component.propsCoverage.total;
    for (const entry of component.propsCoverage.unresolved) {
      propsCoverage.unresolved.push({ ...entry, name: `${component.name}.${entry.name}` });
    }
  }
  return {
    files: input.vueFiles,
    projected: input.projections.length,
    failed: input.vueFiles - input.projections.length,
    symbols: input.declarations.length,
    mappedSymbols: (stats?.exact ?? 0) + (stats?.structural ?? 0),
    unmappedSymbols: (stats?.unmapped ?? 0) + syntheticComponents,
    filteredInternal: input.declarationFilteredInternal + (input.vueMapping?.filteredInternal ?? 0),
    components: input.components.length,
    propsCoverage,
    templateEdges: input.vueMapping?.templateEdges ?? {
      total: 0,
      certain: 0,
      heuristic: 0,
      dynamicUnresolved: 0,
    },
    unmappedReasons: {
      ...(input.vueMapping?.unmappedReasonCounts ?? {}),
      'synthetic-component':
        input.vueMapping?.unmappedReasonCounts['synthetic-component'] ?? syntheticComponents,
    },
    errors: input.errors.slice(0, 20),
  };
}

function emptySurface(root: RootCandidate, warnings: string[] = []): SurfaceRootSnapshot {
  return {
    surfaceVersion: 1,
    rootId: root.rootId,
    rootPath: root.rootPath,
    packageName: root.packageName,
    buildId: '',
    buildFingerprint: '',
    packageVersion: null,
    surfaceHash: 'sh_aaaaaaaaaaaaaaaa',
    entries: [],
    internal: [],
    opaque: [],
    deprecated: [],
    warnings,
  };
}

async function analyzeRoot(
  root: RootCandidate,
  effective: EffectiveRootConfig,
  options: BuildOptions,
  tmpToken: string,
  startedAt: string,
  flags: DegradationFlags,
): Promise<RootAnalysis> {
  const rootAbs = root.absolutePath;
  const ignore = new IgnoreMatcher(effective.ignore);
  const tsconfig = readTsconfig(
    rootAbs,
    root.tsconfigRelativePath ?? `${root.rootPath}/tsconfig.json`,
  );
  const degraded: string[] = [];
  if (!tsconfig.ok) degraded.push('syntax-only');

  const scanStarted = Date.now();
  const scan = scanFiles({
    projectRoot: options.projectRoot,
    rootPath: rootAbs,
    absoluteRoot: rootAbs,
    ignore,
    tsconfigFileNames: tsconfig.ok ? tsconfig.fileNames : undefined,
  });
  const scanMs = Date.now() - scanStarted;
  if (scan.filesFailed.length > 0) degraded.push('files-failed');
  if (scan.filesSkippedBySize > 0) degraded.push('files-skipped-by-size');
  if (options.signal?.aborted) {
    throw nexusError('E20', 'build cancelled', {
      reason: 'abort signal received after scan',
      suggestion: 'Re-run update; the previous committed index is untouched.',
    });
  }
  const tsFiles = scan.files.filter((file) => file.language !== 'vue');
  const vueFiles = scan.files.filter((file) => file.language === 'vue');
  emit(options, {
    type: 'scan',
    rootId: root.rootId,
    message: `${scan.files.length} files (${tsFiles.length} TS/TSX, ${vueFiles.length} Vue; ${scan.filesIgnored} ignored, ${scan.filesFailed.length} failed)`,
  });

  const analyzeStarted = Date.now();
  const scannedNames = new Set(tsFiles.map((file) => file.absolutePath));
  const fileNames = tsconfig.ok
    ? tsconfig.fileNames.filter((fileName) => scannedNames.has(path.resolve(fileName)))
    : tsFiles.map((file) => file.absolutePath);
  const program = createSyntaxProgram(fileNames, tsconfig.options);
  const semanticProgram = tsconfig.ok
    ? ts.createProgram({
        rootNames: [...fileNames],
        options: {
          ...(tsconfig.options as ts.CompilerOptions),
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
      })
    : program;
  const checker = semanticProgram.getTypeChecker();
  const tsDeclarations = collectDeclarations(program, rootAbs, options.projectRoot, root.rootId);

  const projections: VueProjection[] = [];
  let shadow: ShadowProject | null = null;
  let vueDeclarations: VueDeclaration[] = [];
  let vueComponentDrafts: ComponentDraft[] = [];
  let vueDeclarationFilteredInternal = 0;
  let vueMapping: VueMappingResult | null = null;
  let tsIndex: ScipIndexData | null = null;
  let shadowDocuments: ScipDocument[] = [];
  let vueFilteredByFile = new Map<string, number>();
  let scipMs = 0;
  const vueErrors: string[] = [];

  const vueStarted = Date.now();
  if (tsconfig.ok && vueFiles.length > 0) {
    const projectionStarted = Date.now();
    for (const file of vueFiles) {
      const result = projectVueFile({
        projectRoot: options.projectRoot,
        rootAbsolutePath: rootAbs,
        filePath: file.absolutePath,
        compilerOptions: tsconfig.options as ts.CompilerOptions,
      });
      if (result.ok) projections.push(result.projection);
      else {
        degraded.push('vue-projection-failed');
        vueErrors.push(`${result.error.path}: ${result.error.reason}`);
      }
    }
    emit(options, {
      type: 'vue',
      rootId: root.rootId,
      message: `${projections.length}/${vueFiles.length} SFCs projected in ${Date.now() - projectionStarted}ms`,
    });
    if (projections.length > 0) {
      try {
        shadow = writeShadowProject({
          projectRoot: options.projectRoot,
          rootAbsolutePath: rootAbs,
          tmpToken,
          projections,
          tsconfigFileNames: tsconfig.fileNames,
          compilerOptions: tsconfig.options as ts.CompilerOptions,
        });
        const scipStarted = Date.now();
        const run = await runScipIndex({
          projectRoot: options.projectRoot,
          rootPath: rootAbs,
          outputPath: path.join(shadow.shadowRoot, 'index.scip'),
          tsconfigPath: shadow.tsconfigPath,
        });
        const rawIndex = readScipIndex(run.indexPath);
        scipMs = Date.now() - scipStarted;
        const prefix = shadow.documentPrefix.replace(/\/+$/, '');
        const isShadowDocument = (documentPath: string): boolean =>
          documentPath === prefix || documentPath.startsWith(`${prefix}/`);
        const tsDocuments = rawIndex.documents.filter(
          (document) => !isShadowDocument(document.path),
        );
        shadowDocuments = rawIndex.documents.filter((document) => isShadowDocument(document.path));
        tsIndex = normalizeScipPaths({ ...rawIndex, documents: tsDocuments }, root.rootPath);
        const shadowProgram = ts.createProgram({
          rootNames: [...tsconfig.fileNames, ...shadow.shadowFiles],
          options: {
            ...(tsconfig.options as ts.CompilerOptions),
            allowArbitraryExtensions: true,
            noEmit: true,
            rootDirs: [
              shadow.shadowRoot,
              rootAbs,
              ...((tsconfig.options as ts.CompilerOptions).rootDirs ?? []),
            ],
          },
        });
        const collected = collectVueSymbols({
          program: shadowProgram,
          rootId: root.rootId,
          projections,
          shadowAbsoluteByProjectPath: shadow.shadowAbsoluteByProjectPath,
          shadowDocPathByProjectPath: shadow.shadowDocPathByProjectPath,
        });
        vueDeclarations = collected.declarations;
        vueComponentDrafts = collected.components;
        vueDeclarationFilteredInternal = collected.filteredInternal;
        vueFilteredByFile = collected.filteredInternalByFile;
        if (collected.errors.length > 0) {
          degraded.push('vue-projection-failed');
          for (const error of collected.errors) vueErrors.push(error);
        }
        emit(options, {
          type: 'vue',
          rootId: root.rootId,
          message: `${vueDeclarations.length} Vue declarations, ${vueComponentDrafts.length} components`,
        });
      } finally {
        shadow?.cleanup();
      }
    }
  } else if (vueFiles.length > 0) {
    degraded.push('vue-syntax-only');
  }
  // Phase 01 path: no usable SFC projection (or no `.vue` files) still needs the
  // TS/TSX SCIP index.
  if (tsIndex === null && tsconfig.ok) {
    const scipStarted = Date.now();
    const scipOutput = path.join(options.projectRoot, '.nexus', 'tmp', tmpToken, 'index.scip');
    const run = await runScipIndex({
      projectRoot: options.projectRoot,
      rootPath: rootAbs,
      outputPath: scipOutput,
    });
    tsIndex = normalizeScipPaths(readScipIndex(run.indexPath), root.rootPath);
    scipMs = Date.now() - scipStarted;
    emit(options, {
      type: 'scip',
      rootId: root.rootId,
      message: `${tsIndex.documents.length} documents in ${scipMs}ms`,
    });
  }
  const vueMs = Math.max(Date.now() - vueStarted - scipMs, 0);
  if (options.signal?.aborted) {
    throw nexusError('E20', 'build cancelled', {
      reason: 'abort signal received after semantic analysis',
      suggestion: 'Re-run update; the previous committed index is untouched.',
    });
  }

  const previous = toPreviousIdentities(
    readPreviousIdentities(databasePath(options.projectRoot, root.rootId)),
  );
  const allDeclarations = [...tsDeclarations, ...vueDeclarations];
  const { assignments, collisions } = assignIdentities(allDeclarations, root.rootId, previous);
  if (collisions > 0) degraded.push('hash-collisions');
  const vueDeclarationSet = new Set<DeclarationRecord>(vueDeclarations);
  const tsAssignments = assignments.filter(
    (assignment) => !vueDeclarationSet.has(assignment.declaration),
  );
  const vueAssignments = assignments.filter((assignment) =>
    vueDeclarationSet.has(assignment.declaration),
  );

  const mapStarted = Date.now();
  const tsMapping =
    tsIndex === null
      ? unmappedMapping(tsAssignments, tsconfig.ok ? 'no-scip-index' : 'syntax-only')
      : mapSymbolsAndReferences({
          index: tsIndex,
          assignments: tsAssignments,
          sourceFiles: sourceFileMap(program, rootAbs, options.projectRoot),
          buildId: '',
        });
  if (tsMapping.stats.conflict > 0) degraded.push('mapping-conflicts');
  if (tsIndex !== null && vueAssignments.length > 0 && shadowDocuments.length > 0) {
    const currentTsMapping = tsMapping;
    vueMapping = mapVueSymbolsAndReferences({
      buildId: '',
      projections,
      documents: shadowDocuments,
      assignments: vueAssignments,
      tsScipSymbolToSymbolId: currentTsMapping.scipSymbolToSymbolId,
      components: vueComponentDrafts,
    });
    if (vueMapping.stats.conflict > 0) degraded.push('vue-mapping-conflicts');
    if (vueMapping.stats.unmapped > 0) degraded.push('vue-unmapped');
  }
  const mapping = mergeMappings(tsMapping, vueMapping, collisions);
  const mapMs = Date.now() - mapStarted;
  const graphStarted = Date.now();
  const callerInfo =
    options.workspaceRoots?.find((entry) => entry.rootId === root.rootId) ??
    loadWorkspaceRootInfo({
      projectRoot: options.projectRoot,
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
    });
  const graph = buildGraph({
    projectRoot: options.projectRoot,
    rootAbs,
    rootId: root.rootId,
    rootPath: root.rootPath,
    files: scan.files,
    program: semanticProgram,
    checker,
    assignments,
    crossRoot: new CrossRootResolver({
      projectRoot: options.projectRoot,
      caller: callerInfo,
      roots: options.workspaceRoots ?? [],
    }),
    architecture: effective.architecture,
    style: {
      aliases: effective.style.aliases,
      extensions: effective.style.extensions,
    },
    coverage: {
      filesIgnored: scan.filesIgnored,
      filesSkippedBySize: scan.filesSkippedBySize,
      filesFailed: scan.filesFailed.map((entry) => entry.path),
      unmappedSymbols: mapping.stats.unmapped,
    },
    skipCalls: flags.disableCalls,
  });
  const graphMs = Date.now() - graphStarted;
  if (graph.warnings.length > 0) degraded.push('architecture-warnings');

  const vue = buildVueSummary({
    vueFiles: vueFiles.length,
    projections,
    declarations: vueDeclarations,
    components: vueComponentDrafts,
    vueMapping,
    declarationFilteredInternal: vueDeclarationFilteredInternal,
    errors: vueErrors,
  });
  const components: ComponentRecord[] = [];
  if (vueMapping !== null) {
    const assignmentByDeclaration = new Map<DeclarationRecord, IdentityAssignment>();
    for (const assignment of vueAssignments) {
      assignmentByDeclaration.set(assignment.declaration, assignment);
    }
    for (const draft of vueComponentDrafts) {
      const assignment = assignmentByDeclaration.get(draft.declaration);
      if (assignment === undefined) continue;
      components.push({
        symbolId: assignment.symbolId,
        name: draft.name,
        props: draft.props,
        emits: draft.emits,
        slots: draft.slots,
        propsCoverage: draft.propsCoverage,
        analysisEngine: draft.analysisEngine,
        source: draft.source,
      });
    }
  }
  const vueFileMeta: VueFileMetaRecord[] = projections.map((projection) => ({
    path: projection.path,
    sourceHash: projection.sourceHash,
    projectorVersion: projection.projectorVersion,
    languageCoreVersion: projection.languageCoreVersion,
    generatedBytes: projection.generatedBytes,
    generatedAt: startedAt,
    filteredInternal:
      (vueMapping?.perFile.get(projection.path)?.filteredInternal ?? 0) +
      (vueFilteredByFile.get(projection.path) ?? 0),
    templateEdges: vueMapping?.perFile.get(projection.path)?.templateEdges ?? 0,
  }));
  if (vueErrors.length > 0) {
    // Errors are already reflected by `vue-projection-failed`; keep a bounded
    // reason list in the manifest warnings only.
    degraded.push('vue-errors');
  }
  const rootPrefix =
    root.rootPath === '.' || root.rootPath === ''
      ? ''
      : `${root.rootPath.replace(/^\.\//, '').replace(/\/+$/, '')}/`;
  const rootRelativeFiles = scan.files.map((file) =>
    rootPrefix !== '' && file.path.startsWith(rootPrefix)
      ? file.path.slice(rootPrefix.length)
      : file.path,
  );
  let surface: SurfaceRootSnapshot;
  try {
    surface = buildSurface({
      projectRoot: options.projectRoot,
      rootAbs,
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      buildId: '',
      buildFingerprint: '',
      programs: program,
      files: rootRelativeFiles,
      symbols: mapping.symbols,
      components,
      config: effective.surface,
      moduleByPath: graph.moduleByPath,
    });
    if (surface.warnings.length > 0) {
      degraded.push('surface-warnings');
    }
  } catch (error) {
    degraded.push('surface-failed');
    surface = emptySurface(root, [
      `surface build failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return {
    scan,
    tsconfigOk: tsconfig.ok,
    assignments,
    collisions,
    mapping,
    vueMapping,
    vueDeclarationSet,
    components,
    vueFileMeta,
    surface,
    graph,
    vue,
    degraded: [...new Set(degraded)].sort(),
    timings: {
      scanMs,
      analyzeMs: Date.now() - analyzeStarted,
      vueMs: Math.max(vueMs, 0),
      scipMs,
      mapMs,
      graphMs,
    },
  };
}

interface BuildRootOutcome {
  rootId: string;
  ok: true;
  buildId: string;
  buildFingerprint: string;
  files: number;
  symbols: number;
  references: number;
  dependencies: number;
  calls: number;
  tests: number;
  coverage: RootManifest['coverage'];
  vue: VueAnalysisSummary;
  degraded: string[];
  peakRssMB: number;
  mode: 'full' | 'incremental';
  changed: RootManifest['changed'];
  invalidatedFiles: string[];
}

function coverageOf(analysis: RootAnalysis): RootManifest['coverage'] {
  const resolved = analysis.mapping.references.filter(
    (reference) => reference.relationClass === 'certain',
  ).length;
  const unresolved = analysis.mapping.references.filter(
    (reference) => reference.relationClass !== 'certain',
  ).length;
  const eligible = analysis.mapping.stats.eligible;
  return {
    filesCovered: analysis.scan.files.length,
    filesSkipped: analysis.scan.outsideRoot.length,
    filesIgnored: analysis.scan.filesIgnored,
    filesFailed: analysis.scan.filesFailed.length,
    resolved,
    unresolved,
    unmapped: analysis.mapping.stats.unmapped,
    filteredInternal: analysis.vue.filteredInternal,
    semanticCoverage:
      analysis.tsconfigOk && eligible > 0 ? analysis.mapping.stats.mappingSuccessRate : null,
    filesSkippedBySize: analysis.scan.filesSkippedBySize,
    filesOutsideRoot: analysis.scan.outsideRoot.length,
    hashCollisions: analysis.collisions,
    styleFiles: analysis.graph.stats.style.files,
    styleEdges: analysis.graph.stats.style.edges,
    styleResolved: analysis.graph.stats.style.resolved,
    styleUnresolved: analysis.graph.stats.style.unresolved,
    dependencies: analysis.graph.dependencies.length,
    calls: analysis.graph.calls.length,
    crossRootEdges: analysis.graph.stats.crossRootEdges,
    architectureViolations: analysis.graph.architectureViolations.length,
  };
}

function configLoads(projectRoot: string, loaded: LoadedConfig): RootManifest['configLoads'] {
  if (loaded.sourcePath === null || loaded.contentHash === null) return [];
  return [
    {
      path: relativePosix(projectRoot, loaded.sourcePath),
      contentHash: loaded.contentHash,
      authorization: loaded.authorization,
      durationMs: loaded.loadDurationMs,
      result: 'ok',
    },
  ];
}

async function buildRoot(input: {
  root: RootCandidate;
  effective: EffectiveRootConfig;
  options: BuildOptions;
  sqliteVersion: string;
  rootSetHash: string;
  startedAt: string;
  mode: 'full' | 'incremental';
  changePlan: RootChangePlan | null;
  flags: DegradationFlags;
  gitCommit: string | null;
}): Promise<BuildRootOutcome> {
  const { root, options, sqliteVersion, rootSetHash, startedAt, mode, changePlan, flags } = input;
  const projectRoot = options.projectRoot;
  recoverPending(databasePath(projectRoot, root.rootId));
  beginIndexing(projectRoot, root.rootId, 'scan');
  const sampler = memorySampler();
  const totalStarted = Date.now();
  const tmpToken = `${root.rootId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  try {
    if (options.signal?.aborted) {
      throw nexusError('E20', 'build cancelled', {
        reason: 'abort signal received before analysis',
        suggestion: 'Re-run update when the interruption is over; the previous index is intact.',
      });
    }
    updateIndexingPhase(projectRoot, root.rootId, 'analyze');
    const analysis = await analyzeRoot(root, input.effective, options, tmpToken, startedAt, flags);
    updateIndexingPhase(projectRoot, root.rootId, 'write');
    const degraded = [...new Set(analysis.degraded)].sort();
    if (flags.disableCalls) degraded.push('calls-off');
    if (flags.chunked) degraded.push('chunked');
    if (flags.reduceVueProjection) degraded.push('vue-projection-reduced');
    const sortedDegraded = [...new Set(degraded)].sort();
    const tsconfigHash = computeTsconfigHash(
      root.absolutePath,
      root.tsconfigRelativePath ?? `${root.rootPath}/tsconfig.json`,
    );
    const fields: BuildFingerprintFields = {
      filesHash: filesHash(analysis.scan.files),
      configHash: input.effective.configHash,
      tsconfigHash,
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      rootSetHash,
      nodeVersion: process.versions.node,
      sqliteVersion,
      platform: platformId(),
      degraded: sortedDegraded,
    };
    const buildFingerprint = computeBuildFingerprint(fields);
    const buildId = `b_${buildFingerprint.slice(3, 11)}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const coverage = coverageOf(analysis);
    const writeStarted = Date.now();
    emit(options, {
      type: 'write',
      rootId: root.rootId,
      message: `${analysis.mapping.symbols.length} symbols, ${analysis.mapping.references.length} references`,
    });
    const committed = commitBuild({
      dbPath: databasePath(projectRoot, root.rootId),
      rootId: root.rootId,
      buildId,
      buildFingerprint,
      startedAt,
      finishedAt: new Date().toISOString(),
      fields,
      files: analysis.scan.files,
      symbols: drain(analysis.mapping.symbols),
      references: withBuildId(drain(analysis.mapping.references), buildId),
      dependencies: analysis.graph.dependencies,
      calls: analysis.graph.calls,
      architectureModules: analysis.graph.architectureModules,
      architectureViolations: analysis.graph.architectureViolations,
      mappingRows: mappingRows({
        assignments: analysis.assignments,
        vueDeclarationSet: analysis.vueDeclarationSet,
        vueMapping: analysis.vueMapping,
      }),
      components: analysis.components,
      vueFileMeta: analysis.vueFileMeta,
    });
    const surface = {
      ...analysis.surface,
      buildId,
      buildFingerprint,
      warnings: [...analysis.surface.warnings],
    };
    crashPoint('after-flip-before-manifest');
    const writeMs = Date.now() - writeStarted;
    const builtAt = new Date().toISOString();
    const sizes = dbSizes(databasePath(projectRoot, root.rootId));
    const peakRssMB = sampler.stop();
    const byType: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    for (const dependency of analysis.graph.dependencies) {
      byType[dependency.depType] = (byType[dependency.depType] ?? 0) + 1;
      byConfidence[dependency.confidence] = (byConfidence[dependency.confidence] ?? 0) + 1;
    }
    for (const call of analysis.graph.calls) {
      byType.call = (byType.call ?? 0) + 1;
      byConfidence[call.confidence] = (byConfidence[call.confidence] ?? 0) + 1;
    }
    const manifest: RootManifest = {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: 2,
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      tsconfig: root.tsconfigRelativePath,
      buildId,
      buildFingerprint,
      filesHash: fields.filesHash,
      configHash: input.effective.configHash,
      tsconfigHash,
      tsconfigMtimeMs: tsconfigStat(root.absolutePath).mtimeMs,
      tsconfigSize: tsconfigStat(root.absolutePath).size,
      statHash: statHash(analysis.scan.files),
      rootSetHash,
      ignoreHash: input.effective.ignoreHash,
      analyzerVersion: ANALYZER_VERSION,
      nodeVersion: process.versions.node,
      sqliteVersion,
      platform: platformId(),
      state: 'ready',
      staleness: 'fresh',
      counts: {
        files: committed.counts.files,
        symbols: committed.counts.symbols,
        references: committed.counts.references,
        unresolvedReferences: coverage.unresolved,
        dependencies: committed.counts.dependencies,
        calls: committed.counts.calls,
        tests: committed.counts.tests,
      },
      coverage,
      graph: {
        dependencies: analysis.graph.dependencies.length,
        calls: analysis.graph.calls.length,
        tests: committed.counts.tests,
        styleEdges: analysis.graph.stats.style.edges,
        crossRootEdges: analysis.graph.stats.crossRootEdges,
        architectureViolations: analysis.graph.architectureViolations.length,
        byConfidence,
        byType,
      },
      blindSpots: analysis.graph.blindSpots,
      vue: analysis.vue,
      stats: {
        exact: analysis.mapping.stats.exact,
        structural: analysis.mapping.stats.structural,
        conflict: analysis.mapping.stats.conflict,
        unmapped: analysis.mapping.stats.unmapped,
        externalReferences: analysis.mapping.externalReferences,
        localOrUnmappedReferences: analysis.mapping.localOrUnmappedReferences,
        mappingSuccessRate: analysis.mapping.stats.mappingSuccessRate,
        falseMatchCount: analysis.mapping.stats.falseMatchCount,
      },
      timings: {
        scanMs: analysis.timings.scanMs,
        analyzeMs: analysis.timings.analyzeMs,
        vueMs: analysis.timings.vueMs,
        scipMs: analysis.timings.scipMs,
        mapMs: analysis.timings.mapMs,
        graphMs: analysis.timings.graphMs,
        writeMs,
        writeBatches: committed.writeBatches,
        totalMs: Date.now() - totalStarted,
      },
      memory: {
        peakRssMB,
        scipPeakRssMB: null,
        scipPeakRssUnavailableReason:
          'SCIP runs in a child process; child RSS sampling is not provided in Phase 01/02/03',
      },
      dbBytes: sizes.dbBytes,
      walBytes: sizes.walBytes,
      surfaceHash: surface.surfaceHash,
      surfaceEntries: surface.entries.length,
      degraded: sortedDegraded,
      warnings: [
        ...sortedDegraded.map((entry) => ({
          code: entry === 'syntax-only' ? 'E03' : entry.startsWith('vue') ? 'E11' : 'E11',
          message: `degraded: ${entry}`,
          severity: 'warning' as const,
        })),
        ...surface.warnings.map((message) => ({
          code: 'E11' as const,
          message: `surface: ${message}`,
          severity: 'warning' as const,
        })),
      ],
      configLoads: configLoads(projectRoot, options.loadedConfig),
      gitCommit: input.gitCommit,
      mode,
      changed:
        changePlan === null
          ? undefined
          : {
              ...changePlan.counts,
              reasons: changePlan.reasons,
              files: changePlan.files.slice(0, 50).map((entry) => entry.path),
            },
      invalidatedFiles: changePlan?.invalidatedFiles.slice(0, 200) ?? [],
      lastIntegrityCheck:
        readManifest(manifestPath(projectRoot, root.rootId)).manifest?.lastIntegrityCheck ?? null,
      recoveryEvents:
        readManifest(manifestPath(projectRoot, root.rootId)).manifest?.recoveryEvents ?? [],
      recovered: false,
      resources: options.resourceInfo,
      builtAt,
      lastSuccessAt: builtAt,
      lastFailureAt: null,
      lastFailureCode: null,
    };
    writeManifestAtomic(manifestPath(projectRoot, root.rootId), manifest);
    crashPoint('after-manifest-before-surface');
    writeSurface(projectRoot, surface);
    crashPoint('after-surface-before-workspace');
    fs.rmSync(path.join(projectRoot, '.nexus', 'tmp', tmpToken), { recursive: true, force: true });
    return {
      rootId: root.rootId,
      ok: true,
      buildId,
      buildFingerprint,
      files: committed.counts.files,
      symbols: committed.counts.symbols,
      references: committed.counts.references,
      dependencies: committed.counts.dependencies,
      calls: committed.counts.calls,
      tests: committed.counts.tests,
      coverage,
      vue: analysis.vue,
      degraded: sortedDegraded,
      peakRssMB,
      mode,
      changed:
        changePlan === null
          ? { added: 0, modified: 0, deleted: 0, renamed: 0, total: 0, reasons: ['full-build'] }
          : { ...changePlan.counts, reasons: changePlan.reasons },
      invalidatedFiles: changePlan?.invalidatedFiles ?? [],
    };
  } catch (error) {
    sampler.stop();
    fs.rmSync(path.join(projectRoot, '.nexus', 'tmp', tmpToken), { recursive: true, force: true });
    throw error;
  } finally {
    endIndexing(projectRoot, root.rootId);
  }
}

function zerosCoverage(): RootManifest['coverage'] {
  return {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
    semanticCoverage: null,
    filesSkippedBySize: 0,
    filesOutsideRoot: 0,
    hashCollisions: 0,
  };
}

function recordFailure(
  projectRoot: string,
  root: RootCandidate,
  error: ReturnType<typeof mapUnknownError>,
  startedAtMs: number,
): void {
  const manifestFile = manifestPath(projectRoot, root.rootId);
  const existing = readManifest(manifestFile).manifest;
  const now = new Date().toISOString();
  const base: RootManifest = existing ?? {
    schemaVersion: SCHEMA_VERSION,
    indexVersion: 2,
    rootId: root.rootId,
    rootPath: root.rootPath,
    packageName: root.packageName,
    tsconfig: root.tsconfigRelativePath,
    buildId: '',
    buildFingerprint: '',
    filesHash: '',
    configHash: '',
    rootSetHash: '',
    ignoreHash: '',
    analyzerVersion: ANALYZER_VERSION,
    nodeVersion: process.versions.node,
    sqliteVersion: '',
    platform: platformId(),
    state: 'failed',
    staleness: 'failed',
    counts: { files: 0, symbols: 0, references: 0, unresolvedReferences: 0, tests: 0 },
    coverage: zerosCoverage(),
    vue: zeroVueSummary(0),
    stats: {
      exact: 0,
      structural: 0,
      conflict: 0,
      unmapped: 0,
      externalReferences: 0,
      localOrUnmappedReferences: 0,
      mappingSuccessRate: 0,
      falseMatchCount: 0,
    },
    timings: {
      scanMs: 0,
      analyzeMs: 0,
      vueMs: 0,
      scipMs: 0,
      mapMs: 0,
      writeMs: 0,
      writeBatches: 0,
      totalMs: 0,
    },
    memory: { peakRssMB: 0, scipPeakRssMB: null, scipPeakRssUnavailableReason: null },
    dbBytes: 0,
    walBytes: 0,
    degraded: [],
    warnings: [],
    configLoads: [],
    builtAt: now,
    lastSuccessAt: '',
    lastFailureAt: now,
    lastFailureCode: error.code,
  };
  const failure: RootManifest = {
    ...base,
    state: existing === null ? 'failed' : 'stale',
    staleness: existing === null ? 'failed' : 'stale',
    lastFailureAt: now,
    lastFailureCode: error.code,
    warnings: [
      ...base.warnings.filter((warning) => warning.message !== `last failure ${error.code}`),
      { code: error.code, message: error.reason, severity: 'warning' as const },
    ],
  };
  try {
    writeManifestAtomic(manifestFile, failure);
  } catch {
    // The original index and manifest remain authoritative; status reports the
    // missing manifest as a diagnosable state instead of crashing.
  }
  void startedAtMs;
}

function scanFilesForChange(
  projectRoot: string,
  root: RootCandidate,
  effective: EffectiveRootConfig,
): ScannedFile[] {
  const tsconfig = readTsconfig(
    root.absolutePath,
    root.tsconfigRelativePath ?? `${root.rootPath}/tsconfig.json`,
  );
  const ignore = new IgnoreMatcher(effective.ignore);
  return scanFiles({
    projectRoot,
    rootPath: root.absolutePath,
    absoluteRoot: root.absolutePath,
    ignore,
    tsconfigFileNames: tsconfig.ok ? tsconfig.fileNames : undefined,
  }).files;
}

function skippedResult(
  root: RootCandidate,
  manifest: RootManifest | null,
  durationMs: number,
): RootBuildResult {
  return {
    rootId: root.rootId,
    ok: true,
    buildId: manifest?.buildId ?? null,
    buildFingerprint: manifest?.buildFingerprint ?? null,
    files: manifest?.counts.files ?? 0,
    symbols: manifest?.counts.symbols ?? 0,
    references: manifest?.counts.references ?? 0,
    dependencies: manifest?.counts.dependencies ?? 0,
    calls: manifest?.counts.calls ?? 0,
    tests: manifest?.counts.tests ?? 0,
    durationMs,
    errorCode: null,
    errorMessage: null,
    coverage: manifest?.coverage ?? null,
    vue: manifest?.vue,
    degraded: manifest?.degraded ?? [],
    mode: 'fresh',
    skipped: true,
    changed: { added: 0, modified: 0, deleted: 0, renamed: 0, total: 0, reasons: [] },
    peakRssMB: 0,
    degradedStages: [],
    invalidatedFiles: [],
  };
}

export async function buildWorkspace(options: BuildOptions): Promise<BuildResult> {
  const config = options.loadedConfig.config;
  if (config === null) {
    throw nexusError('E17', 'configuration is missing', {
      reason: 'no .nexus/nexus.config.json found',
      suggestion: 'Run `nex init --yes` first, then `nex build`.',
    });
  }
  const projectRoot = path.resolve(options.projectRoot);
  const mode = options.mode ?? 'build';

  // 12.3.3: recovery runs before any scan/write, and before queries (the query
  // layer calls the same function).
  const recovery = recoverWorkspace(projectRoot);

  const selected = config.workspaces.roots.length > 0 ? config.workspaces.roots : undefined;
  const discovery = discoverRoots({
    projectRoot,
    selectedRootIds: selected,
    configSource: 'configuration',
    exclude: config.workspaces.exclude,
  });
  const effectiveConfigs = discovery.roots.map((root) =>
    resolveRootConfig(config, root.rootId, config.roots[root.rootId]),
  );
  const rootSetHash = computeRootSetHash(
    discovery.roots.map((root, index) => ({
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      configHash: effectiveConfigs[index]?.configHash ?? '',
    })),
  );
  const sqliteProbe = probeSqlite();
  if (!sqliteProbe.ok) {
    throw nexusError('E14', 'node:sqlite is not usable', {
      reason: sqliteProbe.reason,
      suggestion: 'Run on Node >= 22.16.0; no fallback SQLite driver is provided.',
      evidence: { nodeVersion: process.versions.node },
    });
  }

  const workspaceRoots: WorkspaceRootInfo[] = discovery.roots.map((root) =>
    loadWorkspaceRootInfo({
      projectRoot,
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
    }),
  );
  const buildOptions: BuildOptions = { ...options, workspaceRoots };

  let roots = [...discovery.roots];
  if (options.selectedRootIds !== undefined && options.selectedRootIds.length > 0) {
    const wanted = new Set(options.selectedRootIds);
    roots = roots.filter((root) => wanted.has(root.rootId));
    if (roots.length === 0) {
      throw nexusError('E16', 'selected roots are not part of this workspace', {
        reason: `none of ${[...wanted].join(', ')} is a known root`,
        suggestion: 'Run `nex status` and pass --root/--roots with a known rootId.',
      });
    }
  }
  const effectiveByRoot = new Map(
    discovery.roots.map((root, index) => [
      root.rootId,
      effectiveConfigs[index] as EffectiveRootConfig,
    ]),
  );

  const initialManifests = new Map(
    discovery.roots.map((root) => [
      root.rootId,
      readManifest(manifestPath(projectRoot, root.rootId)).manifest,
    ]),
  );
  reconcileWorkspace({
    projectRoot,
    roots: discovery.roots,
    effective: effectiveConfigs,
    rootSetHash,
    manifests: initialManifests,
  });

  // 5.10: budget, weights, dependency order and the degradation ladder.
  const previousPeaks = new Map<string, number>();
  for (const [rootId, manifest] of initialManifests) {
    if (manifest !== null && manifest.memory.peakRssMB > 0) {
      previousPeaks.set(rootId, manifest.memory.peakRssMB);
    }
  }
  const resourceConfig = {
    ...config.defaults.resources,
    concurrency: options.serial === true ? 1 : config.defaults.resources.concurrency,
  };
  const previousPeakValues = [...previousPeaks.values()];
  const estimatedPeakMB =
    previousPeakValues.length === 0
      ? undefined
      : Math.round(
          previousPeakValues.reduce((sum, value) => sum + value, 0) / previousPeakValues.length,
        );
  const budget = computeResourceBudget({
    config: resourceConfig,
    rootCount: roots.length,
    estimatedPeakMB: options.budgetMB ?? estimatedPeakMB,
  });
  const weights = computeRootWeights({
    roots,
    previousPeakMB: previousPeaks,
    globalBudgetMB: budget.globalBudgetMB,
  });
  const coordinator = new GlobalResourceCoordinator({
    budget,
    weights,
    onEvent: (event) => {
      emit(options, {
        type: 'write',
        rootId: '',
        message: `degraded ${event.stage}: ${event.reason} (peak ${event.peakMB}MB / budget ${event.budgetMB}MB)`,
      });
    },
  });
  const ordered = orderRootsByDependencies(roots);
  const gitCommit = headCommit(projectRoot);

  clearTmp(projectRoot);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sampler = memorySampler();
  const resultsByRoot = new Map<string, RootBuildResult>();
  let cancelled = false;

  for (const root of ordered) {
    const effective = effectiveByRoot.get(root.rootId) as EffectiveRootConfig;
    const rootStarted = Date.now();
    if (options.signal?.aborted) {
      cancelled = true;
      resultsByRoot.set(root.rootId, {
        rootId: root.rootId,
        ok: false,
        buildId: null,
        buildFingerprint: null,
        files: 0,
        symbols: 0,
        references: 0,
        durationMs: 0,
        errorCode: 'E20',
        errorMessage: 'build cancelled',
        coverage: null,
        degraded: [],
        mode: 'full',
        peakRssMB: 0,
        degradedStages: [],
        invalidatedFiles: [],
      });
      continue;
    }
    emit(options, { type: 'root-start', rootId: root.rootId, message: root.rootPath });

    let plan: RootChangePlan | null = null;
    if (mode === 'update') {
      const currentFiles = scanFilesForChange(projectRoot, root, effective);
      plan = planRootChange(
        {
          rootId: root.rootId,
          previousManifest: initialManifests.get(root.rootId) ?? null,
          currentFiles,
          currentConfigHash: effective.configHash,
          currentTsconfigHash: computeTsconfigHash(
            root.absolutePath,
            root.tsconfigRelativePath ?? `${root.rootPath}/tsconfig.json`,
          ),
          currentIgnoreHash: effective.ignoreHash,
          currentRootSetHash: rootSetHash,
          forceFull: options.forceFull === true,
          forcedGlobs: options.forcedGlobs,
        },
        projectRoot,
      );
      if (plan.mode === 'fresh') {
        resultsByRoot.set(
          root.rootId,
          skippedResult(root, initialManifests.get(root.rootId) ?? null, Date.now() - rootStarted),
        );
        emit(options, {
          type: 'root-done',
          rootId: root.rootId,
          message: 'fresh (no changes)',
        });
        continue;
      }
    }

    const flags = coordinator.flags();
    if (flags.abort) {
      resultsByRoot.set(root.rootId, {
        rootId: root.rootId,
        ok: false,
        buildId: null,
        buildFingerprint: null,
        files: 0,
        symbols: 0,
        references: 0,
        durationMs: Date.now() - rootStarted,
        errorCode: 'E20',
        errorMessage: 'aborted by resource coordinator',
        coverage: null,
        degraded: coordinator.currentStages(),
        mode: plan?.mode === 'full' ? 'full' : 'incremental',
        peakRssMB: 0,
        degradedStages: coordinator.currentStages(),
        invalidatedFiles: plan?.invalidatedFiles ?? [],
      });
      continue;
    }

    try {
      buildOptions.resourceInfo = coordinator.resourceSummary();
      const outcome = await withRootLock(rootDirectory(projectRoot, root.rootId), async () =>
        buildRoot({
          root,
          effective,
          options: buildOptions,
          sqliteVersion: sqliteProbe.version,
          rootSetHash,
          startedAt,
          mode: plan?.mode === 'full' ? 'full' : mode === 'update' ? 'incremental' : 'full',
          changePlan: plan,
          flags,
          gitCommit,
        }),
      );
      const observed = coordinator.observePeak(root.rootId, outcome.peakRssMB);
      resultsByRoot.set(root.rootId, {
        ...outcome,
        durationMs: Date.now() - rootStarted,
        errorCode: null,
        errorMessage: null,
        degradedStages: coordinator.currentStages(),
      });
      emit(options, {
        type: 'root-done',
        rootId: root.rootId,
        message: `${outcome.symbols} symbols, ${outcome.references} references${observed.degraded ? `; degraded ${observed.stage}` : ''}`,
      });
    } catch (error) {
      const nexus = mapUnknownError(error);
      recordFailure(projectRoot, root, nexus, rootStarted);
      resultsByRoot.set(root.rootId, {
        rootId: root.rootId,
        ok: false,
        buildId: null,
        buildFingerprint: null,
        files: 0,
        symbols: 0,
        references: 0,
        durationMs: Date.now() - rootStarted,
        errorCode: nexus.code,
        errorMessage: nexus.reason,
        coverage: null,
        degraded: coordinator.currentStages(),
        mode: plan?.mode === 'full' ? 'full' : 'incremental',
        peakRssMB: 0,
        degradedStages: coordinator.currentStages(),
        invalidatedFiles: plan?.invalidatedFiles ?? [],
      });
      emit(options, {
        type: 'root-failed',
        rootId: root.rootId,
        message: `${nexus.code}: ${nexus.reason}`,
      });
      if (nexus.code === 'E20') cancelled = true;
    }
  }

  const results = discovery.roots
    .filter((root) => resultsByRoot.has(root.rootId))
    .map((root) => resultsByRoot.get(root.rootId) as RootBuildResult);
  // A root that was not selected is not part of this command's result set.
  const finalPeakRssMB = sampler.stop();
  const totalMs = Date.now() - startedMs;

  if (!cancelled) {
    const finalManifests = new Map(
      discovery.roots.map((root) => [
        root.rootId,
        readManifest(manifestPath(projectRoot, root.rootId)).manifest,
      ]),
    );
    writeWorkspaceAtomic(projectRoot, {
      ...buildWorkspaceSnapshot({
        roots: discovery.roots,
        effective: effectiveConfigs,
        rootSetHash,
        manifests: finalManifests,
      }),
      updatedAt: new Date().toISOString(),
    });
    crashPoint('workspace-before-cleanup');
  }

  emit(options, {
    type: 'workspace-done',
    rootId: '',
    message: `${results.filter((result) => result.ok).length}/${results.length} roots ok in ${totalMs}ms, peak RSS ${finalPeakRssMB}MB`,
  });
  clearTmp(projectRoot);
  return {
    roots: results,
    failedRoots: results.filter((result) => !result.ok).map((result) => result.rootId),
    totalMs,
    resources: coordinator.resourceSummary(),
    recovery: { repaired: recovery.repaired, invalid: recovery.invalid },
  };
}
