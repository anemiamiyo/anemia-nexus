import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';
import type { NexusConfig } from './schema.js';
import { configSchema } from './schema.js';
import { zodIssuesToText } from './zod-error.js';

const TS_CONFIG_TIMEOUT_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

export interface TrustEntry {
  path: string;
  contentHash: string;
  trustedAt: string;
}

interface TrustFile {
  version: 1;
  entries: TrustEntry[];
}

export interface TsLoadOptions {
  projectRoot: string;
  configPath: string;
  contentHash: string;
  trustForThisProcess: boolean;
}

export interface TsLoadResult {
  config: NexusConfig;
  authorization: 'flag' | 'trust-file';
  durationMs: number;
}

function readTrustFile(projectRoot: string): TrustFile | null {
  const trustPath = path.join(projectRoot, '.nexus', 'trust.json');
  if (!fs.existsSync(trustPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(trustPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.entries)) return null;
    const entries: TrustEntry[] = [];
    for (const entry of record.entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const value = entry as Record<string, unknown>;
      if (
        typeof value.path === 'string' &&
        typeof value.contentHash === 'string' &&
        typeof value.trustedAt === 'string'
      ) {
        entries.push({
          path: value.path,
          contentHash: value.contentHash,
          trustedAt: value.trustedAt,
        });
      }
    }
    return { version: 1, entries };
  } catch {
    return null;
  }
}

export function findTrustEntry(
  projectRoot: string,
  configPath: string,
  contentHash: string,
): TrustEntry | null {
  const trust = readTrustFile(projectRoot);
  if (!trust) return null;
  const relative = path.relative(projectRoot, configPath).replaceAll('\\', '/');
  for (const entry of trust.entries) {
    if (entry.path !== relative) continue;
    if (entry.contentHash !== contentHash) continue;
    return entry;
  }
  return null;
}

const CHILD_SOURCE = String.raw`
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const configPath = process.env.NEXUS_TS_CONFIG ?? '';
const nonce = process.env.NEXUS_TS_NONCE ?? '';
const blockedModules = new Set([
  'node:net', 'node:tls', 'node:http', 'node:https', 'node:http2', 'node:dgram',
  'node:cluster', 'node:child_process', 'node:worker_threads', 'node:inspector',
]);
const blockedBare = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'cluster', 'child_process', 'worker_threads']);

function isBlocked(specifier) {
  if (blockedModules.has(specifier) || blockedBare.has(specifier)) return true;
  return specifier.startsWith('node:net/') || specifier.startsWith('node:tls/');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBlocked(specifier)) {
      throw new Error('NEXUS_NETWORK_BLOCKED: ' + specifier);
    }
    return nextResolve(specifier, context);
  },
});

const deny = () => {
  throw new Error('NEXUS_NETWORK_BLOCKED');
};
globalThis.fetch = deny;
globalThis.WebSocket = undefined;
globalThis.EventSource = undefined;

function send(message) {
  if (typeof process.send === 'function') process.send(message);
}

try {
  const moduleValue = await import(pathToFileURL(configPath).href);
  const value = moduleValue.default === undefined ? moduleValue.config : moduleValue.default;
  send({ kind: 'nexus-config-result', nonce, ok: true, json: JSON.stringify(value) });
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  send({ kind: 'nexus-config-result', nonce, ok: false, error: text.slice(0, 8192) });
} finally {
  process.exit(0);
}
`;

interface ChildMessage {
  kind?: unknown;
  nonce?: unknown;
  ok?: unknown;
  json?: unknown;
  error?: unknown;
}

/**
 * Loads a `.ts` config in an isolated child process (docs/18-security.md 18.3.2):
 * 5s timeout, IPC serialization, network/child-process/f.write guards, and the
 * same Zod schema as JSON configs. Never `import()`s the config in the main
 * process.
 */
