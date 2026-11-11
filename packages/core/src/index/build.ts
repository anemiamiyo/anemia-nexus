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
import { scanFiles, filesHash, type ScanResult } from '../discovery/scan.js';
import { readTsconfig } from '../discovery/tsconfig.js';
import { ANALYZER_VERSION } from './analyzer.js';
import { collectDeclarations, createSyntaxProgram } from './declarations.js';
import type { DeclarationRecord } from '../model.js';
import {
  assignIdentities,
  mapSymbolsAndReferences,
  symbolsFromAssignments,
  locatorKey,
  type IdentityAssignment,
  type MappingResult,
  type PreviousIdentity,
} from './mapping.js';
import {
  computeBuildFingerprint,
  computeRootSetHash,
  platformId,
  SCHEMA_VERSION,
  type BuildFingerprintFields,
} from './fingerprint.js';
import { readScipIndex, runScipIndex, type ScipIndexData } from './scip.js';
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

export interface BuildProgressEvent {
  type: 'root-start' | 'scan' | 'scip' | 'write' | 'root-done' | 'root-failed' | 'workspace-done';
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
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  coverage: RootManifest['coverage'] | null;
  degraded: string[];
}

export interface BuildResult {
  roots: RootBuildResult[];
  failedRoots: string[];
  totalMs: number;
}

export interface BuildOptions {
  projectRoot: string;
  loadedConfig: LoadedConfig;
  onProgress?: (event: BuildProgressEvent) => void;
  serial?: boolean;
}

interface RootAnalysis {
  scan: ScanResult;
  tsconfigOk: boolean;
  assignments: IdentityAssignment[];
  collisions: number;
  index: ScipIndexData | null;
  mapping: MappingResult;
  degraded: string[];
  timings: { scanMs: number; analyzeMs: number; scipMs: number; mapMs: number };
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

function mappingRows(
  assignments: readonly IdentityAssignment[],
  mapping: MappingResult,
): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const assignment of assignments) {
    const scipSymbol = mapping.scipSymbolBySymbolId.get(assignment.symbolId) ?? null;
    rows.push({
      symbolId: assignment.symbolId,
      engine: 'scip',
      engineRef: scipSymbol ?? '',
      matchQuality: assignment.mappingQuality,
      evidence: {
        anchor: `${assignment.declaration.path}:${assignment.declaration.nameLine}:${assignment.declaration.nameCol}`,
        descriptor: scipSymbol === null ? '' : scipSymbol.slice(-160),
      },
      analyzerVersion: ANALYZER_VERSION.scip,
    });
    rows.push({
      symbolId: assignment.symbolId,
      engine: 'ts',
      engineRef: locatorKey(assignment.declaration),
      matchQuality: assignment.mappingQuality,
      evidence: { kind: assignment.declaration.kind, nameChain: assignment.declaration.nameChain },
      analyzerVersion: ANALYZER_VERSION.typescript,
    });
  }
  return rows;
}

