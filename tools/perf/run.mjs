import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * P1–P8 performance collector (docs/16-nfr-and-errors.md 16.2).
 *
 * usage: node tools/perf/run.mjs --loc 10000 --repetitions 3 [--output file]
 *
 * The harness is explicit: it writes only the requested output file and its
 * generated projects under .nexus/test-tmp (ignored by Git).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'main.js');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const loc = Number(arg('--loc', '10000'));
const repetitions = Math.max(3, Number(arg('--repetitions', '3')));
const output = arg('--output', null);
const linesPerFile = 100;
const files = Math.max(10, Math.round(loc / linesPerFile));
const WORK = path.join(REPO, '.nexus', 'test-tmp', 'perf');
const project = path.join(WORK, `loc-${loc}`);

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function runCli(cliArgs, cwd, env = {}, capture = true) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...cliArgs], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    windowsHide: true,
  });
  const durationMs = Math.round(performance.now() - started);
  let json = null;
  if (capture) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
  }
  return {
    status: result.status,
    durationMs,
    json,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function readManifest(rootDir) {
  const roots = path.join(rootDir, '.nexus', 'roots');
  if (!fs.existsSync(roots)) return null;
  for (const entry of fs.readdirSync(roots)) {
    if (entry.endsWith('.lock')) continue;
    const file = path.join(roots, entry, 'manifest.json');
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}
function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

const machine = {
  nodeVersion: process.versions.node,
  os: os.platform(),
  osVersion: os.version(),
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  cpuCores: os.cpus().length,
  availableMemMB: Math.round(os.freemem() / (1024 * 1024)),
};

function baseRecord(scenario, durationMs, extra = {}) {
  const manifest = readManifest(project);
  const tsFiles = files;
  const dbBytes = (manifest?.dbBytes ?? 0) + (manifest?.walBytes ?? 0);
  return {
    scenario,
    projectLoc: files * linesPerFile,
    fileCount: tsFiles,
    dependencyCount: 0,
    tsRatio: 1,
    vueRatio: 0,
    ...machine,
    durationMs,
    peakRssMB: manifest?.memory?.peakRssMB ?? null,
    sqliteSizeMB: dbBytes === 0 ? null : Math.round((dbBytes / (1024 * 1024)) * 100) / 100,
    degraded: manifest?.degraded ?? [],
    failureMode: null,
    buildFingerprint: manifest?.buildFingerprint ?? null,
    repetitions,
    ...extra,
  };
}

function ensureProject() {
  rm(project);
  const generated = spawnSync(
    process.execPath,
    [path.join(HERE, 'generate.mjs'), project, String(files), String(linesPerFile)],
    { cwd: REPO, encoding: 'utf8', windowsHide: true },
  );
  if (generated.status !== 0) throw new Error(`generate failed: ${generated.stderr}`);
  const init = runCli(
    ['init', '--roots', 'all', '--write-config', '--yes', '--no-typecheck'],
    project,
    {},
    false,
  );
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
}

function resetIndex() {
  rm(path.join(project, '.nexus', 'roots'));
  fs.rmSync(path.join(project, '.nexus', 'workspace.json'), { force: true });
  fs.rmSync(path.join(project, '.nexus', 'tmp'), { recursive: true, force: true });
}

const results = [];
const raw = {};

ensureProject();

// P1 cold full build.
{
  const durations = [];
  for (let run = 0; run < repetitions; run += 1) {
    resetIndex();
    const result = runCli(['build', '--format', 'json'], project);
    if (result.status !== 0) {
      throw new Error(
        `P1 build failed: status=${String(result.status)} error=${result.error?.message ?? ''} stdout=${String(result.stdout ?? '').slice(0, 600)} stderr=${result.stderr ?? ''}`,
      );
    }
    durations.push(result.durationMs);
  }
  results.push(baseRecord('P1', median(durations), { maxDurationMs: Math.max(...durations) }));
  raw.P1 = durations;
}

// P2 hot full build: cache directory exists, no index DB.
{
  const durations = [];
  for (let run = 0; run < repetitions; run += 1) {
    resetIndex();
    fs.mkdirSync(path.join(project, '.nexus', 'cache'), { recursive: true });
    const result = runCli(['build', '--format', 'json'], project);
    if (result.status !== 0) throw new Error(`P2 build failed: ${result.stderr}`);
    durations.push(result.durationMs);
  }
  results.push(baseRecord('P2', median(durations), { maxDurationMs: Math.max(...durations) }));
  raw.P2 = durations;
}

// P3 single-file incremental update.
{
  const durations = [];
  for (let run = 0; run < repetitions; run += 1) {
    const file = path.join(project, 'src', 'file0.ts');
    fs.appendFileSync(file, `\nexport const p3_${run} = ${run};\n`);
    const result = runCli(['update', '--format', 'json'], project);
    if (result.status !== 0) throw new Error(`P3 update failed: ${result.stderr}`);
    durations.push(result.durationMs);
    const root = result.json?.roots?.[0];
    if (root?.mode !== 'incremental') {
      throw new Error(`P3 expected incremental, got ${root?.mode}`);
    }
  }
  results.push(baseRecord('P3', median(durations), { maxDurationMs: Math.max(...durations) }));
  raw.P3 = durations;
}

// P4 batch incremental update (20 files).
{
  const durations = [];
  for (let run = 0; run < repetitions; run += 1) {
    for (let index = 0; index < Math.min(20, files); index += 1) {
      fs.appendFileSync(
        path.join(project, 'src', `file${index}.ts`),
        `\nexport const p4_${run}_${index} = ${index};\n`,
      );
    }
    const result = runCli(['update', '--format', 'json'], project);
    if (result.status !== 0) throw new Error(`P4 update failed: ${result.stderr}`);
    durations.push(result.durationMs);
  }
  results.push(baseRecord('P4', median(durations), { maxDurationMs: Math.max(...durations) }));
  raw.P4 = durations;
}

// P6 query latency (in-process; point query + one-level adjacency).
{
  const core = await import(
    pathToFileURL(path.join(REPO, 'packages', 'core', 'dist', 'index.js')).href
  );
  // Warm the process (module init, SQLite page cache) before sampling; p50/p95
  // describe steady-state query latency, not first-call setup.
  await core.queryReferences({ projectRoot: project, cwd: project }, 'fn0_0', true);
  const durations = [];
  for (let run = 0; run < 10; run += 1) {
    const started = performance.now();
    await core.queryReferences({ projectRoot: project, cwd: project }, 'fn0_0', true);
    durations.push(performance.now() - started);
  }
  results.push(
    baseRecord('P6', Math.round(p95(durations) * 100) / 100, {
      p50Ms: Math.round(median(durations) * 100) / 100,
      p95Ms: Math.round(p95(durations) * 100) / 100,
    }),
  );
  raw.P6 = durations;
}

// P5 multi-root build (F18, three roots, dependency order, serial by default).
{
  const multi = path.join(WORK, 'multi-root');
  rm(multi);
  fs.cpSync(path.join(REPO, 'fixtures', 'F18-scheduler'), multi, { recursive: true });
  const init = runCli(
    ['init', '--roots', 'all', '--write-config', '--yes', '--no-typecheck'],
    multi,
    {},
    false,
  );
  if (init.status !== 0) throw new Error(`P5 init failed: ${init.stderr}`);
  const durations = [];
  for (let run = 0; run < repetitions; run += 1) {
    rm(path.join(multi, '.nexus', 'roots'));
    fs.rmSync(path.join(multi, '.nexus', 'workspace.json'), { force: true });
    const result = runCli(['build', '--format', 'json'], multi);
    if (result.status !== 0) throw new Error(`P5 build failed: ${result.stderr}`);
    durations.push(result.durationMs);
  }
  results.push({
    scenario: 'P5',
    projectLoc: 120,
    fileCount: 3,
    dependencyCount: 2,
    tsRatio: 1,
    vueRatio: 0,
    ...machine,
    durationMs: median(durations),
    maxDurationMs: Math.max(...durations),
    peakRssMB: readManifest(multi)?.memory?.peakRssMB ?? null,
    sqliteSizeMB: null,
    degraded: [],
    failureMode: null,
    buildFingerprint: null,
    repetitions,
    note: 'three roots built serially; concurrency is capped at 1 in this phase',
  });
  raw.P5 = durations;
}

// P7 MCP request latency (real stdio server; initialize + status/search).
{
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: project,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'nexus-perf', version: '0.0.0' });
  let mcpError = null;
  let p7Durations = [];
  try {
    await client.connect(transport);
    await client.listTools();
    await client.callTool({ name: 'status', arguments: {} });
    await client.callTool({ name: 'search', arguments: { term: 'fn0_0', format: 'json' } });
    for (let run = 0; run < 10; run += 1) {
      const started = performance.now();
      const result = await client.callTool({
        name: 'search',
        arguments: { term: 'fn0_0', format: 'json' },
      });
      if (result.isError === true) throw new Error('P7 MCP search returned isError');
      p7Durations.push(performance.now() - started);
    }
  } catch (error) {
    mcpError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await client.close();
    } catch {
      // best effort
    }
  }
  if (mcpError !== null) {
    results.push({
      scenario: 'P7',
      ...machine,
      durationMs: null,
      status: 'failed',
      reason: mcpError,
      failureMode: 'mcp-stdio',
    });
  } else {
    results.push(
      baseRecord('P7', Math.round(p95(p7Durations) * 100) / 100, {
        p50Ms: Math.round(median(p7Durations) * 100) / 100,
        p95Ms: Math.round(p95(p7Durations) * 100) / 100,
        repetitions: p7Durations.length,
        peakRssMB: null,
        note: 'stdio child process + initialize + status/search calls; latency includes the server-side status scan',
      }),
    );
    raw.P7 = p7Durations;
  }
}

