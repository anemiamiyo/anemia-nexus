import type { BlindSpot, Counts, Coverage } from '../model.js';

/**
 * Layered task context used by preflight (docs/13-audit-and-ci.md 13.1 #8).
 * `nex context`/MCP exposure is Phase 07; this is the single implementation
 * those surfaces will call later, so preflight does not grow a second one.
 */
export interface ContextItem {
  kind: 'target' | 'dependent' | 'similar' | 'test' | 'doc' | 'blind-spot';
  path: string;
  line: number;
  symbolId: string | null;
  name: string | null;
  reason: string;
  relationClass: string;
  confidence: string;
}

export interface TaskContextPacket {
  command: 'context';
  task: string | null;
  target: unknown;
  layers: {
    summary: ContextItem[];
    relations: ContextItem[];
    source: ContextItem[];
  };
  counts: Counts;
  coverage: Coverage | null;
  truncated: boolean;
  nextCursor: string | null;
  staleness: string;
  buildFingerprint: string | null;
  budget: { layer: 'summary'; maxTokens: number | null; maxFiles: number | null };
  blindSpots: BlindSpot[];
  notes: string[];
}

export interface ContextInput {
  task: string | null;
  target: unknown;
  direct: Array<{
    path: string;
    line: number;
    symbolId: string | null;
    name: string | null;
    reason: string;
    relationClass: string;
    confidence: string;
  }>;
  indirect: Array<{
    path: string;
    line: number;
    symbolId: string | null;
    name: string | null;
    reason: string;
    relationClass: string;
    confidence: string;
  }>;
  similar: Array<{ name: string; path: string; line: number; symbolId: string; score: number }>;
  tests: Array<{ testFile: string; line: number; targetName: string | null }>;
  docs: Array<{ path: string; line: number; match: string }>;
  blindSpots: BlindSpot[];
  counts: Counts;
  coverage: Coverage | null;
  staleness: string;
  buildFingerprint: string | null;
  budget: { maxTokens: number | null; maxFiles: number | null };
}

export function buildTaskContext(input: ContextInput): TaskContextPacket {
  const summary: ContextItem[] = [];
  const relations: ContextItem[] = [];
  relations.push(
    ...input.direct.slice(0, 50).map((item) => ({
      kind: 'dependent' as const,
      path: item.path,
      line: item.line,
      symbolId: item.symbolId,
      name: item.name,
      reason: item.reason,
      relationClass: item.relationClass,
      confidence: item.confidence,
    })),
  );
  relations.push(
    ...input.indirect.slice(0, 100).map((item) => ({
      kind: 'dependent' as const,
      path: item.path,
      line: item.line,
      symbolId: item.symbolId,
      name: item.name,
      reason: item.reason,
      relationClass: item.relationClass,
      confidence: item.confidence,
    })),
  );
  summary.push(
    ...input.similar.slice(0, 10).map((item) => ({
      kind: 'similar' as const,
      path: item.path,
      line: item.line,
      symbolId: item.symbolId,
      name: item.name,
      reason: `similar ${item.score.toFixed(2)}`,
      relationClass: 'heuristic',
      confidence: 'heuristic',
    })),
  );
  summary.push(
    ...input.tests.slice(0, 20).map((item) => ({
      kind: 'test' as const,
      path: item.testFile,
      line: item.line,
      symbolId: null,
      name: item.targetName,
      reason: 'related-test',
      relationClass: 'certain',
      confidence: 'typed',
    })),
  );
  summary.push(
    ...input.docs.slice(0, 20).map((item) => ({
      kind: 'doc' as const,
      path: item.path,
      line: item.line,
      symbolId: null,
      name: null,
      reason: 'related-doc',
      relationClass: 'heuristic',
      confidence: 'heuristic',
    })),
  );
  const total = input.direct.length + input.indirect.length + input.similar.length;
  const truncated = input.direct.length > 50 || input.indirect.length > 100;
  return {
    command: 'context',
    task: input.task,
    target: input.target,
    layers: { summary, relations, source: [] },
    counts: {
      total,
      returned:
        Math.min(input.direct.length, 50) +
        Math.min(input.indirect.length, 100) +
        Math.min(input.similar.length, 10),
      certain: input.counts.certain,
      heuristic: input.counts.heuristic,
      dynamicUnresolved: input.counts.dynamicUnresolved,
      partial: input.counts.partial,
    },
    coverage: input.coverage,
    truncated,
    nextCursor: truncated ? 'context:relations:100' : null,
    staleness: input.staleness,
    buildFingerprint: input.buildFingerprint,
    budget: {
      layer: 'summary',
      maxTokens: input.budget.maxTokens,
      maxFiles: input.budget.maxFiles,
    },
    blindSpots: input.blindSpots,
    notes: [
      'context source layer is disabled by default; preflight uses summary + relations',
      'nex context / MCP exposure is Phase 07; this packet is the shared implementation',
    ],
  };
}
