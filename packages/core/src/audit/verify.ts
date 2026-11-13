import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { NexusConfig } from '../config/schema.js';
import type { CommandConfig } from '../config/schema.js';
import { commandSafetyReason } from '../config/command-safety.js';
import { nexusError } from '../errors.js';
import { sha256Hex } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface TrustEntry {
  id: string;
  signature: string;
  source: 'yes' | 'tty';
  authorizedAt: string;
}

export interface TrustFile {
  version: 1;
  commands: TrustEntry[];
}

export interface VerifyCommandResult {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  purpose: string;
  authorization: 'authorized' | 'unauthorized' | 'dry-run';
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'unauthorized' | 'blocked';
  exitCode: number | null;
  signal: string | null;
  stdoutSummary: string;
  stderrSummary: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  durationMs: number;
  error: string | null;
}

export interface VerifyResult {
  commands: VerifyCommandResult[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface VerifyOptions {
  projectRoot: string;
  config: NexusConfig;
  only?: readonly string[] | null;
  dryRun?: boolean;
  yes?: boolean;
  /** `true` for `nex verify`; `false` when postflight invokes verification. */
  explicit?: boolean;
  purpose?: string;
  onEcho?: (line: string) => void;
}

function trustPath(projectRoot: string): string {
  return path.join(projectRoot, '.nexus', 'trust.json');
}

export function readTrust(projectRoot: string): TrustFile {
  const file = trustPath(projectRoot);
  if (!fs.existsSync(file)) return { version: 1, commands: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { version: 1, commands: [] };
    const record = raw as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.commands))
      return { version: 1, commands: [] };
    const commands: TrustEntry[] = [];
    for (const entry of record.commands) {
      if (typeof entry !== 'object' || entry === null) continue;
      const value = entry as Record<string, unknown>;
      if (typeof value.id !== 'string' || typeof value.signature !== 'string') continue;
      commands.push({
        id: value.id,
        signature: value.signature,
        source: value.source === 'tty' ? 'tty' : 'yes',
        authorizedAt: typeof value.authorizedAt === 'string' ? value.authorizedAt : '',
      });
    }
    return { version: 1, commands };
  } catch {
    return { version: 1, commands: [] };
  }
}

export function writeTrust(projectRoot: string, trust: TrustFile): void {
  const file = trustPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(trust, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function commandSignature(command: CommandConfig): string {
  return sha256Hex(
    stableStringify({
      id: command.id,
      cmd: command.cmd,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
    }),
  );
}

function isTrusted(trust: TrustFile, command: CommandConfig): boolean {
  const signature = commandSignature(command);
  return trust.commands.some((entry) => entry.id === command.id && entry.signature === signature);
}

function authorize(trust: TrustFile, command: CommandConfig, source: 'yes' | 'tty'): void {
  trust.commands = trust.commands.filter((entry) => entry.id !== command.id);
  trust.commands.push({
    id: command.id,
    signature: commandSignature(command),
    source,
    authorizedAt: new Date().toISOString(),
  });
}

function selectCommands(
  config: NexusConfig,
  only: readonly string[] | null | undefined,
): CommandConfig[] {
  const allow = config.commands.allow;
  if (only === undefined || only === null || only.length === 0) return allow;
  const selected: CommandConfig[] = [];
  for (const id of only) {
    const found = allow.find((command) => command.id === id);
    if (found === undefined) {
      throw nexusError('E00', 'verify command id does not exist', {
        reason: `no commands.allow entry with id ${id}`,
        suggestion: 'Use `nex verify --dry-run` to list configured ids.',
        evidence: { ids: allow.map((command) => command.id) },
      });
    }
    selected.push(found);
  }
  return selected;
}

export function assertSafeCommandConfig(command: CommandConfig): void {
  const reason = commandSafetyReason(command);
  if (reason !== null) {
    throw nexusError('E17', 'unsafe verify command', {
      reason,
      suggestion: 'Remove shell metacharacters/destructive commands from commands.allow.',
      evidence: { id: command.id, cmd: command.cmd, args: command.args },
    });
  }
}

function resolveExecutable(projectRoot: string, cmd: string): string {
  if (cmd.includes('/') || cmd.includes('\\')) {
    const absolute = path.resolve(projectRoot, cmd);
    const relative = path.relative(projectRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw nexusError('E17', 'verify command escapes the project root', {
        reason: `resolved command ${absolute} is outside the project root`,
        suggestion: 'Use a command name on PATH or a path inside the project.',
      });
    }
    return absolute;
  }
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where.exe', [cmd], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
      const first = output.split(/\r?\n/).find((line) => line.trim() !== '');
      if (first !== undefined) return first.trim();
    } catch {
      // Fall through: execFile will report ENOENT with a useful message.
    }
  }
  return cmd;
}

function cmdQuote(value: string): string {
  if (/["%!^\r\n]/.test(value)) {
    throw nexusError('E17', 'verify argument cannot be passed to the Windows command shim', {
      reason: `argument contains a reserved character: ${value}`,
      suggestion: 'Use an executable (.exe) or simplify the argument.',
    });
  }
  return `"${value}"`;
}

function spawnSpec(projectRoot: string, command: CommandConfig): { file: string; args: string[] } {
  const resolved = resolveExecutable(projectRoot, command.cmd);
  const lower = resolved.toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    const shim = process.env.ComSpec ?? 'cmd.exe';
    const line = [resolved, ...command.args].map(cmdQuote).join(' ');
    return { file: shim, args: ['/d', '/s', '/c', line] };
  }
  return { file: resolved, args: [...command.args] };
}

