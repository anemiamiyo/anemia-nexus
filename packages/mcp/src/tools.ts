import {
  analyzeImpact,
  impactData,
  mapUnknownError,
  nexusError,
  queryDependencies,
  queryReferences,
  querySearch,
  querySymbol,
  runContext,
  type DependencyQueryType,
} from 'anemia-core';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { renderCompact, renderErrorText, resolveFormat, type McpFormat } from './format.js';
import { refreshIndex } from './refresh.js';
import {
  currentStatus,
  noteQuery,
  resolveScope,
  runtimeStatusView,
  type RuntimeState,
} from './runtime.js';

export interface RegisterToolOptions {
  readOnly: boolean;
}

type Row = Record<string, unknown>;
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Row;
  isError?: boolean;
};

const formatSchema = z
  .string()
  .optional()
  .describe('compact text (lines) or structured JSON text; default lines');

const rootSchema = z
  .string()
  .optional()
  .describe('root id; defaults to activeRoot or the only root');
const rootsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('root selection: "all" or an array of root ids');

const envelopeOutput = z.looseObject({
  counts: z.unknown().optional(),
  coverage: z.unknown().optional(),
  truncated: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
  staleness: z.string().optional(),
  buildFingerprint: z.string().nullable().optional(),
  degraded: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  formatApplied: z.enum(['lines', 'json']).optional(),
  formatFallback: z.boolean().optional(),
  formatReason: z.string().optional(),
});

const statusOutput = z.looseObject({
  state: z.enum(['uninitialized', 'ready']).optional(),
  staleness: z.string().optional(),
  buildFingerprint: z.string().nullable().optional(),
  rootId: z.string().nullable().optional(),
  activeRoot: z.string().nullable().optional(),
  roots: z.array(z.looseObject({})).optional(),
  coverage: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  self: z.looseObject({}),
  lastIntegrityCheck: z.unknown().optional(),
  degraded: z.array(z.string()).optional(),
  guidance: z.array(z.string()).optional(),
  onboarding: z.unknown().optional(),
  bootstrap: z.unknown().optional(),
  warnings: z.array(z.unknown()).optional(),
  formatApplied: z.enum(['lines', 'json']).optional(),
  formatFallback: z.boolean().optional(),
  formatReason: z.string().optional(),
});

function notReady(runtime: RuntimeState, decision: ReturnType<typeof resolveFormat>): ToolResult {
  const payload: Row = {
    state: 'uninitialized',
    staleness: 'indexing',
    bootstrap: runtime.bootstrap,
    notes: ['index is being built; call status for progress and retry when ready'],
    formatApplied: decision.format,
    formatFallback: decision.fallback,
    ...(decision.reason === null ? {} : { formatReason: decision.reason }),
  };
  return {
    content: [
      {
        type: 'text',
        text:
          decision.format === 'json'
            ? JSON.stringify(payload)
            : 'indexing — index is being built; call status for progress, then retry',
      },
    ],
    structuredContent: payload,
  };
}

function toolError(
  runtime: RuntimeState,
  error: unknown,
  decision: ReturnType<typeof resolveFormat>,
): ToolResult {
  const nexus = mapUnknownError(error);
  if (nexus.code === 'E01' && runtime.bootstrap.state === 'indexing') {
    return notReady(runtime, decision);
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: renderErrorText(nexus, decision.format, runtime.projectRoot),
      },
    ],
  };
}

async function invoke(
  runtime: RuntimeState,
  tool: string,
  args: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<Row>,
): Promise<ToolResult> {
  const decision = resolveFormat(args.format);
  noteQuery(runtime);
  try {
    const data = await handler(args);
    const enriched: Row = {
      ...data,
      formatApplied: decision.format,
      formatFallback: decision.fallback,
      ...(decision.reason === null ? {} : { formatReason: decision.reason }),
    };
    return {
      content: [
        {
          type: 'text',
          text:
            decision.format === 'json' ? JSON.stringify(enriched) : renderCompact(tool, enriched),
        },
      ],
      structuredContent: enriched,
    };
  } catch (error) {
    return toolError(runtime, error, decision);
  }
}

