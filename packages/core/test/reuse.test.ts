import { afterEach, describe, expect, it } from 'vitest';

import { runAuditDuplicates, runContext, runSimilar, type TaskContextPacket } from 'anemia-core';

import { cleanup, indexFixture, type IndexedFixture } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

async function indexed(label: string): Promise<{
  fixture: IndexedFixture;
  options: {
    projectRoot: string;
    cwd: string;
    rootId: string;
    roots: null;
    trustConfig: false;
  };
}> {
  const fixture = await indexFixture('F07-api-surface', label);
  directories.push(fixture.directory);
  return {
    fixture,
    options: {
      projectRoot: fixture.directory,
      cwd: fixture.directory,
      rootId: fixture.rootId,
      roots: null,
      trustConfig: false,
    },
  };
}

describe('Phase 07 similar API (9.1)', () => {
  it('returns explainable candidates with score components and a rules version', async () => {
    const { options } = await indexed('reuse-similar');
    const data = await runSimilar({ ...options, top: 10, scope: 'all' }, 'add');
    expect(data.target?.name).toBe('add');
    expect(data.rulesVersion).toBe('9.1.1');
    expect(data.isHeuristic).toBe(true);
    expect(data.candidates.length).toBeGreaterThan(0);
    const candidate = data.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate?.isHeuristic).toBe(true);
    expect(candidate?.score).toBeGreaterThanOrEqual(0);
    expect(candidate?.score).toBeLessThanOrEqual(1);
    expect(typeof candidate?.scoreBreakdown.nameScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.paramCountScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.paramTypeScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.returnTypeScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.moduleScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.surfaceScore).toBe('number');
    expect(typeof candidate?.scoreBreakdown.structuralScore).toBe('number');
    expect(candidate?.matchBasis.length).toBeGreaterThan(0);
    expect(['reuse', 'extend', 'new']).toContain(candidate?.suggestion);
    expect(candidate?.candidate.symbolId).toBeTruthy();
    expect(data.counts.heuristic).toBe(data.candidates.length);
  });

  it('reports no-similar-found with scope, roots and rules', async () => {
    const { options } = await indexed('reuse-similar-none');
    const data = await runSimilar(options, 'doomed');
    expect(data.noSimilarFound).toBe(true);
    expect(data.candidates).toEqual([]);
    expect(data.notes.join('\n')).toContain('no-similar-found');
    expect(data.notes.join('\n')).toContain('9.1.1');
    expect(data.roots.length).toBeGreaterThan(0);
  });

  it('rejects ambiguous names with E04 and lists candidates', async () => {
    const { options } = await indexed('reuse-similar-ambiguous');
    await expect(runSimilar(options, 'internalHelper')).rejects.toMatchObject({ code: 'E04' });
  });

  it('is deterministic for the same index and query', async () => {
    const { options } = await indexed('reuse-similar-deterministic');
    const first = await runSimilar(options, 'add');
    const second = await runSimilar(options, 'add');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('Phase 07 duplicate audit (9.3)', () => {
  it('clusters near-duplicates and reports parameter, return and line differences', async () => {
    const { options } = await indexed('reuse-duplicates');
    const data = await runAuditDuplicates({ ...options, threshold: 0.7, scope: 'all' });
    expect(data.relationClass).toBe('heuristic');
    expect(data.isHeuristic).toBe(true);
    expect(data.disclaimer).toContain('not equivalent');
    expect(data.groups.length).toBeGreaterThan(0);
    for (const group of data.groups) {
      expect(group.relationClass).toBe('heuristic');
      expect(group.memberCount).toBeGreaterThanOrEqual(2);
      expect(group.members.length).toBeGreaterThanOrEqual(2);
      expect(group.differences.length).toBe(group.members.length - 1);
      for (const diff of group.differences) {
        expect(typeof diff.paramCountDelta).toBe('number');
        expect(typeof diff.returnTypeMatch).toBe('boolean');
        expect(typeof diff.implementationLines).toBe('number');
        expect(typeof diff.implementationLineDelta).toBe('number');
      }
    }
    expect(data.counts.pairsEvaluated).toBeGreaterThan(0);
  });

  it('warns below 0.6 without blocking execution', async () => {
    const { options } = await indexed('reuse-duplicates-low');
    const data = await runAuditDuplicates({ ...options, threshold: 0.5, scope: 'all' });
    expect(data.warnings.some((warning) => warning.message.includes('below 0.6'))).toBe(true);
  });
});

describe('Phase 07 context (15 / 11.3)', () => {
  it('adds a source excerpt only when requested', async () => {
    const { options } = await indexed('reuse-context');
    const packet = await runContext({
      ...options,
      symbol: 'add',
      contextLines: 5,
    });
    expect(packet.layers.source.length).toBe(1);
    expect(packet.layers.source[0]?.excerpt).toContain('add');
    expect(packet.nextCursor).toBeNull();
  });

  it('pages with a cursor without duplicating items', async () => {
    const { options } = await indexed('reuse-context-cursor');
    const first = await runContext({
      ...options,
      target: 'src/math.ts',
      contextLines: 5,
      pageSize: 1,
    });
    expect(first.counts.returned).toBeLessThanOrEqual(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await runContext({
      ...options,
      target: 'src/math.ts',
      contextLines: 5,
      pageSize: 1,
      cursor: first.nextCursor,
    });
    const key = (packet: TaskContextPacket): string[] =>
      [...packet.layers.summary, ...packet.layers.relations, ...packet.layers.source].map(
        (item) => `${item.path}:${item.line}:${item.reason}:${item.symbolId ?? ''}`,
      );
    const firstKeys = key(first);
    expect(firstKeys.length).toBeGreaterThan(0);
    expect(key(second).length).toBeGreaterThan(0);
    for (const item of key(second)) expect(firstKeys).not.toContain(item);
  });

  it('rejects a request without task, target or symbol', async () => {
    const { options } = await indexed('reuse-context-empty');
    await expect(runContext(options)).rejects.toMatchObject({ code: 'E00' });
  });
});