export async function loadTsConfig(options: TsLoadOptions): Promise<TsLoadResult> {
  const { projectRoot, configPath, contentHash, trustForThisProcess } = options;
  const trustEntry = findTrustEntry(projectRoot, configPath, contentHash);
  if (!trustForThisProcess && trustEntry === null) {
    throw nexusError('E18', 'typescript config is executable code and is not trusted', {
      reason: 'no --trust-config flag and no matching .nexus/trust.json entry',
      file: path.relative(projectRoot, configPath).replaceAll('\\', '/'),
      suggestion:
        'This file is executable code: loading it runs it. Trust once with `nex <command> --trust-config`, or add a matching entry to .nexus/trust.json.',
      evidence: { contentHash },
    });
  }
  const authorization: 'flag' | 'trust-file' = trustForThisProcess ? 'flag' : 'trust-file';
  const nonce = randomBytes(16).toString('hex');
  const startedAt = Date.now();

  const result = await new Promise<{ ok: boolean; json?: string; error?: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${projectRoot}`,
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        CHILD_SOURCE,
      ],
      {
        cwd: projectRoot,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          NEXUS_TS_CONFIG: configPath,
          NEXUS_TS_NONCE: nonce,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );

    let stderrBytes = 0;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_CHILD_OUTPUT_BYTES) return;
      const text = chunk.toString('utf8');
      stderrBytes += Buffer.byteLength(text);
      stderr += text.slice(0, MAX_CHILD_OUTPUT_BYTES - (stderrBytes - Buffer.byteLength(text)));
    });

    let settled = false;
    let pending: { ok: boolean; json?: string; error?: string } | null = null;
    const finish = (value: { ok: boolean; json?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'NEXUS_TS_CONFIG_TIMEOUT' });
    }, TS_CONFIG_TIMEOUT_MS);

    child.on('message', (message: unknown) => {
      if (settled || pending !== null) return;
      if (typeof message !== 'object' || message === null) return;
      const parsed = message as ChildMessage;
      if (parsed.kind !== 'nexus-config-result') return;
      if (parsed.nonce !== nonce) return;
      if (parsed.ok === true && typeof parsed.json === 'string') {
        pending = { ok: true, json: parsed.json };
      } else {
        pending = { ok: false, error: typeof parsed.error === 'string' ? parsed.error : stderr };
      }
      child.kill('SIGKILL');
    });

    child.on('error', (error) => {
      finish({ ok: false, error: error.message });
    });

    child.on('close', (code) => {
      if (pending !== null) {
        finish(pending);
        return;
      }
      finish({
        ok: false,
        error: `NEXUS_TS_CONFIG_EXIT_${code ?? 'null'}: ${stderr.slice(0, 2048)}`,
      });
    });
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok || typeof result.json !== 'string') {
    throw nexusError('E17', 'typescript config could not be loaded', {
      reason: result.error ?? 'unknown child process failure',
      file: path.relative(projectRoot, configPath).replaceAll('\\', '/'),
      suggestion:
        'Check the config for syntax errors or unsupported TypeScript syntax (only erasable syntax is supported).',
      evidence: { durationMs, authorization, stderr: result.error?.slice(0, 2000) ?? '' },
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.json) as unknown;
  } catch {
    throw nexusError('E17', 'typescript config did not serialize to JSON', {
      reason: 'the exported value is not JSON-serializable (functions, cycles or symbols)',
      file: path.relative(projectRoot, configPath).replaceAll('\\', '/'),
      suggestion: 'Export a plain data object from the TypeScript config.',
      evidence: { durationMs },
    });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw nexusError('E17', 'typescript config failed schema validation', {
      reason: zodIssuesToText(parsed.error.issues),
      file: path.relative(projectRoot, configPath).replaceAll('\\', '/'),
      suggestion:
        'Fix the reported fields; the TS config is validated by the same schema as JSON configs.',
      evidence: { durationMs },
    });
  }

  return { config: parsed.data, authorization, durationMs };
}
