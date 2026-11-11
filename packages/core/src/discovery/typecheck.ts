import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface TypecheckResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputSummary: string;
  durationMs: number;
}

/**
 * Runs the project's own tsconfig through the TypeScript compiler that this
 * tool ships (C4: declared third-party analyzer, no project script execution).
 */
export async function checkTypecheck(
  rootPath: string,
  tsconfigPath: string,
  timeoutMs = 120_000,
): Promise<TypecheckResult> {
  const require = createRequire(import.meta.url);
  let tscPath: string;
  try {
    tscPath = require.resolve('typescript/lib/tsc.js');
  } catch {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      outputSummary: 'cannot resolve typescript/lib/tsc.js',
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  return await new Promise<TypecheckResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [tscPath, '-p', tsconfigPath, '--noEmit', '--pretty', 'false'],
      {
        cwd: rootPath,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (result: TypecheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        exitCode: null,
        timedOut: true,
        outputSummary: `typecheck exceeded ${timeoutMs} ms`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        outputSummary: error.message,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      finish({
        ok: code === 0,
        exitCode: code,
        timedOut: false,
        outputSummary: lines.slice(0, 20).join('\n'),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function typecheckFailureMessage(rootPath: string, result: TypecheckResult): string {
  const label = path.basename(rootPath);
  if (result.timedOut) return `${label}: typecheck timed out`;
  return `${label}: typecheck exited ${result.exitCode ?? 'null'}`;
}