// P8 crash recovery: inject after-commit-before-flip, then time recovery.
{
  const crashProject = path.join(WORK, 'crash-recovery');
  rm(crashProject);
  fs.cpSync(path.join(REPO, 'fixtures', 'F16-crash-recovery'), crashProject, { recursive: true });
  const init = runCli(
    ['init', '--roots', 'all', '--write-config', '--yes', '--no-typecheck'],
    crashProject,
    {},
    false,
  );
  if (init.status !== 0) throw new Error(`P8 init failed: ${init.stderr}`);
  const build = runCli(['build', '--format', 'json'], crashProject);
  if (build.status !== 0) throw new Error(`P8 build failed: ${build.stderr}`);
  const crash = runCli(['build', '--format', 'json'], crashProject, {
    NEXUS_CRASH_AT: 'after-commit-before-flip',
  });
  if (crash.status === 0) throw new Error('P8 crash injection did not terminate the build');
  const core = await import(
    pathToFileURL(path.join(REPO, 'packages', 'core', 'dist', 'index.js')).href
  );
  const started = performance.now();
  const recovery = core.recoverWorkspace(crashProject);
  const durationMs = Math.round(performance.now() - started);
  results.push({
    scenario: 'P8',
    projectLoc: 80,
    fileCount: 6,
    dependencyCount: 0,
    tsRatio: 1,
    vueRatio: 0,
    ...machine,
    durationMs,
    peakRssMB: null,
    sqliteSizeMB: null,
    degraded: [],
    failureMode: 'after-commit-before-flip',
    buildFingerprint: null,
    repetitions: 1,
    recovery: recovery.roots.map((root) => ({ rootId: root.rootId, outcome: root.outcome })),
  });
  raw.P8 = [durationMs];
}

const payload = {
  generatedAt: new Date().toISOString(),
  scale: { loc, files, linesPerFile },
  machine,
  results,
  raw,
  limitations: [
    'P7 measures a real stdio MCP child (initialize + tools/list + status/search); it is not a not-available placeholder.',
    'P3/P4 measure a conservative root-level rebuild, not per-file AST reuse.',
    'Peak RSS is sampled in the build CLI process every 50ms; SCIP child RSS is not included.',
    'Generated projects have no node_modules, so dependencyCount is 0.',
    '50k/300k/1M scales are not measured by this run; do not extrapolate.',
  ],
};
const text = `${JSON.stringify(payload, null, 2)}\n`;
if (output === null) {
  process.stdout.write(text);
} else {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), text);
  process.stdout.write(`${path.resolve(output)}\n`);
}
