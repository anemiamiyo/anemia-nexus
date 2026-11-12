import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/cli.js';
import { cleanup, makeEmptyProject, makeProject } from '../../core/test/helpers.js';

const originalCwd = process.cwd();

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
  process.chdir(originalCwd);
  process.exitCode = 0;
});

describe('help, version and usage errors', () => {
  it('shows grouped help and hides compatibility aliases from the main list', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Lifecycle');
    expect(result.stdout).toContain('Query');
    expect(result.stdout).toContain('Governance');
    expect(result.stdout).toContain('Audit');
    expect(result.stdout).toContain('Access');
    expect(result.stdout).toContain('Test');
    expect(result.stdout).toContain('Compatibility aliases');
    expect(result.stdout).toContain('query        -> search');
    expect(result.stdout).not.toContain('query [term]');
    expect(result.stdout).not.toContain('query [options]');
  });

  it('prints package, version and Node version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('anemia-cli');
    expect(result.stdout).toContain('node');
    expect(result.stdout).toContain(process.versions.node);
  });

  it('returns 64 for an unknown command', async () => {
    const result = await runCli(['does-not-exist']);
    expect(result.code).toBe(64);
    expect(result.stdout + result.stderr).toContain('E00');
  });

  it('returns 64 for an invalid --format', async () => {
    const result = await runCli(['status', '--format', 'xml']);
    expect(result.code).toBe(64);
    expect(result.stdout).toContain('E00');
  });

  it('returns 64 when --root and --roots are both present', async () => {
    const result = await runCli(['status', '--root', 'a', '--roots', 'all']);
    expect(result.code).toBe(64);
    expect(result.stdout).toContain('E00');
  });

  it('rejects --flag=value for boolean flags', async () => {
    const result = await runCli(['status', '--compact=true']);
    expect(result.code).toBe(64);
    expect(result.stdout).toContain('E00');
  });
});

