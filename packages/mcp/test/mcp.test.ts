import fs from 'node:fs';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from 'anemia-mcp';
import { closeRuntime, createMcpServer, createRuntime, type RuntimeState } from 'anemia-mcp';

import { cleanup, indexFixture, makeEmptyProject, makeProject } from '../../core/test/helpers.js';

interface Harness {
  directory: string;
  runtime: RuntimeState;
  client: Client;
  close(): Promise<void>;
}

const directories: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop() as Harness;
    await harness.close();
  }
  while (directories.length > 0) cleanup(directories.pop() as string);
});

async function connect(
  directory: string,
  options: { readOnly?: boolean; autoBootstrap?: boolean; watch?: boolean } = {},
): Promise<Harness> {
  const runtime = createRuntime({
    projectRoot: directory,
    cwd: directory,
    watch: options.watch,
    readOnly: options.readOnly,
    autoBootstrap: options.autoBootstrap,
  });
  const { server } = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'nexus-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  const harness: Harness = {
    directory,
    runtime,
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best effort
      }
      try {
        await server.close();
      } catch {
        // best effort
      }
      await closeRuntime(runtime);
    },
  };
  harnesses.push(harness);
  return harness;
}

async function indexedFixture(
  fixture: string,
  label: string,
  options: { readOnly?: boolean } = {},
): Promise<Harness> {
  const indexed = await indexFixture(fixture, label);
  directories.push(indexed.directory);
  return connect(indexed.directory, options);
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function call(
  harness: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  return (await harness.client.callTool({ name, arguments: args })) as ToolCallResult;
}

function text(result: ToolCallResult): string {
  return result.content.map((entry) => entry.text ?? '').join('\n');
}

describe('MCP protocol and tool registry (14.1)', () => {
  it('exposes exactly the eight stable tool names', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-list');
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const tool of listed.tools) {
      expect(tool.description ?? '').not.toMatch(/pretty|markdown/i);
      const format = (tool.inputSchema as { properties?: Record<string, unknown> }).properties
        ?.format as { description?: string; enum?: unknown } | undefined;
      if (format !== undefined) {
        expect(format.description ?? '').not.toMatch(/pretty|markdown/i);
        expect(format.enum).toBeUndefined();
      }
    }
  });

  it('returns status with the 14.1 required fields and never errors', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-status');
    const result = await call(harness, 'status');
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.state).toBe('ready');
    expect(data.staleness).toBe('fresh');
    expect(typeof data.buildFingerprint).toBe('string');
    expect(String(data.buildFingerprint).length).toBe(12);
    expect(Array.isArray(data.roots)).toBe(true);
    expect(data.capabilities).toMatchObject({ mcpFormats: ['lines', 'json'] });
    expect(data.self).toMatchObject({ packageName: 'anemia-mcp', projectRoot: '.' });
    expect(data.lastIntegrityCheck).toBeTruthy();
    expect(Array.isArray(data.degraded)).toBe(true);
  });
});

describe('MCP query tools reuse core query logic', () => {
  it('serves search, symbol, references, deps, impact and context', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-tools');
    const search = await call(harness, 'search', { term: 'add' });
    expect(search.isError).toBeUndefined();
    expect((search.structuredContent?.items as unknown[]).length).toBeGreaterThan(0);

    const symbol = await call(harness, 'symbol', { identifier: 'add' });
    expect(symbol.isError).toBeUndefined();
    expect((symbol.structuredContent?.symbol as { name?: string }).name).toBe('add');

    const references = await call(harness, 'references', { identifier: 'add' });
    expect(references.isError).toBeUndefined();
    expect(references.structuredContent?.counts).toBeTruthy();

    const deps = await call(harness, 'deps', { target: 'src/math.ts', type: 'file' });
    expect(deps.isError).toBeUndefined();
    expect(Array.isArray(deps.structuredContent?.items)).toBe(true);

    const impact = await call(harness, 'impact', { target: 'src/math.ts' });
    expect(impact.isError).toBeUndefined();
    expect(impact.structuredContent?.risk).toBeTruthy();

    const context = await call(harness, 'context', {
      symbol: 'add',
      contextLines: 4,
    });
    expect(context.isError).toBeUndefined();
    const layers = context.structuredContent?.layers as { source?: unknown[] } | undefined;
    expect(layers?.source?.length).toBe(1);
  });

  it('keeps output reproducible for the same index and arguments', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-idempotent');
    const first = await call(harness, 'search', { term: 'add', format: 'json' });
    const second = await call(harness, 'search', { term: 'add', format: 'json' });
    expect(text(second)).toBe(text(first));
  });
});

describe('MCP format guardrails (14.1.5 / 17.2.1)', () => {
  it('falls back to lines for missing, pretty, markdown, xml and garbage formats', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-format');
    for (const format of [undefined, 'pretty', 'markdown', 'xml', '', 'nonsense']) {
      const result = await call(harness, 'search', {
        term: 'add',
        ...(format === undefined ? {} : { format }),
      });
      expect(result.isError).toBeUndefined();
      const body = text(result);
      expect(body.includes('\u001b[')).toBe(false);
      expect(result.structuredContent?.formatApplied).toBe('lines');
      if (format === 'lines' || format === 'json') {
        expect(result.structuredContent?.formatFallback).toBe(false);
      } else {
        expect(result.structuredContent?.formatFallback).toBe(true);
        expect(String(result.structuredContent?.formatReason)).toContain(
          format === undefined || format === '' ? 'missing-format' : 'unknown-format',
        );
      }
    }
    const json = await call(harness, 'search', { term: 'add', format: 'json' });
    expect(json.structuredContent?.formatApplied).toBe('json');
    expect(json.structuredContent?.formatFallback).toBe(false);
    expect(() => JSON.parse(text(json))).not.toThrow();
  });
});

