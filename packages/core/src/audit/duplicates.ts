import type { Coverage, Counts, StalenessState, SymbolRecord } from '../model.js';
import { nexusError } from '../errors.js';
import { prepareContext, selectScope, type QueryOptions } from '../query/service.js';
import { databasePath } from '../store/manifest.js';
import {
  countSymbols,
  openReadStore,
  readAllSymbols,
  readOwnerModule,
  type ReadStore,
} from '../store/read.js';
import {
  normalizeType,
  parseSignature,
  scoreCandidate,
  splitIdentifier,
  SIMILARITY_RULES_VERSION,
} from './similar.js';
import type { RootStatus, WarningItem } from '../status.js';

export interface DuplicateOptions extends QueryOptions {
  threshold?: number;
  scope?: 'public' | 'all';
}

export interface DuplicateMember {
  rootId: string;
  symbolId: string;
  name: string;
  nameChain: string;
  kind: string;
  path: string;
  line: number;
  col: number;
  signature: string;
  module: string | null;
  implementationLines: number;
}

export interface DuplicateDifference {
  symbolId: string;
  name: string;
  paramCountDelta: number;
  paramTypeMatches: number;
  paramTypeCompared: number;
  returnTypeMatch: boolean;
  implementationLines: number;
  implementationLineDelta: number;
}

export interface DuplicateGroup {
  id: string;
  maxScore: number;
  memberCount: number;
  members: DuplicateMember[];
  differences: DuplicateDifference[];
  relationClass: 'heuristic';
}

export interface DuplicatesData {
  command: 'audit-duplicates';
  threshold: number;
  scope: 'public' | 'all';
  rulesVersion: string;
  isHeuristic: true;
  relationClass: 'heuristic';
  disclaimer: string;
  groups: DuplicateGroup[];
  counts: Counts & {
    groups: number;
    symbolsScanned: number;
    symbolsConsidered: number;
    pairsEvaluated: number;
  };
  coverage: Coverage;
  truncated: boolean;
  truncationReasons: string[];
  nextCursor: null;
  staleness: StalenessState;
  buildFingerprint: string | null;
  degraded: string[];
  warnings: WarningItem[];
  notes: string[];
}

interface PairEdge {
  left: number;
  right: number;
  score: number;
}

const MAX_SYMBOLS = 20000;
const MAX_PAIRS = 2_000_000;
const LOW_THRESHOLD = 0.6;

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

function stemsOf(symbol: SymbolRecord): string[] {
  const tokens = splitIdentifier(symbol.name);
  return tokens.length === 0 ? [symbol.name.toLowerCase()] : tokens;
}

function implementationLines(symbol: SymbolRecord): number {
  return Math.max(1, symbol.declarationLocator.endLine - symbol.declarationLocator.startLine + 1);
}

function toMember(symbol: SymbolRecord, module: string | null): DuplicateMember {
  return {
    rootId: symbol.rootId,
    symbolId: symbol.symbolId,
    name: symbol.name,
    nameChain: symbol.nameChain,
    kind: symbol.kind,
    path: symbol.path,
    line: symbol.declarationLocator.startLine,
    col: symbol.declarationLocator.startCol,
    signature: symbol.signature,
    module,
    implementationLines: implementationLines(symbol),
  };
}

function difference(representative: SymbolRecord, member: SymbolRecord): DuplicateDifference {
  const repSignature = parseSignature(representative.signature);
  const memberSignature = parseSignature(member.signature);
  const pairCount = Math.min(repSignature.parameters.length, memberSignature.parameters.length);
  let matches = 0;
  for (let index = 0; index < pairCount; index += 1) {
    const left = normalizeType(repSignature.parameters[index]?.typeText ?? '');
    const right = normalizeType(memberSignature.parameters[index]?.typeText ?? '');
    if (left === right) matches += 1;
  }
  return {
    symbolId: member.symbolId,
    name: member.name,
    paramCountDelta: Math.abs(repSignature.parameters.length - memberSignature.parameters.length),
    paramTypeMatches: matches,
    paramTypeCompared: pairCount,
    returnTypeMatch:
      normalizeType(repSignature.returnType) === normalizeType(memberSignature.returnType),
    implementationLines: implementationLines(member),
    implementationLineDelta: Math.abs(
      implementationLines(representative) - implementationLines(member),
    ),
  };
}

function groupId(members: readonly DuplicateMember[]): string {
  const first = members[0]?.symbolId ?? 'group';
  return `dup_${first}`;
}

/**
 * 9.3 duplicate implementation audit. Deterministic rules only; candidate
 * pairs are generated by shared name stems (a pair with no name overlap cannot
 * reach the 0.80 `reuse` band because the name component is 0.30). For
 * thresholds below 0.70 all pairs are considered, bounded by MAX_PAIRS.
 */
