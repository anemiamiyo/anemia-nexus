import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface McpProbeResult {
  ok: boolean;
  protocolVersion: string | null;
  tools: string[];
  durationMs: number;
  error: string | null;
  stderr: string;
}

interface ProbeOptions {
  entry: string;
  cwd: string;
  timeoutMs?: number;
  /** Test-only override; production always runs the CLI entry with `mcp`. */
  command?: string;
  args?: string[];
}

/**
 * `doctor --mcp` (14.1.4): spawn the real `nex mcp` binary once in an isolated
 * temporary directory, do initialize -> tools/list, and terminate. This is a
 * probe, not a client library; it never writes platform configuration and
 * never calls refresh.
 */
export async function probeMcpServer(options: ProbeOptions): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();
  return await new Promise<McpProbeResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    let protocolVersion: string | null = null;
    let tools: string[] = [];
    const finish = (result: Omit<McpProbeResult, 'durationMs' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
      resolve({ ...result, durationMs: Date.now() - started, stderr });
    };
    const child = spawn(
      options.command ?? process.execPath,
      options.args ?? [options.entry, 'mcp'],
      {
        cwd: options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => {
      finish({
        ok: false,
        protocolVersion,
        tools,
        error: `MCP server did not answer within ${timeoutMs} ms`,
      });
    }, timeoutMs);
    timer.unref?.();
    const send = (message: Record<string, unknown>): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // stdin may be closed by an early crash; the close handler reports it.
      }
    };
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ok: false, protocolVersion, tools, error: error.message });
    });
    child.on('close', (code) => {
      if (!settled) {
        finish({
          ok: false,
          protocolVersion,
          tools,
          error: `MCP server exited before the handshake completed (code ${String(code)})`,
        });
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '' || !line.startsWith('{')) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1) {
          const result =
            typeof message.result === 'object' && message.result !== null
              ? (message.result as Record<string, unknown>)
              : {};
          protocolVersion =
            typeof result.protocolVersion === 'string' ? result.protocolVersion : null;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }
        if (message.id === 2) {
          const result =
            typeof message.result === 'object' && message.result !== null
              ? (message.result as Record<string, unknown>)
              : {};
          const listed = Array.isArray(result.tools) ? result.tools : [];
          tools = listed
            .map((entry) =>
              typeof entry === 'object' && entry !== null
                ? (entry as Record<string, unknown>).name
                : null,
            )
            .filter((name): name is string => typeof name === 'string')
            .sort();
          finish({
            ok: tools.length === 8 && protocolVersion !== null,
            protocolVersion,
            tools,
            error: tools.length === 8 ? null : `expected 8 tools, received ${tools.length}`,
          });
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'nex-doctor', version: '0.0.0' },
      },
    });
  });
}

export function withProbeDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-probe-'));
  return action(directory).finally(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