function asRow(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function scopeOf(selection: { rootId: string | null; roots: string | null }): {
  rootId: string | null;
  roots: string | null;
} {
  return selection;
}

export function registerTools(
  server: McpServer,
  runtime: RuntimeState,
  options: RegisterToolOptions,
): void {
  server.registerTool(
    'status',
    {
      title: 'Index status',
      description:
        'Project overview, index state/staleness, coverage, guidance, capabilities and binary self-check. Never errors.',
      inputSchema: z.object({ root: rootSchema, roots: rootsSchema, format: formatSchema }),
      outputSchema: statusOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      const decision = resolveFormat(args.format);
      noteQuery(runtime);
      try {
        const status = await currentStatus(runtime);
        let view = runtimeStatusView(runtime, status);
        if (args.root !== undefined || args.roots !== undefined) {
          const scope = await resolveScope(runtime, args).catch(() => null);
          if (scope !== null) {
            view = {
              ...view,
              rootId: scope.rootId ?? view.rootId,
              activeRoot: scope.rootId ?? view.activeRoot,
            };
          }
        }
        const enriched = {
          ...view,
          formatApplied: decision.format,
          formatFallback: decision.fallback,
          ...(decision.reason === null ? {} : { formatReason: decision.reason }),
        };
        return {
          content: [
            {
              type: 'text',
              text:
                decision.format === 'json'
                  ? JSON.stringify(enriched)
                  : renderCompact('status', enriched),
            },
          ],
          structuredContent: enriched,
        };
      } catch (error) {
        // 22.2: status never fails; degrade to a diagnosable uninitialized view.
        const nexus = mapUnknownError(error);
        const fallback: Row = {
          state: 'uninitialized',
          staleness: 'failed',
          rootId: null,
          activeRoot: null,
          roots: [],
          coverage: null,
          capabilities: { mcpFormats: ['lines', 'json'] },
          self: {
            serverVersion: 'unknown',
            packageName: 'anemia-mcp',
            binaryPath: 'nex',
            projectRoot: '.',
            nodeVersion: process.versions.node,
          },
          lastIntegrityCheck: null,
          degraded: [],
          guidance: ['nex doctor', 'nex init --roots all --write-config --yes', 'nex build'],
          warnings: [{ code: nexus.code, message: nexus.message, severity: 'error' }],
          formatApplied: decision.format,
          formatFallback: decision.fallback,
          ...(decision.reason === null ? {} : { formatReason: decision.reason }),
        };
        return {
          content: [
            {
              type: 'text',
              text:
                decision.format === 'json'
                  ? JSON.stringify(fallback)
                  : renderCompact('status', fallback),
            },
          ],
          structuredContent: fallback,
        };
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search symbols',
      description: 'Search symbols and APIs by name, kind or path prefix.',
      inputSchema: z.object({
        term: z.string(),
        type: z.string().optional().describe('symbol kind'),
        path: z.string().optional().describe('project-relative path prefix'),
        public: z.boolean().optional(),
        internal: z.boolean().optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'search', args, async (input) => {
        const term = typeof input.term === 'string' ? input.term : '';
        if (term.trim() === '') {
          throw nexusError('E00', 'search requires a term', {
            reason: 'the term argument is empty',
            suggestion: 'Pass a symbol name or substring.',
          });
        }
        if (input.public === true && input.internal === true) {
          throw nexusError('E00', 'public and internal are mutually exclusive', {
            reason: 'both filters were provided',
            suggestion: 'Pass either public or internal.',
          });
        }
        const scope = scopeOf(await resolveScope(runtime, input));
        const result = await querySearch(
          {
            projectRoot: runtime.projectRoot,
            cwd: runtime.cwd,
            rootId: scope.rootId,
            roots: scope.roots,
            trustConfig: runtime.options.trustConfig === true,
          },
          term,
          {
            kind: typeof input.type === 'string' ? input.type : undefined,
            pathPrefix: typeof input.path === 'string' ? input.path : undefined,
            publicOnly: input.public === true ? true : input.internal === true ? false : undefined,
          },
        );
        return { ...result.envelope, command: 'search', notes: result.notes };
      });
    },
  );

  server.registerTool(
    'symbol',
    {
      title: 'Symbol details',
      description:
        'Signature, visibility, Surface membership, identity confidence and component props/emits/slots for one symbol.',
      inputSchema: z.object({
        identifier: z.string(),
        history: z.boolean().optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'symbol', args, async (input) => {
        const identifier = typeof input.identifier === 'string' ? input.identifier : '';
        if (identifier.trim() === '') {
          throw nexusError('E00', 'symbol requires an identifier', {
            reason: 'the identifier argument is empty',
            suggestion: 'Pass a symbol name, name chain or symbolId.',
          });
        }
        const scope = scopeOf(await resolveScope(runtime, input));
        const result = await querySymbol(
          {
            projectRoot: runtime.projectRoot,
            cwd: runtime.cwd,
            rootId: scope.rootId,
            roots: scope.roots,
            trustConfig: runtime.options.trustConfig === true,
          },
          identifier,
          input.history === true,
        );
        return {
          ...result.envelope,
          command: 'symbol',
          symbol: result.envelope.items[0] ?? null,
        };
      });
    },
  );

  server.registerTool(
    'references',
    {
      title: 'References',
      description:
        'Complete reference set for one symbol, with certain/heuristic/dynamicUnresolved counts.',
      inputSchema: z.object({
        identifier: z.string(),
        includeHeuristic: z.boolean().optional(),
        noTemplate: z.boolean().optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'references', args, async (input) => {
        const identifier = typeof input.identifier === 'string' ? input.identifier : '';
        if (identifier.trim() === '') {
          throw nexusError('E00', 'references requires an identifier', {
            reason: 'the identifier argument is empty',
            suggestion: 'Pass a symbol name, name chain or symbolId.',
          });
        }
        const scope = scopeOf(await resolveScope(runtime, input));
        const result = await queryReferences(
          {
            projectRoot: runtime.projectRoot,
            cwd: runtime.cwd,
            rootId: scope.rootId,
            roots: scope.roots,
            trustConfig: runtime.options.trustConfig === true,
          },
          identifier,
          input.includeHeuristic === true,
          input.noTemplate !== true,
        );
        return {
          ...result.envelope,
          command: 'references',
          symbol: result.envelope.items[0]?.symbolName ?? null,
        };
      });
    },
  );

  server.registerTool(
    'deps',
    {
      title: 'Dependencies',
      description:
        'File, module, style and static call relations, architecture modules and blind spots.',
      inputSchema: z.object({
        target: z.string().optional(),
        type: z.enum(['file', 'module', 'style', 'call']).optional(),
        reverse: z.boolean().optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'deps', args, async (input) => {
        const scope = scopeOf(await resolveScope(runtime, input));
        const type = (typeof input.type === 'string' ? input.type : 'file') as DependencyQueryType;
        const result = await queryDependencies(
          {
            projectRoot: runtime.projectRoot,
            cwd: runtime.cwd,
            rootId: scope.rootId,
            roots: scope.roots,
            trustConfig: runtime.options.trustConfig === true,
          },
          typeof input.target === 'string' ? input.target : '',
          type,
          input.reverse === true,
        );
        const styleDependents = [
          ...new Set(
            result.envelope.items
              .filter((item) => item.depType.startsWith('style'))
              .map((item) => item.targetFile)
              .filter((file): file is string => typeof file === 'string'),
          ),
        ].sort();
        const coverage = result.envelope.coverage;
        return {
          ...result.envelope,
          command: 'deps',
          type: result.type,
          target: result.target,
          reverse: result.reverse,
          architecture: result.data.modules,
          violations: result.data.violations,
          blindSpots: result.data.blindSpots,
          crossRootEdges: result.data.crossRootEdges,
          styleDependents,
          styleCoverage: {
            filesDiscovered: coverage.styleFiles ?? 0,
            edgesResolved: coverage.styleResolved ?? 0,
            edgesUnresolved: coverage.styleUnresolved ?? 0,
          },
        };
      });
    },
  );

  server.registerTool(
    'impact',
    {
      title: 'Change impact',
      description:
        'Change impact, risk level, affected tests and blind spots for a file or a symbol.',
      inputSchema: z.object({
        target: z.string().optional(),
        symbol: z.string().optional(),
        depth: z.number().int().min(1).max(10).optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'impact', args, async (input) => {
        const target = typeof input.target === 'string' ? input.target : '';
        const symbol = typeof input.symbol === 'string' ? input.symbol : '';
        if (target.trim() === '' && symbol.trim() === '') {
          throw nexusError('E00', 'impact requires a target or a symbol', {
            reason: 'neither target nor symbol was provided',
            suggestion: 'Pass target "<file>" or symbol "<name>".',
          });
        }
        const scope = scopeOf(await resolveScope(runtime, input));
        const result = await analyzeImpact({
          projectRoot: runtime.projectRoot,
          cwd: runtime.cwd,
          rootId: scope.rootId,
          roots: scope.roots,
          trustConfig: runtime.options.trustConfig === true,
          target,
          symbol: symbol === '' ? null : symbol,
          depth: typeof input.depth === 'number' ? input.depth : undefined,
        });
        const data = impactData(result);
        const coverage = data.coverage as
          | { styleFiles?: number; styleResolved?: number; styleUnresolved?: number }
          | null
          | undefined;
        return {
          ...data,
          command: 'impact',
          styleCoverage: {
            filesDiscovered: coverage?.styleFiles ?? 0,
            edgesResolved: coverage?.styleResolved ?? 0,
            edgesUnresolved: coverage?.styleUnresolved ?? 0,
          },
        };
      });
    },
  );

  server.registerTool(
    'context',
    {
      title: 'Task context',
      description:
        'Layered context for a task or target: summary, relations and an optional source excerpt. Supports cursor paging.',
      inputSchema: z.object({
        task: z.string().optional(),
        target: z.string().optional(),
        symbol: z.string().optional(),
        depth: z.number().int().min(1).max(10).optional(),
        cursor: z.string().optional(),
        contextLines: z.number().int().min(0).max(400).optional(),
        root: rootSchema,
        roots: rootsSchema,
        format: formatSchema,
      }),
      outputSchema: envelopeOutput,
    },
    async (raw) => {
      const args = asRow(raw);
      return invoke(runtime, 'context', args, async (input) => {
        const scope = scopeOf(await resolveScope(runtime, input));
        const packet = await runContext({
          projectRoot: runtime.projectRoot,
          cwd: runtime.cwd,
          rootId: scope.rootId,
          roots: scope.roots,
          trustConfig: runtime.options.trustConfig === true,
          task: typeof input.task === 'string' ? input.task : null,
          target: typeof input.target === 'string' ? input.target : null,
          symbol: typeof input.symbol === 'string' ? input.symbol : null,
          depth: typeof input.depth === 'number' ? input.depth : undefined,
          cursor: typeof input.cursor === 'string' ? input.cursor : null,
          contextLines: typeof input.contextLines === 'number' ? input.contextLines : undefined,
        });
        return { ...packet, command: 'context' };
      });
    },
  );

  if (!options.readOnly) {
    server.registerTool(
      'refresh',
      {
        title: 'Incremental refresh',
        description:
          'Incrementally refresh the index. The only writable tool; writes only .nexus/. Refuses full rebuilds and more than 200 changed files.',
        inputSchema: z.object({
          mode: z.string().optional().describe('incremental only; other values are rejected'),
          timeoutMs: z.number().int().min(1000).max(120_000).optional(),
          root: rootSchema,
          format: formatSchema,
        }),
        outputSchema: envelopeOutput,
      },
      async (raw) => {
        const args = asRow(raw);
        return invoke(runtime, 'refresh', args, async (input) => {
          const result = await refreshIndex(runtime, {
            root: typeof input.root === 'string' ? input.root : undefined,
            mode: typeof input.mode === 'string' ? input.mode : undefined,
            timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
            onProgress: (event) => {
              // Progress goes to stderr only; stdout is the protocol channel.
              process.stderr.write(`[refresh] ${event.message}\n`);
            },
          });
          return {
            ...result,
            command: 'refresh',
            notes: result.notes,
          };
        });
      },
    );
  }
}

export type { McpFormat };