export async function runAuditDuplicates(options: DuplicateOptions): Promise<DuplicatesData> {
  const threshold = options.threshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw nexusError('E00', 'invalid --threshold', {
      reason: `expected a number between 0 and 1, received ${JSON.stringify(options.threshold)}`,
      suggestion: 'Use --threshold 0..1 (default 0.8).',
    });
  }
  const scope = options.scope ?? 'all';
  const context = await prepareContext(options);
  const selection = selectScope(context, options);
  const roots = selection.roots;
  const notes: string[] = [];
  const warnings: WarningItem[] = [...context.warnings];
  if (threshold < LOW_THRESHOLD) {
    warnings.push({
      code: 'E00',
      message: `threshold ${threshold} is below 0.6; expect many low-confidence groups`,
      severity: 'warning',
    });
  }
  if (roots.length === 0) {
    throw nexusError('E16', 'no root selected for the audit', {
      reason: 'the selected scope contains no indexed root',
      suggestion: 'Run `nex status` and pass --root or --roots.',
    });
  }

  const symbols: SymbolRecord[] = [];
  const modules = new Map<string, string | null>();
  const truncationReasons: string[] = [];
  let symbolsScanned = 0;
  let listingTruncated = false;
  const stores: ReadStore[] = [];
  try {
    for (const root of roots) {
      const store = openReadStore(databasePath(options.projectRoot, root.rootId));
      if (store === null) {
        notes.push(`root ${root.rootId}: no committed index`);
        continue;
      }
      stores.push(store);
      const present = countSymbols(store);
      symbolsScanned += present;
      const listed = readAllSymbols(store, MAX_SYMBOLS);
      if (listed.length < present) listingTruncated = true;
      for (const symbol of listed) {
        if (scope === 'public' && !symbol.isPublic) continue;
        const key = `${root.rootId}\u0000${symbol.path}`;
        if (!modules.has(key)) modules.set(key, readOwnerModule(store, symbol.path));
        symbols.push(symbol);
      }
    }
    if (listingTruncated) {
      throw nexusError('E10', 'duplicate audit exceeds the symbol safety cap', {
        reason: `${MAX_SYMBOLS} symbols per root are listed, ${symbolsScanned} are present`,
        suggestion:
          'Narrow the audit with --scope public or --root; do not treat a partial scan as a complete audit.',
        evidence: { maxSymbols: MAX_SYMBOLS, present: symbolsScanned },
      });
    }

    const moduleOf = (symbol: SymbolRecord): string | null =>
      modules.get(`${symbol.rootId}\u0000${symbol.path}`) ?? null;

    const indexByStem = new Map<string, number[]>();
    const names = symbols.map((symbol) => symbol.name.toLowerCase());
    for (let index = 0; index < symbols.length; index += 1) {
      const stems = new Set(stemsOf(symbols[index] as SymbolRecord));
      if (symbols[index]?.name !== undefined) stems.add(names[index] as string);
      for (const stem of stems) {
        const bucket = indexByStem.get(stem);
        if (bucket === undefined) indexByStem.set(stem, [index]);
        else bucket.push(index);
      }
    }

    const pairKeys = new Set<string>();
    const pairs: Array<[number, number]> = [];
    const addPair = (left: number, right: number): void => {
      if (left === right) return;
      const low = Math.min(left, right);
      const high = Math.max(left, right);
      const key = `${low}:${high}`;
      if (pairKeys.has(key)) return;
      pairKeys.add(key);
      pairs.push([low, high]);
    };

    if (threshold < 0.7) {
      for (let left = 0; left < symbols.length; left += 1) {
        for (let right = left + 1; right < symbols.length; right += 1) {
          addPair(left, right);
          if (pairs.length > MAX_PAIRS) break;
        }
        if (pairs.length > MAX_PAIRS) break;
      }
    } else {
      for (const bucket of indexByStem.values()) {
        for (let left = 0; left < bucket.length; left += 1) {
          for (let right = left + 1; right < bucket.length; right += 1) {
            addPair(bucket[left] as number, bucket[right] as number);
            if (pairs.length > MAX_PAIRS) break;
          }
          if (pairs.length > MAX_PAIRS) break;
        }
        if (pairs.length > MAX_PAIRS) break;
      }
    }
    if (pairs.length > MAX_PAIRS) {
      throw nexusError('E10', 'duplicate audit exceeds the pair safety cap', {
        reason: `${pairs.length} candidate pairs exceed the limit ${MAX_PAIRS}`,
        suggestion:
          'Raise --threshold, narrow --scope, or use --root; a partial scan is not a complete duplicate audit.',
        evidence: { maxPairs: MAX_PAIRS, pairs: pairs.length },
      });
    }

    const edges: PairEdge[] = [];
    for (const [leftIndex, rightIndex] of pairs) {
      const left = symbols[leftIndex] as SymbolRecord;
      const right = symbols[rightIndex] as SymbolRecord;
      const forward = scoreCandidate(left, right, moduleOf(left), moduleOf(right));
      const reverse = scoreCandidate(right, left, moduleOf(right), moduleOf(left));
      const score = Math.max(forward.score, reverse.score);
      if (score >= threshold) edges.push({ left: leftIndex, right: rightIndex, score });
    }

    // Connected components via union-find (iterative).
    const parent = symbols.map((_symbol, index) => index);
    const find = (index: number): number => {
      let current = index;
      while (parent[current] !== current) {
        const next = parent[current] as number;
        parent[current] = parent[next] as number;
        current = next;
      }
      return current;
    };
    const union = (left: number, right: number): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    for (const edge of edges) union(edge.left, edge.right);

    const componentEdges = new Map<number, PairEdge[]>();
    for (const edge of edges) {
      const root = find(edge.left);
      const bucket = componentEdges.get(root);
      if (bucket === undefined) componentEdges.set(root, [edge]);
      else bucket.push(edge);
    }

    const groups: DuplicateGroup[] = [];
    for (const edgeList of componentEdges.values()) {
      const indexSet = new Set<number>();
      let maxScore = 0;
      for (const edge of edgeList) {
        indexSet.add(edge.left);
        indexSet.add(edge.right);
        maxScore = Math.max(maxScore, edge.score);
      }
      if (indexSet.size < 2) continue;
      const unique = [...indexSet].sort((left, right) => {
        const leftSymbol = symbols[left] as SymbolRecord;
        const rightSymbol = symbols[right] as SymbolRecord;
        return (
          leftSymbol.symbolId.localeCompare(rightSymbol.symbolId) ||
          leftSymbol.path.localeCompare(rightSymbol.path)
        );
      });
      const members = unique.map((index) =>
        toMember(symbols[index] as SymbolRecord, moduleOf(symbols[index] as SymbolRecord)),
      );
      members.sort((left, right) => left.symbolId.localeCompare(right.symbolId));
      const representativeIndex = unique[0] as number;
      const representative = symbols[representativeIndex] as SymbolRecord;
      const differences = unique
        .slice(1)
        .map((index) => difference(representative, symbols[index] as SymbolRecord));
      groups.push({
        id: groupId(members),
        maxScore: Math.round(maxScore * 100) / 100,
        memberCount: members.length,
        members,
        differences,
        relationClass: 'heuristic',
      });
    }
    groups.sort(
      (left, right) =>
        right.maxScore - left.maxScore ||
        (left.members[0]?.symbolId ?? '').localeCompare(right.members[0]?.symbolId ?? ''),
    );

    const staleness = worstStaleness(roots);
    const buildFingerprint = roots.length === 1 ? (roots[0]?.buildFingerprint ?? null) : null;
    if (roots.length > 1) {
      notes.push('multiple roots: groups may span roots; buildFingerprint is omitted');
    }
    const disclaimer =
      'similar is not equivalent; every group is heuristic and requires manual confirmation';
    notes.unshift(disclaimer);
    if (groups.length === 0) {
      notes.push(
        `no duplicate groups at threshold ${threshold} within scope ${scope} (${roots.map((root) => root.rootId).join(', ')}), rules ${SIMILARITY_RULES_VERSION}`,
      );
    }
    return {
      command: 'audit-duplicates',
      threshold,
      scope,
      rulesVersion: SIMILARITY_RULES_VERSION,
      isHeuristic: true,
      relationClass: 'heuristic',
      disclaimer,
      groups,
      counts: {
        total: groups.length,
        returned: groups.length,
        certain: 0,
        heuristic: groups.length,
        dynamicUnresolved: 0,
        partial: staleness === 'fresh' ? 0 : groups.length,
        groups: groups.length,
        symbolsScanned,
        symbolsConsidered: symbols.length,
        pairsEvaluated: pairs.length,
      },
      coverage: aggregateCoverage(roots),
      truncated: truncationReasons.length > 0,
      truncationReasons,
      nextCursor: null,
      staleness,
      buildFingerprint,
      degraded: [...new Set(roots.flatMap((root) => root.degraded))].sort(),
      warnings,
      notes,
    };
  } finally {
    for (const store of stores) {
      try {
        store.db.close();
      } catch {
        // best effort
      }
    }
  }
}