describe('lifecycle commands', () => {
  it('status is uninitialized and exits 0 without an index', async () => {
    const directory = makeEmptyProject('cli-empty');
    try {
      const result = await runCli(['status', '--format', 'json'], directory);
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        state: string;
        staleness: string;
        capabilities: { styleDependency: string };
      };
      expect(payload.state).toBe('uninitialized');
      expect(payload.staleness).toBe('uninitialized');
      expect(payload.capabilities.styleDependency).toBe('none');
    } finally {
      cleanup(directory);
    }
  });

  it('init without --roots fails with E15 in non-interactive mode', async () => {
    const directory = makeProject('F01-reexport-chain', 'cli-init-missing');
    try {
      const result = await runCli(['init', '--non-interactive'], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('E15');
      expect(fs.existsSync(path.join(directory, '.nexus', 'nexus.config.json'))).toBe(false);
    } finally {
      cleanup(directory);
    }
  });

  it('init requires --yes with --write-config in non-interactive mode', async () => {
    const directory = makeProject('F01-reexport-chain', 'cli-init-yes');
    try {
      const result = await runCli(
        ['init', '--roots', 'all', '--write-config', '--non-interactive'],
        directory,
      );
      expect(result.code).toBe(64);
      expect(result.stdout).toContain('E00');
    } finally {
      cleanup(directory);
    }
  });

  it('runs init -> build -> status -> references and keeps four formats consistent', async () => {
    const directory = makeProject('F01-reexport-chain', 'cli-f01');
    try {
      const init = await runCli(
        [
          'init',
          '--roots',
          'all',
          '--write-config',
          '--yes',
          '--non-interactive',
          '--format',
          'json',
        ],
        directory,
      );
      expect(init.code).toBe(0);
      const initPayload = JSON.parse(init.stdout) as { written: boolean; selected: string[] };
      expect(initPayload.written).toBe(true);
      expect(initPayload.selected).toEqual(['f01-reexport-chain']);

      const build = await runCli(['build', '--format', 'json'], directory);
      expect(build.code).toBe(0);
      const buildPayload = JSON.parse(build.stdout) as {
        failedRoots: string[];
        coverage: { filesCovered: number };
      };
      expect(buildPayload.failedRoots).toEqual([]);
      expect(buildPayload.coverage.filesCovered).toBeGreaterThan(0);

      const status = await runCli(['status', '--format', 'json'], directory);
      expect(status.code).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as { state: string; staleness: string };
      expect(statusPayload.state).toBe('ready');
      expect(statusPayload.staleness).toBe('fresh');

      const json = await runCli(['references', 'add', '--format', 'json'], directory);
      expect(json.code).toBe(0);
      const jsonPayload = JSON.parse(json.stdout) as {
        counts: { total: number; certain: number };
        items: unknown[];
        coverage: Record<string, number>;
      };
      expect(jsonPayload.counts.total).toBe(7);
      expect(jsonPayload.counts.certain).toBe(7);
      expect(jsonPayload.items).toHaveLength(7);
      expect(jsonPayload.coverage.filesCovered).toBe(10);

      const lines = await runCli(['references', 'add', '--format', 'lines'], directory);
      expect(lines.code).toBe(0);
      expect(lines.stdout).not.toContain('\u001b');
      const entryLines = lines.stdout.split('\n').filter((line) => /^\s*src\//.test(line));
      expect(entryLines).toHaveLength(7);
      expect(lines.stdout).toContain('counts.total=7');
      expect(lines.stdout).toContain('staleness=fresh');
      expect(lines.stdout).toContain('truncated=false');

      const markdown = await runCli(['references', 'add', '--format', 'markdown'], directory);
      expect(markdown.code).toBe(0);
      expect(markdown.stdout).not.toContain('\u001b');
      expect(markdown.stdout).toContain('counts.total=7');
      expect(markdown.stdout.split('\n').filter((line) => line.startsWith('| src/'))).toHaveLength(
        7,
      );

      const pretty = await runCli(['references', 'add', '--format', 'pretty'], directory);
      expect(pretty.code).toBe(0);
      expect(pretty.stdout).not.toContain('\u001b');
      expect(pretty.stdout.split('\n').filter((line) => /^\s*src\//.test(line))).toHaveLength(7);
    } finally {
      cleanup(directory);
    }
  });

  it('never returns fake success for unimplemented commands', async () => {
    const directory = makeEmptyProject('cli-stub');
    try {
      for (const command of ['update', 'deps', 'impact', 'mcp', 'print', 'test']) {
        const result = await runCli([command, '--format', 'json'], directory);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain('E24');
        expect(result.stdout).toContain('not provided');
      }
    } finally {
      cleanup(directory);
    }
  });

  it('prints the configuration schema for doctor --schema', async () => {
    const directory = makeEmptyProject('cli-schema');
    try {
      fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, '.nexus', 'nexus.config.json'),
        JSON.stringify({ configVersion: 1 }),
      );
      const result = await runCli(['doctor', '--schema'], directory);
      expect(result.code).toBe(0);
      const schema = JSON.parse(result.stdout) as {
        type: string;
        properties: Record<string, unknown>;
      };
      expect(schema.type).toBe('object');
      expect(schema.properties.configVersion).toBeDefined();
    } finally {
      cleanup(directory);
    }
  });

  it('writes an explicit --output-file and leaves stdout empty', async () => {
    const directory = makeEmptyProject('cli-output');
    try {
      const target = path.join(directory, 'out.json');
      const result = await runCli(
        ['status', '--format', 'json', '--output-file', target],
        directory,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      const payload = JSON.parse(fs.readFileSync(target, 'utf8')) as { state: string };
      expect(payload.state).toBe('uninitialized');
    } finally {
      cleanup(directory);
    }
  });
});

describe('API Surface commands', () => {
  it('writes a baseline, refuses an implicit overwrite and fails on breaking diff', async () => {
    const directory = makeProject('F07-api-surface', 'cli-surface');
    try {
      let result = await runCli(['init', '--roots', 'all', '--write-config', '--yes'], directory);
      expect(result.code).toBe(0);
      result = await runCli(['build'], directory);
      expect(result.code).toBe(0);

      result = await runCli(['api-snapshot', '--format', 'json'], directory);
      expect(result.code).toBe(0);
      const snapshot = JSON.parse(result.stdout) as {
        path: string;
        counts: { entries: number };
      };
      expect(snapshot.path).toBe('nexus.baseline.json');
      expect(snapshot.counts.entries).toBeGreaterThan(0);
      const baselinePath = path.join(directory, 'nexus.baseline.json');
      expect(fs.existsSync(baselinePath)).toBe(true);

      result = await runCli(['api-snapshot'], directory);
      expect(result.code).toBe(64);
      expect(result.stdout).toContain('E00');

      result = await runCli(['api-diff', '--format', 'json'], directory);
      expect(result.code).toBe(0);
      const clean = JSON.parse(result.stdout) as { counts: { total: number } };
      expect(clean.counts.total).toBe(0);

      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
        roots: Record<string, { entries: Array<{ name: string }> }>;
      };
      const root = Object.values(baseline.roots)[0]!;
      root.entries = root.entries.filter((entry) => entry.name !== 'add');
      fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

      result = await runCli(['api-diff', '--format', 'json', '--fail-on', 'additive'], directory);
      expect(result.code).toBe(1);
      const diff = JSON.parse(result.stdout) as {
        counts: { additive: number; breaking: number };
      };
      expect(diff.counts.additive).toBeGreaterThan(0);
      expect(diff.counts.breaking).toBe(0);

      const format = root.entries.find((entry) => entry.name === 'format') as {
        normalizedSignature: string;
      };
      format.normalizedSignature = `${format.normalizedSignature} /* mutated */`;
      fs.writeFileSync(
        baselinePath,
        `${JSON.stringify(baseline, null, 2)}
`,
      );
      result = await runCli(['api-diff', '--format', 'json'], directory);
      expect(result.code).toBe(2);
      const ambiguous = JSON.parse(result.stdout) as { counts: { ambiguous: number } };
      expect(ambiguous.counts.ambiguous).toBeGreaterThan(0);
    } finally {
      cleanup(directory);
    }
  }, 180_000);
});
