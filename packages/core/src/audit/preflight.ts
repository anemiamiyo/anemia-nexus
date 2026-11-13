import type { Coverage, Counts, SymbolRecord } from '../model.js';
import type { SurfaceEntry } from '../surface/types.js';
import { nexusError } from '../errors.js';
import { prepareContext, selectScope, type QueryOptions } from '../query/service.js';
import { databasePath } from '../store/manifest.js';
import {
  defaultCandidateLister,
  extractSymbolNames,
  findSimilar,
  SIMILARITY_RULES_VERSION,
  splitIdentifier,
  type ExtractedNames,
  type SimilarityCandidate,
} from './similar.js';
import { analyzeImpact, impactData, type ImpactOptions, type ImpactResult } from './impact.js';
import { buildTaskContext, type TaskContextPacket } from './context.js';
import {
  openReadStore,
  readOwnerModule,
  readSymbolById,
  readSymbolsForFile,
  searchSymbols,
} from '../store/read.js';
import { readSurface } from '../surface/store.js';

export interface PreflightOptions extends QueryOptions {
  task?: string | null;
  target?: string | null;
  symbol?: string | null;
  base?: string | null;
  depth?: number;
}

export interface PreflightSource {
  rootId: string;
  symbolId: string;
  name: string;
  nameChain: string;
  kind: string;
  path: string;
  line: number;
  col: number;
  isPublic: boolean;
}

export interface PreflightData {
  command: 'preflight';
  task: string | null;
  target: unknown;
  scope: string;
  existingApis: SurfaceEntry[];
  similar: {
    candidates: SimilarityCandidate[];
    rulesVersion: string;
    noSimilarFound: boolean;
    extraction: ExtractedNames;
    note: string;
  };
  sources: PreflightSource[];
  dependencies: { direct: number; indirect: number };
  architecture: { violations: unknown[]; modules: string[] };
  impact: Record<string, unknown> | null;
  docs: { related: unknown[]; searchedFiles: number; truncated: boolean; note: string };
  tests: { related: unknown[]; suggestedCommands: string[] };
  context: TaskContextPacket;
  risk: { level: string; reasons: unknown[] };
  blindSpots: unknown[];
  counts: Counts;
  coverage: Coverage | null;
  staleness: string;
  buildFingerprint: string | null;
  scopeRoots: string[];
  staleRoots: string[];
  failedRoots: string[];
  completeness: 'complete' | 'partial';
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  degraded: string[];
  notes: string[];
  exitCode: number;
}

function emptyCounts(): Counts {
  return { total: 0, returned: 0, certain: 0, heuristic: 0, dynamicUnresolved: 0, partial: 0 };
}

function findTargetSymbol(
  store: ReturnType<typeof openReadStore>,
  rootId: string,
  symbolId: string | null,
): SymbolRecord | null {
  if (store === null || symbolId === null) return null;
  const symbol = readSymbolById(store, symbolId);
  if (symbol !== null) return symbol;
  void rootId;
  return null;
}

function surfaceEntriesFor(
  projectRoot: string,
  rootId: string,
  symbolIds: ReadonlySet<string>,
): SurfaceEntry[] {
  const read = readSurface(projectRoot, rootId);
  if (read.surface === null || !read.matchesManifest) return [];
  return read.surface.entries.filter((entry) => symbolIds.has(entry.symbolId));
}

function aggregateCoverage(values: Array<Coverage | null>): Coverage | null {
  if (values.some((value) => value === null)) return null;
  const output: Coverage = {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
  };
  for (const value of values) {
    if (value === null) continue;
    output.filesCovered += value.filesCovered;
    output.filesSkipped += value.filesSkipped;
    output.filesIgnored += value.filesIgnored;
    output.filesFailed += value.filesFailed;
    output.resolved += value.resolved;
    output.unresolved += value.unresolved;
    output.unmapped += value.unmapped;
    output.filteredInternal += value.filteredInternal;
  }
  return output;
}

