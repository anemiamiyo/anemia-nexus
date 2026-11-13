import type { Coverage, Counts, StalenessState, SymbolRecord } from '../model.js';
import { nexusError } from '../errors.js';
import { prepareContext, selectScope, type QueryOptions } from '../query/service.js';
import { databasePath } from '../store/manifest.js';
import {
  defaultCandidateLister,
  extractSymbolNames,
  scoreCandidate,
  splitIdentifier,
  SIMILARITY_RULES_VERSION,
  type SimilarityCandidate,
} from './similar.js';
import {
  findSymbolsByName,
  openReadStore,
  readOwnerModule,
  readSymbolById,
  searchSymbols,
  type ReadStore,
} from '../store/read.js';
import type { RootStatus, WarningItem } from '../status.js';

export interface SimilarOptions extends QueryOptions {
  top?: number;
  scope?: 'public' | 'all';
  explain?: boolean;
}

export interface SimilarTarget {
  rootId: string;
  symbolId: string;
  name: string;
  nameChain: string;
  kind: string;
  path: string;
  line: number;
  col: number;
  module: string | null;
}

export interface SimilarData {
  command: 'similar';
  query: string;
  target: SimilarTarget | null;
  scope: 'public' | 'all';
  roots: string[];
  candidates: SimilarityCandidate[];
  rulesVersion: string;
  isHeuristic: true;
  noSimilarFound: boolean;
  counts: Counts;
  coverage: Coverage;
  truncated: false;
  nextCursor: null;
  staleness: StalenessState;
  buildFingerprint: string | null;
  degraded: string[];
  warnings: WarningItem[];
  notes: string[];
  extraction?: {
    attempted: boolean;
    failed: boolean;
    terms: string[];
    message: string;
  };
  evidence?: {
    targetSignature: string;
    candidateSignatures: Record<string, string>;
  };
}

const MAX_TARGET_CANDIDATES = 20;

function emptyCoverage(): Coverage {
  return {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
  };
}