async function analyzeRoot(
  root: RootCandidate,
  effective: EffectiveRootConfig,
  options: BuildOptions,
  tmpToken: string,
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
  emit(options, {
    type: 'scan',
    rootId: root.rootId,
    message: `${scan.files.length} TS/TSX files (${scan.filesIgnored} ignored, ${scan.filesFailed.length} failed)`,
  });

  const analyzeStarted = Date.now();
  const scannedNames = new Set(scan.files.map((file) => file.absolutePath));
  const fileNames = tsconfig.ok
    ? tsconfig.fileNames.filter((fileName) => scannedNames.has(path.resolve(fileName)))
    : scan.files.map((file) => file.absolutePath);
  const program = createSyntaxProgram(fileNames, tsconfig.options);
  const declarations: DeclarationRecord[] = collectDeclarations(
    program,
    rootAbs,
    options.projectRoot,
    root.rootId,
  );
  const previous = toPreviousIdentities(
    readPreviousIdentities(databasePath(options.projectRoot, root.rootId)),
  );
  const { assignments, collisions } = assignIdentities(declarations, root.rootId, previous);
  const analyzeMs = Date.now() - analyzeStarted;
  if (collisions > 0) degraded.push('hash-collisions');

  let index: ScipIndexData | null = null;
  let scipMs = 0;
  if (tsconfig.ok) {
    const scipStarted = Date.now();
    const scipOutput = path.join(options.projectRoot, '.nexus', 'tmp', tmpToken, 'index.scip');
    const run = await runScipIndex({
      projectRoot: options.projectRoot,
      rootPath: rootAbs,
      outputPath: scipOutput,
    });
    index = normalizeScipPaths(readScipIndex(run.indexPath), root.rootPath);
    scipMs = Date.now() - scipStarted;
    emit(options, {
      type: 'scip',
      rootId: root.rootId,
      message: `${index.documents.length} documents in ${scipMs}ms`,
    });
  }

  const mapStarted = Date.now();
  const mapping: MappingResult =
    index === null
      ? {
          symbols: symbolsFromAssignments(assignments, 'unmapped'),
          references: [],
          scipSymbolBySymbolId: new Map(
            assignments.map((assignment) => [assignment.symbolId, null]),
          ),
          stats: {
            eligible: assignments.length,
            exact: 0,
            structural: 0,
            conflict: 0,
            ambiguous: 0,
            unmapped: assignments.length,
            mappingSuccessRate: 0,
            falseMatchCount: 0,
            collisions,
          },
          unmappedReasonCounts: { 'syntax-only': assignments.length },
          externalReferences: 0,
          localOrUnmappedReferences: 0,
        }
      : mapSymbolsAndReferences({
          index,
          assignments,
          sourceFiles: sourceFileMap(program, rootAbs, options.projectRoot),
          buildId: '',
        });
  const mapMs = Date.now() - mapStarted;
  if (mapping.stats.conflict > 0) degraded.push('mapping-conflicts');

  return {
    scan,
    tsconfigOk: tsconfig.ok,
    assignments,
    collisions,
    index,
    mapping,
    degraded,
    timings: { scanMs, analyzeMs, scipMs, mapMs },
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
  coverage: RootManifest['coverage'];
  degraded: string[];
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
    semanticCoverage:
      analysis.tsconfigOk && eligible > 0 ? analysis.mapping.stats.mappingSuccessRate : null,
    filesSkippedBySize: analysis.scan.filesSkippedBySize,
    filesOutsideRoot: analysis.scan.outsideRoot.length,
    hashCollisions: analysis.collisions,
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
}): Promise<BuildRootOutcome> {
  const { root, options, sqliteVersion, rootSetHash, startedAt } = input;
  const projectRoot = options.projectRoot;
  recoverPending(databasePath(projectRoot, root.rootId));
  const sampler = memorySampler();
  const totalStarted = Date.now();
  const tmpToken = `${root.rootId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  try {
    const analysis = await analyzeRoot(root, input.effective, options, tmpToken);
    const degraded = [...new Set(analysis.degraded)].sort();
    const fields: BuildFingerprintFields = {
      filesHash: filesHash(analysis.scan.files),
      configHash: input.effective.configHash,
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      rootSetHash,
      nodeVersion: process.versions.node,
      sqliteVersion,
      platform: platformId(),
      degraded,
    };
    const buildFingerprint = computeBuildFingerprint(fields);
    const buildId = `b_${buildFingerprint.slice(3, 11)}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const references = analysis.mapping.references.map((reference) => ({
      ...reference,
      buildId,
    }));
    const writeStarted = Date.now();
    emit(options, {
      type: 'write',
      rootId: root.rootId,
      message: `${analysis.mapping.symbols.length} symbols, ${references.length} references`,
    });
    commitBuild({
      dbPath: databasePath(projectRoot, root.rootId),
      rootId: root.rootId,
      buildId,
      buildFingerprint,
      startedAt,
      finishedAt: new Date().toISOString(),
      fields,
      files: analysis.scan.files,
      symbols: analysis.mapping.symbols,
      references,
      mappingRows: mappingRows(analysis.assignments, analysis.mapping),
    });
    const writeMs = Date.now() - writeStarted;
    const builtAt = new Date().toISOString();
    const sizes = dbSizes(databasePath(projectRoot, root.rootId));
    const peakRssMB = sampler.stop();
    const coverage = coverageOf(analysis);
    const manifest: RootManifest = {
      schemaVersion: SCHEMA_VERSION,
      indexVersion: 1,
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      tsconfig: root.tsconfigRelativePath,
      buildId,
      buildFingerprint,
      filesHash: fields.filesHash,
      configHash: input.effective.configHash,
      rootSetHash,
      ignoreHash: input.effective.ignoreHash,
      analyzerVersion: ANALYZER_VERSION,
      nodeVersion: process.versions.node,
      sqliteVersion,
      platform: platformId(),
      state: 'ready',
      staleness: 'fresh',
      counts: {
        files: analysis.scan.files.length,
        symbols: analysis.mapping.symbols.length,
        references: references.length,
        unresolvedReferences: coverage.unresolved,
      },
      coverage,
      stats: {
        exact: analysis.mapping.stats.exact,
        structural: analysis.mapping.stats.structural,
        conflict: analysis.mapping.stats.conflict,
        unmapped: analysis.mapping.stats.unmapped,
        externalReferences: analysis.mapping.externalReferences,
        localOrUnmappedReferences: analysis.mapping.localOrUnmappedReferences,
        mappingSuccessRate: analysis.mapping.stats.mappingSuccessRate,
      },
      timings: {
        scanMs: analysis.timings.scanMs,
        analyzeMs: analysis.timings.analyzeMs,
        scipMs: analysis.timings.scipMs,
        mapMs: analysis.timings.mapMs,
        writeMs,
        totalMs: Date.now() - totalStarted,
      },
      memory: {
        peakRssMB,
        scipPeakRssMB: null,
        scipPeakRssUnavailableReason:
          'SCIP runs in a child process; child RSS sampling is not available in Phase 01',
      },
      dbBytes: sizes.dbBytes,
      walBytes: sizes.walBytes,
      degraded,
      warnings: degraded.map((entry) => ({
        code: entry === 'syntax-only' ? 'E03' : 'E11',
        message: `degraded: ${entry}`,
        severity: 'warning' as const,
      })),
      configLoads: configLoads(projectRoot, options.loadedConfig),
      builtAt,
      lastSuccessAt: builtAt,
      lastFailureAt: null,
      lastFailureCode: null,
    };
    writeManifestAtomic(manifestPath(projectRoot, root.rootId), manifest);
    fs.rmSync(path.join(projectRoot, '.nexus', 'tmp', tmpToken), { recursive: true, force: true });
    return {
      rootId: root.rootId,
      ok: true,
      buildId,
      buildFingerprint,
      files: analysis.scan.files.length,
      symbols: analysis.mapping.symbols.length,
      references: references.length,
      coverage,
      degraded,
    };
  } catch (error) {
    sampler.stop();
    fs.rmSync(path.join(projectRoot, '.nexus', 'tmp', tmpToken), { recursive: true, force: true });
    throw error;
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
    indexVersion: 1,
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
    counts: { files: 0, symbols: 0, references: 0, unresolvedReferences: 0 },
    coverage: zerosCoverage(),
    stats: {
      exact: 0,
      structural: 0,
      conflict: 0,
      unmapped: 0,
      externalReferences: 0,
      localOrUnmappedReferences: 0,
      mappingSuccessRate: 0,
    },
    timings: { scanMs: 0, analyzeMs: 0, scipMs: 0, mapMs: 0, writeMs: 0, totalMs: 0 },
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

export async function buildWorkspace(options: BuildOptions): Promise<BuildResult> {
  const config = options.loadedConfig.config;
  if (config === null) {
    throw nexusError('E17', 'configuration is missing', {
      reason: 'no .nexus/nexus.config.json found',
      suggestion: 'Run `nex init --yes` first, then `nex build`.',
    });
  }
  const projectRoot = path.resolve(options.projectRoot);
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

  clearTmp(projectRoot);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sampler = memorySampler();
  const results: RootBuildResult[] = [];

  for (let index = 0; index < discovery.roots.length; index += 1) {
    const root = discovery.roots[index] as RootCandidate;
    const effective = effectiveConfigs[index] as EffectiveRootConfig;
    const rootStarted = Date.now();
    emit(options, { type: 'root-start', rootId: root.rootId, message: root.rootPath });
    try {
      const outcome = await withRootLock(rootDirectory(projectRoot, root.rootId), async () =>
        buildRoot({
          root,
          effective,
          options,
          sqliteVersion: sqliteProbe.version,
          rootSetHash,
          startedAt,
        }),
      );
      results.push({
        ...outcome,
        durationMs: Date.now() - rootStarted,
        errorCode: null,
        errorMessage: null,
      });
      emit(options, {
        type: 'root-done',
        rootId: root.rootId,
        message: `${outcome.symbols} symbols, ${outcome.references} references`,
      });
    } catch (error) {
      const nexus = mapUnknownError(error);
      recordFailure(projectRoot, root, nexus, rootStarted);
      results.push({
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
        degraded: [],
      });
      emit(options, {
        type: 'root-failed',
        rootId: root.rootId,
        message: `${nexus.code}: ${nexus.reason}`,
      });
    }
  }

  const peakRssMB = sampler.stop();
  const totalMs = Date.now() - startedMs;
  emit(options, {
    type: 'workspace-done',
    rootId: '',
    message: `${results.filter((result) => result.ok).length}/${results.length} roots ok in ${totalMs}ms, peak RSS ${peakRssMB}MB`,
  });
  clearTmp(projectRoot);
  return {
    roots: results,
    failedRoots: results.filter((result) => !result.ok).map((result) => result.rootId),
    totalMs,
  };
}
