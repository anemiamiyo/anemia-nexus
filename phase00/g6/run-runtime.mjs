import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PROBE = path.join(ROOT, 'phase00/g6/runtime-probe.mjs');
const NODE22 = path.join(ROOT, 'phase00/tmp/node-22.16.0-bin/node.exe');
const NPM22 = 'D:/nvm/v22.18.0/node_modules/npm/bin/npm-cli.js';
const NODE24 = 'C:/Users/Anemia/AppData/Roaming/fnm/node-versions/v24.22.2/installation/node.exe';
const NPM24 =
  'C:/Users/Anemia/AppData/Roaming/fnm/node-versions/v24.22.2/installation/node_modules/npm/bin/npm-cli.js';

function envFor(nodeExe) {
  const dir = path.dirname(nodeExe);
  return {
    ...process.env,
    PATH: `${dir};${process.env.PATH ?? ''}`,
    Path: `${dir};${process.env.Path ?? ''}`,
  };
}

function run(nodeExe, args, extra = {}) {
  return spawnSync(nodeExe, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: envFor(nodeExe),
    timeout: 300_000,
    ...extra,
  });
}

function tail(text, lines = 6) {
  return (text ?? '').trim().split('\n').slice(-lines).join('\n');
}

const runtimes = [
  { name: '22.16.0', node: NODE22, npm: NPM22 },
  { name: '24.22.2', node: NODE24, npm: NPM24 },
];

const results = [];
for (const runtime of runtimes) {
  const version = run(runtime.node, ['--version']);
  const probe = run(runtime.node, [PROBE]);
  let probeJson = null;
  try {
    probeJson = JSON.parse(probe.stdout.trim().split('\n').at(-1));
  } catch {
    probeJson = { ok: false, raw: probe.stdout, stderr: probe.stderr };
  }

  const install = run(runtime.node, [runtime.npm, 'ci', '--no-audit', '--no-fund']);
  const build = run(runtime.node, [runtime.npm, 'run', 'build']);
  const test = run(runtime.node, [runtime.npm, 'test']);

  const expectedVersion = `v${runtime.name}`;
  const pass =
    version.stdout.trim() === expectedVersion &&
    probeJson?.ok === true &&
    install.status === 0 &&
    build.status === 0 &&
    test.status === 0;

  results.push({
    runtime: runtime.name,
    pass,
    nodeVersion: version.stdout.trim(),
    npmVersion: run(runtime.node, [runtime.npm, '--version']).stdout.trim(),
    npmNote:
      runtime.name === '22.16.0'
        ? 'nvm 安装的 npm 10.9.2 缺少 @npmcli/config；使用同机 Node 22.18.0 自带的 npm 10.9.3 CLI 执行安装，Node 运行时仍为 22.16.0。'
        : undefined,
    probe: probeJson,
    install: { exitCode: install.status, tail: tail(install.stderr + install.stdout) },
    build: { exitCode: build.status, tail: tail(build.stdout + build.stderr) },
    test: { exitCode: test.status, tail: tail(test.stdout + test.stderr) },
  });
}

const report = {
  group: 'G6',
  generatedAt: new Date().toISOString(),
  thresholds: { runtimes: 2, installBuildTestProbe: true },
  summary: {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    pass: results.every((r) => r.pass),
  },
  results,
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g6-runtime.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const result of results) {
  console.log(
    result.runtime,
    result.pass ? 'PASS' : 'FAIL',
    'install',
    result.install.exitCode,
    'build',
    result.build.exitCode,
    'test',
    result.test.exitCode,
    'probe',
    result.probe?.ok,
  );
}
process.exit(report.summary.pass ? 0 : 1);