describe('MCP errors and scope routing', () => {
  it('returns isError with E05 instead of throwing', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-error');
    const result = await call(harness, 'symbol', { identifier: 'definitely-missing-symbol' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('E05');
    expect(result.structuredContent).toBeUndefined();
  });

  it('requires an explicit root when several roots are indexed', async () => {
    const indexed = await indexFixture('F14-multi-root', 'mcp-multi');
    directories.push(indexed.directory);
    const harness = await connect(indexed.directory);
    const result = await call(harness, 'search', { term: 'a' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('E16');
    const explicit = await call(harness, 'search', { term: 'a', roots: 'all' });
    expect(explicit.isError).toBeUndefined();
  });
});

describe('MCP refresh guardrails (14.1.1)', () => {
  it('applies an incremental change and then reports noop without writing', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-refresh');
    fs.appendFileSync(
      path.join(harness.directory, 'src', 'math.ts'),
      '\nexport const phase07RefreshMarker = true;\n',
    );
    const first = await call(harness, 'refresh', { timeoutMs: 120000 });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent?.indexMutation).toBe(true);
    expect(first.structuredContent?.noop).toBe(false);
    expect(Number(first.structuredContent?.changed)).toBeGreaterThan(0);
    expect(first.structuredContent?.filesUpdated).toBeGreaterThan(0);
    expect(first.structuredContent?.staleness).toBe('fresh');
    const second = await call(harness, 'refresh', { timeoutMs: 120000 });
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent?.noop).toBe(true);
    expect(second.structuredContent?.changed).toBe(0);
  });

  it('rejects a global rebuild instead of silently running one', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-refresh-global');
    fs.appendFileSync(path.join(harness.directory, 'tsconfig.json'), '\n');
    const result = await call(harness, 'refresh', { timeoutMs: 30000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('E13');
    expect(text(result)).toContain('full rebuild');
  });

  it('returns E08 when another process holds the root lock', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-refresh-lock');
    const rootId = fs
      .readdirSync(path.join(harness.directory, '.nexus', 'roots'))
      .find((entry) => !entry.endsWith('.lock'));
    expect(rootId).toBeTruthy();
    const lockDir = path.join(harness.directory, '.nexus', 'roots', `${rootId}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    try {
      const result = await call(harness, 'refresh', { timeoutMs: 5000 });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('E08');
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

describe('MCP modes', () => {
  it('does not register refresh in read-only mode', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-readonly', {
      readOnly: true,
    });
    const listed = await harness.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('refresh');
    expect(listed.tools).toHaveLength(7);
  });

  it('reports uninitialized guidance and E01 for queries without an index', async () => {
    const directory = makeEmptyProject('mcp-empty');
    directories.push(directory);
    const harness = await connect(directory);
    const status = await call(harness, 'status');
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent?.state).toBe('uninitialized');
    const onboarding = status.structuredContent?.onboarding as
      { nextCommands?: string[]; assets?: string[] } | undefined;
    expect(onboarding?.nextCommands).toContain('nex init --roots all --write-config --yes');
    expect(onboarding?.assets).toContain('nex print mcp-config');
    const query = await call(harness, 'search', { term: 'anything' });
    expect(query.isError).toBe(true);
    expect(text(query)).toContain('E01');
  });

  it('represents an in-flight bootstrap as staleness=indexing without claiming ready', async () => {
    const directory = makeEmptyProject('mcp-bootstrap-status');
    directories.push(directory);
    const harness = await connect(directory);
    harness.runtime.bootstrap = {
      state: 'indexing',
      message: 'building',
      percent: 10,
      errorCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const status = await call(harness, 'status');
    expect(status.structuredContent?.state).toBe('uninitialized');
    expect(status.structuredContent?.staleness).toBe('indexing');
    const query = await call(harness, 'search', { term: 'anything' });
    expect(query.isError).toBeUndefined();
    expect(text(query)).toContain('indexing');
  });

  it('auto-bootstraps a configured project in the background', async () => {
    const directory = makeProject('F07-api-surface', 'mcp-bootstrap');
    directories.push(directory);
    const { runInit } = await import('anemia-core');
    await runInit({
      projectRoot: directory,
      roots: 'all',
      writeConfig: true,
      yes: true,
      nonInteractive: true,
      skipTypecheck: true,
    });
    const harness = await connect(directory, { autoBootstrap: true });
    const { startBootstrap } = await import('anemia-mcp');
    startBootstrap(harness.runtime);
    const deadline = Date.now() + 120_000;
    let state = harness.runtime.bootstrap.state;
    while (Date.now() < deadline) {
      state = harness.runtime.bootstrap.state;
      if (state === 'ready' || state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(state).toBe('ready');
    const status = await call(harness, 'status');
    expect(status.structuredContent?.state).toBe('ready');
  });

  it('refreshes after a watch event and indexes the new symbol', async () => {
    const harness = await indexedFixture('F07-api-surface', 'mcp-watch', {
      readOnly: false,
    });
    const { startWatch, closeRuntime } = await import('anemia-mcp');
    harness.runtime.options.watch = true;
    startWatch(harness.runtime);
    fs.appendFileSync(
      path.join(harness.directory, 'src', 'math.ts'),
      '\nexport function phase07WatchMarker(): string {\n  return "watch";\n}\n',
    );
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (harness.runtime.refresh.lastChanged > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(harness.runtime.refresh.lastChanged).toBeGreaterThan(0);
    const search = await call(harness, 'search', { term: 'phase07WatchMarker' });
    expect(search.isError).toBeUndefined();
    expect((search.structuredContent?.items as unknown[]).length).toBeGreaterThan(0);
    await closeRuntime(harness.runtime);
  });
});