function aggregateCoverage(roots: readonly RootStatus[]): Coverage {
  const coverage = emptyCoverage();
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

function worstStaleness(roots: readonly RootStatus[]): StalenessState {
  if (roots.some((root) => root.staleness === 'failed')) return 'failed';
  if (roots.some((root) => root.staleness === 'stale')) return 'stale';
  if (roots.some((root) => root.staleness === 'dirty')) return 'dirty';
  if (roots.some((root) => root.staleness === 'indexing')) return 'indexing';
  return 'fresh';
}

function targetOf(symbol: SymbolRecord, module: string | null): SimilarTarget {
  return {
    rootId: symbol.rootId,
    symbolId: symbol.symbolId,
    name: symbol.name,
    nameChain: symbol.nameChain,
    kind: symbol.kind,
    path: symbol.path,
    line: symbol.declarationLocator.startLine,
    col: symbol.declarationLocator.startCol,
    module,
  };
}

function resolveTarget(
  projectRoot: string,
  roots: readonly RootStatus[],
  query: string,
  notes: string[],
): { symbol: SymbolRecord; rootId: string; store: ReadStore; module: string | null } | null {
  const stores = new Map<string, ReadStore>();
  const matches: Array<{ symbol: SymbolRecord; rootId: string; store: ReadStore }> = [];
  const closeStore = (store: ReadStore): void => {
    try {
      store.db.close();
    } catch {
      // best effort
    }
  };
  const closeAll = (keep?: ReadStore): void => {
    for (const store of stores.values()) {
      if (store !== keep) closeStore(store);
    }
  };
  try {
    for (const root of roots) {
      const store = openReadStore(databasePath(projectRoot, root.rootId));
      if (store === null) {
        notes.push(`root ${root.rootId}: no committed index`);
        continue;
      }
      stores.set(root.rootId, store);
      if (query.startsWith('s_')) {
        const symbol = readSymbolById(store, query);
        if (symbol !== null) matches.push({ symbol, rootId: root.rootId, store });
        continue;
      }
      for (const symbol of findSymbolsByName(store, query, MAX_TARGET_CANDIDATES)) {
        matches.push({ symbol, rootId: root.rootId, store });
      }
    }

    if (matches.length === 0) {
      closeAll();
      if (query.startsWith('s_')) {
        throw nexusError('E05', 'symbol does not exist', {
          reason: `symbolId ${query} is not present in the selected roots`,
          suggestion: 'Run `nex search <name>` or rebuild the index.',
          evidence: { roots: roots.map((root) => root.rootId), covered: true },
        });
      }
      return null;
    }
    if (matches.length > 1) {
      closeAll();
      throw nexusError('E04', 'symbol name is ambiguous', {
        reason: `${matches.length} symbols match ${query}`,
        suggestion: 'Pass a symbolId or a fully qualified nameChain.',
        evidence: {
          candidates: matches.slice(0, 20).map((match) => ({
            symbolId: match.symbol.symbolId,
            nameChain: match.symbol.nameChain,
            rootId: match.rootId,
            path: match.symbol.path,
            line: match.symbol.declarationLocator.startLine,
          })),
        },
      });
    }
    const match = matches[0] as { symbol: SymbolRecord; rootId: string; store: ReadStore };
    closeAll(match.store);
    return {
      symbol: match.symbol,
      rootId: match.rootId,
      store: match.store,
      module: readOwnerModule(match.store, match.symbol.path),
    };
  } catch (error) {
    closeAll();
    throw error;
  }
}

/**
 * 9.1 deterministic similar-API search. No embedding, no network, no model:
 * every candidate carries the seven weighted components and a rules version.
 */
export async function runSimilar(options: SimilarOptions, query: string): Promise<SimilarData> {
  const top = Math.min(Math.max(options.top ?? 10, 1), 50);
  const scope = options.scope ?? 'all';
  if (query.trim() === '') {
    throw nexusError('E00', 'similar requires a symbol name or a task description', {
      reason: 'the query is empty',
      suggestion: 'Run `nex similar useOverlay` or `nex similar "load user profile"`.',
    });
  }
  const context = await prepareContext(options);
  const selection = selectScope(context, options);
  const roots = selection.roots;
  const notes: string[] = [];
  if (roots.length === 0) {
    throw nexusError('E16', 'no root selected for the query', {
      reason: 'the selected scope contains no indexed root',
      suggestion: 'Run `nex status` and pass --root or --roots.',
    });
  }

  let targetInfo = resolveTarget(options.projectRoot, roots, query, notes);
  let extraction: SimilarData['extraction'] | undefined;
  const openStores: ReadStore[] = [];
  try {
    if (targetInfo !== null) openStores.push(targetInfo.store);
    if (targetInfo === null) {
      // 9.2: natural-language extraction is explainable keyword extraction.
      const lookup = (term: string): SymbolRecord[] => {
        const found: SymbolRecord[] = [];
        for (const root of roots) {
          const store = openReadStore(databasePath(options.projectRoot, root.rootId));
          if (store === null) continue;
          try {
            found.push(...searchSymbols(store, { name: term, limit: 20 }));
          } finally {
            store.db.close();
          }
        }
        return found;
      };
      const extracted = extractSymbolNames(query, lookup);
      extraction = extracted.names;
      if (extracted.symbols.length === 0) {
        throw nexusError('E05', 'symbol does not exist', {
          reason: `no symbol named ${query} in the selected roots; natural-language extraction failed: ${extracted.names.message}`,
          suggestion: 'Pass a symbol name, a symbolId, or a more specific task description.',
          evidence: {
            roots: roots.map((root) => root.rootId),
            terms: extracted.names.terms,
            covered: true,
          },
        });
      }
      if (extracted.symbols.length > 1) {
        throw nexusError('E04', 'task description matches multiple symbols', {
          reason: `${extracted.symbols.length} symbols matched the extracted terms`,
          suggestion: 'Pass one symbolId from the candidates, or use a more specific query.',
          evidence: {
            candidates: extracted.symbols.slice(0, 20).map((symbol) => ({
              symbolId: symbol.symbolId,
              nameChain: symbol.nameChain,
              path: symbol.path,
              line: symbol.declarationLocator.startLine,
            })),
          },
        });
      }
      const symbol = extracted.symbols[0] as SymbolRecord;
      const store = openReadStore(databasePath(options.projectRoot, symbol.rootId));
      if (store === null) {
        throw nexusError('E01', 'the target symbol is not in a readable index', {
          reason: `root ${symbol.rootId} has no committed index`,
          suggestion: 'Run `nex build`.',
        });
      }
      targetInfo = {
        symbol,
        rootId: symbol.rootId,
        store,
        module: readOwnerModule(store, symbol.path),
      };
      openStores.push(store);
    }

    const target = targetInfo.symbol;
    const targetModule = targetInfo.module;
    const terms = splitIdentifier(target.name);
    const candidates = new Map<string, SimilarityCandidate>();
    const candidateSignatures: Record<string, string> = {};
    for (const root of roots) {
      const store =
        root.rootId === targetInfo.rootId
          ? targetInfo.store
          : openReadStore(databasePath(options.projectRoot, root.rootId));
      if (store === null) continue;
      if (root.rootId !== targetInfo.rootId) openStores.push(store);
      const lister = defaultCandidateLister(store);
      const listed = lister(terms.length === 0 ? [target.name] : terms);
      for (const candidate of listed) {
        if (candidate.symbolId === target.symbolId) continue;
        if (scope === 'public' && !candidate.isPublic) continue;
        const module = readOwnerModule(store, candidate.path);
        const scored = scoreCandidate(target, candidate, targetModule, module);
        if (scored.score <= 0) continue;
        const existing = candidates.get(scored.candidate.symbolId);
        if (existing === undefined || existing.score < scored.score) {
          candidates.set(scored.candidate.symbolId, scored);
          candidateSignatures[scored.candidate.symbolId] = candidate.signature;
        }
      }
    }

    const ordered = [...candidates.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.name.localeCompare(right.candidate.name) ||
          left.location.path.localeCompare(right.location.path) ||
          left.candidate.symbolId.localeCompare(right.candidate.symbolId),
      )
      .slice(0, top);
    const staleness = worstStaleness(roots);
    const buildFingerprint = roots.length === 1 ? (roots[0]?.buildFingerprint ?? null) : null;
    if (roots.length > 1) {
      notes.push('multiple roots: buildFingerprint is omitted; see status.roots[]');
    }
    if (candidates.size > ordered.length) {
      notes.push(
        `--top ${top} applied: ${candidates.size} candidates were scored, ${candidates.size - ordered.length} omitted; raise --top to see more`,
      );
    }
    if (ordered.length === 0) {
      notes.push(
        `no-similar-found within scope ${scope} (${roots.map((root) => root.rootId).join(', ')}), rules ${SIMILARITY_RULES_VERSION}`,
      );
    } else {
      notes.push(
        'similarity is heuristic (docs/09-reuse-detection.md 9.1.1); use the breakdown to decide reuse/extend/new, never as equivalence',
      );
    }
    const data: SimilarData = {
      command: 'similar',
      query,
      target: targetOf(target, targetModule),
      scope,
      roots: roots.map((root) => root.rootId),
      candidates: ordered,
      rulesVersion: SIMILARITY_RULES_VERSION,
      isHeuristic: true,
      noSimilarFound: ordered.length === 0,
      counts: {
        total: candidates.size,
        returned: ordered.length,
        certain: 0,
        heuristic: ordered.length,
        dynamicUnresolved: 0,
        partial: staleness === 'fresh' ? 0 : ordered.length,
      },
      coverage: aggregateCoverage(roots),
      truncated: false,
      nextCursor: null,
      staleness,
      buildFingerprint,
      degraded: [...new Set(roots.flatMap((root) => root.degraded))].sort(),
      warnings: context.warnings,
      notes,
    };
    if (extraction !== undefined) data.extraction = extraction;
    if (options.explain === true) {
      data.evidence = {
        targetSignature: target.signature,
        candidateSignatures,
      };
    }
    return data;
  } finally {
    for (const store of new Set(openStores)) {
      try {
        store.db.close();
      } catch {
        // best effort
      }
    }
  }
}