function truncateOutput(value: string): { summary: string; bytes: number } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_OUTPUT_BYTES) return { summary: value.slice(0, 4000), bytes };
  return { summary: value.slice(0, 4000), bytes };
}

function runOne(
  projectRoot: string,
  command: CommandConfig,
  cwd: string,
): Promise<VerifyCommandResult> {
  const started = Date.now();
  const { file, args } = spawnSpec(projectRoot, command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: command.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const timedOut =
          error !== null &&
          typeof error === 'object' &&
          ('killed' in error || 'signal' in error) &&
          (error as { killed?: boolean }).killed === true;
        const message = error instanceof Error ? error.message : null;
        const truncated =
          message !== null && /maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/i.test(message);
        const out = truncateOutput(stdout ?? '');
        const err = truncateOutput(stderr ?? '');
        resolve({
          id: command.id,
          cmd: command.cmd,
          args: [...command.args],
          cwd: path.relative(projectRoot, cwd).replaceAll('\\', '/') || '.',
          timeoutMs: command.timeoutMs,
          purpose: '',
          authorization: 'authorized',
          status: error === null ? 'passed' : timedOut ? 'timedOut' : 'failed',
          exitCode:
            error !== null && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code?: number }).code ?? null)
              : error === null
                ? 0
                : null,
          signal:
            error !== null && typeof (error as { signal?: unknown }).signal === 'string'
              ? ((error as { signal?: string }).signal ?? null)
              : null,
          stdoutSummary: out.summary,
          stderrSummary: err.summary,
          stdoutBytes: out.bytes,
          stderrBytes: err.bytes,
          truncated,
          durationMs: Date.now() - started,
          error: message,
        });
      },
    );
  });
}

function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    readline.question(prompt, (answer) => {
      readline.close();
      resolve(answer);
    });
  });
}

/**
 * Authorized command orchestration (docs/18-security.md 18.4). Never uses a
 * shell except the fixed Windows `.cmd` shim; the whitelist is complete
 * command + args and every field is re-validated here.
 */
export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const commands = selectCommands(options.config, options.only);
  const explicit = options.explicit !== false;
  const projectRoot = path.resolve(options.projectRoot);
  const trust = readTrust(projectRoot);
  const results: VerifyCommandResult[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  for (const command of commands) {
    assertSafeCommandConfig(command);
    const cwd = path.resolve(projectRoot, command.cwd);
    const relative = path.relative(projectRoot, cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw nexusError('E17', 'verify cwd is outside the project root', {
        reason: `${command.id}: ${command.cwd}`,
        suggestion: 'Use a project-relative cwd.',
      });
    }
    let authorized = isTrusted(trust, command);
    if (!authorized && !options.dryRun) {
      if (options.yes === true) {
        authorize(trust, command, 'yes');
        writeTrust(projectRoot, trust);
        authorized = true;
      } else if (interactive && explicit) {
        const answer = await askQuestion(
          `Run "${command.cmd} ${command.args.join(' ')}" (cwd ${command.cwd}, timeout ${command.timeoutMs}ms)? [y/N] `,
        );
        if (/^y(es)?$/i.test(answer.trim())) {
          authorize(trust, command, 'tty');
          writeTrust(projectRoot, trust);
          authorized = true;
        }
      }
    }
    if (!authorized && !options.dryRun) {
      if (explicit) {
        throw nexusError('E12', 'verify command is not authorized', {
          reason: `command ${command.id} has no matching .nexus/trust.json entry`,
          suggestion: `Re-run with --yes to authorize, or use --dry-run to inspect: ${command.cmd} ${command.args.join(' ')}`,
          evidence: { id: command.id },
        });
      }
      skipped.push({ id: command.id, reason: 'skipped-unauthorized' });
      results.push({
        id: command.id,
        cmd: command.cmd,
        args: [...command.args],
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        purpose: options.purpose ?? 'verify',
        authorization: 'unauthorized',
        status: 'skipped',
        exitCode: null,
        signal: null,
        stdoutSummary: '',
        stderrSummary: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        durationMs: 0,
        error: null,
      });
      continue;
    }
    const echo = `${command.cmd} ${command.args.join(' ')}  cwd=${command.cwd} timeout=${command.timeoutMs}ms purpose=${options.purpose ?? 'verify'} authorization=${authorized ? 'authorized' : 'dry-run'}`;
    options.onEcho?.(echo);
    if (options.dryRun) {
      results.push({
        id: command.id,
        cmd: command.cmd,
        args: [...command.args],
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        purpose: options.purpose ?? 'verify',
        authorization: authorized ? 'authorized' : 'dry-run',
        status: 'skipped',
        exitCode: null,
        signal: null,
        stdoutSummary: '',
        stderrSummary: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        durationMs: 0,
        error: null,
      });
      continue;
    }
    const result = await runOne(projectRoot, command, cwd);
    results.push({
      ...result,
      purpose: options.purpose ?? 'verify',
      authorization: 'authorized',
    });
  }
  return { commands: results, skipped };
}
