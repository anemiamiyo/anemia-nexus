import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PROBE = path.join(ROOT, 'phase00/mcp/probe.mjs');
const NODE22 = path.join(ROOT, 'phase00/tmp/node-22.16.0-bin/node.exe');
const NODE24 = 'C:/Users/Anemia/AppData/Roaming/fnm/node-versions/v24.22.2/installation/node.exe';

const results = [];
for (const [name, node] of [
  ['22.16.0', NODE22],
  ['24.22.2', NODE24],
]) {
  const started = performance.now();
  const child = spawnSync(node, [PROBE], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  let parsed;
  try {
    parsed = JSON.parse(child.stdout.trim().split('\n').at(-1));
  } catch {
    parsed = { ok: false, raw: child.stdout, stderr: child.stderr };
  }
  const elapsed = Math.round(performance.now() - started);
  const pass =
    child.status === 0 &&
    parsed.ok === true &&
    parsed.toolCount === 1 &&
    parsed.tools?.includes('echo') &&
    parsed.content?.[0]?.text === 'hello-phase00' &&
    parsed.structuredContent?.text === 'hello-phase00' &&
    elapsed <= 30_000;
  results.push({
    runtime: name,
    pass,
    exitCode: child.status,
    wallMs: elapsed,
    probe: parsed,
    stderr: child.stderr?.trim() ?? '',
  });
}

const report = {
  group: 'MCP',
  generatedAt: new Date().toISOString(),
  thresholds: { maxWallMs: 30_000, tools: 1, negotiatedProtocolRecorded: true },
  summary: {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    pass: results.every((r) => r.pass),
  },
  results,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/mcp-probe.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const result of results)
  console.log(result.runtime, result.pass ? 'PASS' : 'FAIL', JSON.stringify(result.probe));
process.exit(report.summary.pass ? 0 : 1);
