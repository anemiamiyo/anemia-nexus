import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/cli.js';
import { probeMcpServer } from '../src/mcp-probe.js';
import { cleanup, indexFixture, type IndexedFixture } from '../../core/test/helpers.js';

const originalCwd = process.cwd();
const directories: string[] = [];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd?: string): Promise<RunResult> {
  if (cwd !== undefined) process.chdir(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
  try {
    const code = await run(['node', 'nex', ...args]);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
}

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
  process.chdir(originalCwd);
  process.exitCode = 0;
});

async function fixture(): Promise<IndexedFixture> {
  const indexed = await indexFixture('F07-api-surface', 'ops-cli');
  directories.push(indexed.directory);
  return indexed;
}

describe('nex print integration assets (14.2/14.3)', () => {
  it('prints MCP config JSON for each client and writes no file', async () => {
    const indexed = await fixture();
    const before = fs.readdirSync(indexed.directory, { recursive: true }).length;
    for (const client of ['dsh', 'claude', 'cursor']) {
      const result = await runCli(['print', 'mcp-config', '--client', client], indexed.directory);
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(payload.mcpServers['anemia-nexus']?.command).toBe('npx');
      expect(payload.mcpServers['anemia-nexus']?.args).toContain('mcp');
    }
    const after = fs.readdirSync(indexed.directory, { recursive: true }).length;
    expect(after).toBe(before);
  });

  it('prints an AGENTS template and a Skill template without writing', async () => {
    const indexed = await fixture();
    const agents = await runCli(['print', 'agents'], indexed.directory);
    expect(agents.code).toBe(0);
    expect(agents.stdout).toContain('nex status');
    expect(agents.stdout).toContain('## 配置');
    expect(agents.stdout).toContain('## 格式');
    const skill = await runCli(['print', 'skill'], indexed.directory);
    expect(skill.code).toBe(0);
    expect(skill.stdout).toContain('name: nexus');
    expect(skill.stdout).toContain('起步');
  });

  it('keeps the compatibility aliases equivalent', async () => {
    const indexed = await fixture();
    const direct = await runCli(['print', 'agents'], indexed.directory);
    const alias = await runCli(['agents'], indexed.directory);
    expect(alias.code).toBe(direct.code);
    expect(alias.stdout).toBe(direct.stdout);
  });

  it('rejects unknown assets, clients and misplaced --client', async () => {
    const indexed = await fixture();
    expect((await runCli(['print', 'bogus'], indexed.directory)).code).toBe(64);
    expect(
      (await runCli(['print', 'mcp-config', '--client', 'bogus'], indexed.directory)).code,
    ).toBe(64);
    expect((await runCli(['print', 'agents', '--client', 'dsh'], indexed.directory)).code).toBe(64);
  });

  it('never writes even when --output-file is requested', async () => {
    const indexed = await fixture();
    const result = await runCli(
      ['print', 'agents', '--output-file', 'agents.md'],
      indexed.directory,
    );
    expect(result.code).toBe(64);
    expect(fs.existsSync(path.join(indexed.directory, 'agents.md'))).toBe(false);
  });
});

describe('nex similar / audit-duplicates / context', () => {
  it('prints similar candidates with scores', async () => {
    const indexed = await fixture();
    const result = await runCli(['similar', 'add'], indexed.directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('score=');
    expect(result.stdout).toContain('9.1.1');
    expect(result.stdout).not.toContain('\u001b[');
    expect(result.stdout).toContain('summary');
  });

  it('reports duplicate groups with a disclaimer and warning exit code', async () => {
    const indexed = await fixture();
    const result = await runCli(['audit-duplicates', '--threshold', '0.7'], indexed.directory);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('not equivalent');
    expect(result.stdout).toContain('group');
    expect(result.stdout).toContain('paramCountDelta');
  });

  it('prints layered context with a source excerpt', async () => {
    const indexed = await fixture();
    const result = await runCli(
      ['context', '--symbol', 'add', '--context-lines', '4'],
      indexed.directory,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('context task=');
    expect(result.stdout).toContain('layer source');
    expect(result.stdout).toContain('function add');
  });
});

describe('doctor repair and MCP probe', () => {
  it('requires --yes for repair in non-interactive mode', async () => {
    const indexed = await fixture();
    const result = await runCli(['doctor', '--repair'], indexed.directory);
    expect(result.code).toBe(64);
    expect(result.stdout).toContain('E00');
  });

  it('repairs .nexus derived data only', async () => {
    const indexed = await fixture();
    fs.rmSync(path.join(indexed.directory, '.nexus', 'workspace.json'), { force: true });
    const result = await runCli(['doctor', '--repair', '--yes'], indexed.directory);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('repair');
    expect(fs.existsSync(path.join(indexed.directory, '.nexus', 'workspace.json'))).toBe(true);
  });

  it('probes a stdio MCP child and lists eight tools', async () => {
    const child = path.join(process.cwd(), 'packages', 'mcp', 'test', 'mcp-child.mjs');
    const probe = await probeMcpServer({
      entry: child,
      cwd: process.cwd(),
      command: process.execPath,
      args: [child],
      timeoutMs: 15000,
    });
    expect(probe.ok).toBe(true);
    expect(probe.protocolVersion).toBe('2025-06-18');
    expect(probe.tools).toHaveLength(8);
    expect(probe.error).toBeNull();
  });
});
