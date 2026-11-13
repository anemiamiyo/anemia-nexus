import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';
import type { QueryOptions } from '../query/service.js';
import { runPreflight } from './preflight.js';
import type { ContextItem, TaskContextPacket } from './context.js';

export interface ContextOptions extends QueryOptions {
  task?: string | null;
  target?: string | null;
  symbol?: string | null;
  depth?: number;
  contextLines?: number;
  cursor?: string | null;
  noTruncate?: boolean;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_CONTEXT_LINES = 400;

interface TaggedItem {
  layer: 'summary' | 'relations' | 'source';
  item: ContextItem;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(token: string | null | undefined): number {
  if (token === null || token === undefined || token === '') return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw nexusError('E00', 'invalid --cursor token', {
      reason: 'cursor is not a valid base64url offset token',
      suggestion: 'Use the nextCursor value returned by a previous context call.',
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw nexusError('E00', 'invalid --cursor token', {
      reason: 'cursor payload is not an object',
      suggestion: 'Use the nextCursor value returned by a previous context call.',
    });
  }
  const offset = (parsed as Record<string, unknown>).o;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw nexusError('E00', 'invalid --cursor offset', {
      reason: `expected a non-negative integer, received ${JSON.stringify(offset)}`,
      suggestion: 'Use the nextCursor value returned by a previous context call.',
    });
  }
  return offset;
}

function readExcerpt(
  projectRoot: string,
  filePath: string,
  line: number,
  contextLines: number,
): string | null {
  const absolute = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
    const start = Math.max(0, line - 1);
    const end = Math.min(lines.length, start + contextLines);
    return lines.slice(start, end).join('\n');
  } catch {
    return null;
  }
}

/**
 * Phase 07 `nex context` / MCP `context`: the same layered packet preflight
 * already uses, plus an optional source layer and real cursor paging. No
 * second query implementation, no file writes.
 */
export async function runContext(options: ContextOptions): Promise<TaskContextPacket> {
  const task = options.task ?? null;
  const target = options.target ?? null;
  const symbol = options.symbol ?? null;
  if (
    (task === null || task.trim() === '') &&
    (target === null || target.trim() === '') &&
    (symbol === null || symbol.trim() === '')
  ) {
    throw nexusError('E00', 'context requires a task, target or symbol', {
      reason: 'no task description, target path or symbol was provided',
      suggestion: 'Run `nex context --task "add a close button"` or `nex context <file>`.',
    });
  }
  const preflight = await runPreflight({
    ...options,
    task,
    target,
    symbol,
    depth: options.depth ?? 3,
  });
  const packet = preflight.context;
  packet.degraded = [...new Set(preflight.degraded)].sort();
  const notes = [...packet.notes];
  const contextLines = Math.min(Math.max(options.contextLines ?? 0, 0), MAX_CONTEXT_LINES);

  if (contextLines > 0) {
    const targetRecord =
      typeof packet.target === 'object' && packet.target !== null
        ? (packet.target as Record<string, unknown>)
        : null;
    const filePath =
      targetRecord !== null && typeof targetRecord.filePath === 'string'
        ? targetRecord.filePath
        : null;
    const line =
      targetRecord !== null &&
      typeof targetRecord.line === 'number' &&
      Number.isInteger(targetRecord.line) &&
      targetRecord.line > 0
        ? targetRecord.line
        : 1;
    if (filePath === null) {
      notes.push('source layer skipped: the target has no file path');
    } else {
      const excerpt = readExcerpt(options.projectRoot, filePath, line, contextLines);
      if (excerpt === null) {
        notes.push(`source layer skipped: could not read ${filePath}`);
      } else {
        packet.layers.source.push({
          kind: 'target',
          path: filePath,
          line,
          symbolId:
            targetRecord !== null && typeof targetRecord.symbolId === 'string'
              ? targetRecord.symbolId
              : null,
          name:
            targetRecord !== null && typeof targetRecord.name === 'string'
              ? targetRecord.name
              : null,
          reason: 'source-excerpt',
          relationClass: 'certain',
          confidence: 'typed',
          excerpt,
        });
        notes.push(
          `source layer: ${Math.min(contextLines, excerpt.split('\n').length)} line(s) from ${filePath}:${line}`,
        );
      }
    }
  }

  const tagged: TaggedItem[] = [
    ...packet.layers.summary.map((item) => ({ layer: 'summary' as const, item })),
    ...packet.layers.relations.map((item) => ({ layer: 'relations' as const, item })),
    ...packet.layers.source.map((item) => ({ layer: 'source' as const, item })),
  ];
  const offset = decodeCursor(options.cursor ?? null);
  if (offset > tagged.length) {
    throw nexusError('E00', 'cursor offset is out of range', {
      reason: `offset ${offset} exceeds the ${tagged.length} available context items`,
      suggestion: 'Restart from `nex context` without --cursor.',
    });
  }
  const pageSize = options.noTruncate
    ? Math.max(tagged.length - offset, 0)
    : Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), 1000);
  const page = tagged.slice(offset, offset + pageSize);
  const remaining = tagged.length - offset - page.length;

  const rebuilt: TaskContextPacket['layers'] = {
    summary: page.filter((entry) => entry.layer === 'summary').map((entry) => entry.item),
    relations: page.filter((entry) => entry.layer === 'relations').map((entry) => entry.item),
    source: page.filter((entry) => entry.layer === 'source').map((entry) => entry.item),
  };

  const total = tagged.length;
  const truncated = remaining > 0 || packet.truncated;
  packet.layers = rebuilt;
  packet.truncated = truncated;
  packet.nextCursor = remaining > 0 ? encodeCursor(offset + page.length) : null;
  packet.counts = {
    ...packet.counts,
    total,
    returned: page.length,
    partial: packet.staleness === 'fresh' ? 0 : Math.max(packet.counts.partial, 1),
  };
  if (remaining > 0) {
    notes.push(
      `page size ${pageSize}: ${remaining} more item(s); continue with --cursor ${packet.nextCursor ?? ''}`,
    );
  }
  packet.notes = notes;
  return packet;
}