function extractionLookup(
  projectRoot: string,
  roots: Array<{ rootId: string }>,
): (term: string) => SymbolRecord[] {
  return (term) => {
    const found: SymbolRecord[] = [];
    for (const root of roots) {
      const store = openReadStore(databasePath(projectRoot, root.rootId));
      if (store === null) continue;
      try {
        found.push(...searchSymbols(store, { name: term, limit: 20 }));
      } finally {
        store.db.close();
      }
    }
    return found;
  };
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightData> {
  const context = await prepareContext(options);
  const selection = selectScope(context, options);
  const degraded = [...new Set(selection.roots.flatMap((root) => root.degraded))].sort();
  const task = options.task ?? null;
  const targetArg = options.target ?? '';
  const symbolArg = options.symbol ?? null;
  if (
    targetArg.trim() === '' &&
    (symbolArg === null || symbolArg === '') &&
    (task === null || task.trim() === '')
  ) {
    throw nexusError('E00', 'preflight requires a target or a task description', {
      reason: 'neither <target>, --symbol nor --task was provided',
      suggestion: 'Run `nex preflight <file>` or `nex preflight --task "add a button"`.',
    });
  }

  const extraction = extractSymbolNames(
    task,
    extractionLookup(options.projectRoot, selection.roots),
  );
  let effectiveTarget = targetArg;
  let effectiveSymbol = symbolArg;
  if (effectiveTarget.trim() === '' && (effectiveSymbol === null || effectiveSymbol === '')) {
    const first = extraction.symbols[0];
    if (first === undefined) {
      const notes = [
        'no target could be resolved from the task description; provide a target or --symbol',
        ...extraction.names.terms.map((term) => `task token: ${term}`),
      ];
      const packet = buildTaskContext({
        task,
        target: null,
        direct: [],
        indirect: [],
        similar: [],
        tests: [],
        docs: [],
        blindSpots: [],
        counts: emptyCounts(),
        coverage: null,
        staleness: 'stale',
        buildFingerprint: null,
        budget: { maxTokens: context.budget.maxTokens, maxFiles: context.budget.maxFiles },
        degraded,
      });
      return {
        command: 'preflight',
        task,
        target: null,
        scope: selection.scope,
        existingApis: [],
        similar: {
          candidates: [],
          rulesVersion: SIMILARITY_RULES_VERSION,
          noSimilarFound: true,
          extraction: extraction.names,
          note: 'no-similar-found: no target symbol was extracted, so similarity was not searched',
        },
        sources: [],
        dependencies: { direct: 0, indirect: 0 },
        architecture: { violations: [], modules: [] },
        impact: null,
        docs: { related: [], searchedFiles: 0, truncated: false, note: 'not run' },
        tests: { related: [], suggestedCommands: [] },
        context: packet,
        risk: { level: 'Low', reasons: [] },
        blindSpots: [],
        counts: emptyCounts(),
        coverage: null,
        staleness: 'stale',
        buildFingerprint: null,
        scopeRoots: selection.roots.map((root) => root.rootId),
        staleRoots: selection.staleRoots,
        failedRoots: selection.failedRoots,
        completeness: 'partial',
        warnings: context.warnings,
        degraded,
        notes,
        exitCode: 2,
      };
    }
    effectiveTarget = first.nameChain;
    effectiveSymbol = first.name;
  }

  const impactOptions: ImpactOptions = {
    ...options,
    target: effectiveTarget,
    symbol: effectiveSymbol,
    depth: options.depth ?? 3,
  };
  const impact: ImpactResult = await analyzeImpact(impactOptions);
  const impactReport = impactData(impact);

  const candidates = new Map<string, SimilarityCandidate>();
  const existing = new Map<string, SurfaceEntry>();
  const sources = new Map<string, PreflightSource>();
  const modules = new Set<string>();
  const violations: unknown[] = [];
  let targetDescription: unknown = null;
  for (const report of impact.reports) {
    const store = openReadStore(databasePath(options.projectRoot, report.rootId));
    if (store === null) continue;
    try {
      targetDescription ??= report.target;
      const targetSymbol = findTargetSymbol(store, report.rootId, report.target.symbolId);
      const fileSymbols =
        report.target.filePath === null ? [] : readSymbolsForFile(store, report.target.filePath);
      const primary =
        targetSymbol ?? fileSymbols.find((symbol) => symbol.isPublic) ?? fileSymbols[0] ?? null;
      const symbolIds = new Set<string>(fileSymbols.map((symbol) => symbol.symbolId));
      if (targetSymbol !== null) symbolIds.add(targetSymbol.symbolId);
      for (const entry of surfaceEntriesFor(options.projectRoot, report.rootId, symbolIds)) {
        existing.set(
          `${report.rootId}|${entry.symbolId}|${entry.entryPath ?? ''}|${entry.condition ?? ''}`,
          entry,
        );
      }
      for (const symbol of [primary, ...fileSymbols].filter(
        (symbol): symbol is SymbolRecord => symbol !== null,
      )) {
        sources.set(symbol.symbolId, {
          rootId: report.rootId,
          symbolId: symbol.symbolId,
          name: symbol.name,
          nameChain: symbol.nameChain,
          kind: symbol.kind,
          path: symbol.path,
          line: symbol.declarationLocator.startLine,
          col: symbol.declarationLocator.startCol,
          isPublic: symbol.isPublic,
        });
        const module = readOwnerModule(store, symbol.path);
        if (module !== null) modules.add(module);
        if (sources.size >= 20) break;
      }
      if (primary !== null) {
        const similar = findSimilar(
          store,
          {
            rootId: report.rootId,
            moduleOf: (file) => readOwnerModule(store, file),
            listCandidates: defaultCandidateLister(store),
          },
          primary,
          { top: 10, scope: 'all', terms: splitIdentifier(primary.name) },
        );
        for (const candidate of similar) {
          const key = candidate.candidate.symbolId;
          if (!candidates.has(key) || (candidates.get(key)?.score ?? 0) < candidate.score) {
            candidates.set(key, candidate);
          }
        }
      }
      for (const violation of report.architecture.violations) {
        violations.push(violation);
      }
      for (const module of report.architecture.modules) modules.add(module);
    } finally {
      store.db.close();
    }
  }

  const similarCandidates = [...candidates.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.name.localeCompare(right.candidate.name) ||
      left.location.path.localeCompare(right.location.path),
  );
  const docs = impact.reports[0]?.docs ?? {
    related: [],
    searchedFiles: 0,
    truncated: false,
    note: 'not run',
  };
  const tests = {
    related: impact.reports.flatMap((report) => report.tests.related),
    suggestedCommands: [
      ...new Set(impact.reports.flatMap((report) => report.tests.suggestedCommands)),
    ],
  };
  const blindSpots = impact.reports.flatMap((report) => report.blindSpots);
  const counts = impactReport.counts as Counts;
  const risk = impactReport.risk as { level: string; reasons: unknown[] };
  const packet = buildTaskContext({
    task,
    target: targetDescription,
    direct: impact.reports.flatMap((report) => report.direct.items),
    indirect: impact.reports.flatMap((report) => report.indirect.items),
    similar: similarCandidates.map((candidate) => ({
      name: candidate.candidate.name,
      path: candidate.location.path,
      line: candidate.location.line,
      symbolId: candidate.candidate.symbolId,
      score: candidate.score,
    })),
    tests: tests.related.map((test) => ({
      testFile: test.testFile,
      line: test.line,
      targetName: test.targetSymbolId,
    })),
    docs: docs.related,
    blindSpots,
    counts,
    coverage: aggregateCoverage(impact.reports.map((report) => report.coverage)),
    staleness: impactReport.staleness as string,
    buildFingerprint: impactReport.buildFingerprint as string | null,
    budget: { maxTokens: context.budget.maxTokens, maxFiles: context.budget.maxFiles },
    degraded,
  });

  const notes = [...impact.notes];
  if (extraction.names.failed && task !== null) {
    notes.push(`symbol extraction from task text failed: ${extraction.names.message}`);
  }
  if (similarCandidates.length === 0) {
    notes.push(
      `no-similar-found within scope ${selection.scope} (${selection.roots.map((root) => root.rootId).join(', ')}), rules ${SIMILARITY_RULES_VERSION}`,
    );
  }
  return {
    command: 'preflight',
    task,
    target: targetDescription,
    scope: impact.scope,
    existingApis: [...existing.values()].sort((left, right) => left.name.localeCompare(right.name)),
    similar: {
      candidates: similarCandidates,
      rulesVersion: SIMILARITY_RULES_VERSION,
      noSimilarFound: similarCandidates.length === 0,
      extraction: extraction.names,
      note: 'similarity is heuristic (docs/09-reuse-detection.md 9.1.1); use it to decide reuse/extend/new, never as equivalence',
    },
    sources: [...sources.values()].sort((left, right) => left.path.localeCompare(right.path)),
    dependencies: {
      direct: impact.reports.reduce((total, report) => total + report.direct.count, 0),
      indirect: impact.reports.reduce((total, report) => total + report.indirect.count, 0),
    },
    architecture: { violations, modules: [...modules].sort() },
    impact: impactReport,
    docs,
    tests,
    context: packet,
    risk,
    blindSpots,
    counts,
    coverage: packet.coverage,
    staleness: packet.staleness,
    buildFingerprint: packet.buildFingerprint,
    scopeRoots: selection.roots.map((root) => root.rootId),
    staleRoots: selection.staleRoots,
    failedRoots: selection.failedRoots,
    completeness: impact.completeness,
    warnings: [...context.warnings, ...impact.warnings],
    degraded,
    notes,
    exitCode: impact.completeness === 'complete' || !extraction.names.failed ? 0 : 2,
  };
}
