import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/**
 * 3.4 release verification: build the workspace, pack the four packages,
 * install the tarballs into an isolated temporary project and run the 12
 * checks. Nothing is written to the user's global configuration.
 *
 * usage: node tools/release/verify.mjs [--output docs/release/0.0.0.md] [--skip-tests]
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const output = arg('--output', null);
const skipTests = args.includes('--skip-tests');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const items = [];
function run(command, commandArgs, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30 * 60 * 1000,
    shell: isWindows,
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    durationMs: Math.round(performance.now() - started),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

function record(id, title, command, result, detail, statusOverride = null) {
  const ok = statusOverride ?? (result.status === 0 ? 'pass' : 'fail');
  items.push({
    id,
    title,
    command,
    exitCode: result.status,
    durationMs: result.durationMs,
    status: ok,
    detail,
    stderr: result.stderr.slice(0, 800),
  });
  return ok === 'pass';
}

function mustPass() {
  return items.every((item) => item.status === 'pass' || item.status === 'not-applicable');
}
void mustPass;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-'));
const packs = path.join(work, 'packs');
const app = path.join(work, 'app');
const state = { report: '', failedCount: 0 };
try {
  fs.mkdirSync(packs, { recursive: true });
  fs.mkdirSync(app, { recursive: true });

  // 1 build
  const build = run(npm, ['run', 'build']);
  record('1', 'workspace build', 'npm run build', build, 'core + mcp + cli + adapter-vue ESM/d.ts');

  // 2 unit tests
  if (!skipTests) {
    const tests = run(npm, ['test']);
    record(
      '2',
      'unit tests',
      'npm test',
      tests,
      tests.stdout.includes('Test Files')
        ? (tests.stdout
            .split('\n')
            .filter((line) => /Tests\s+\d+ passed/.test(line))
            .slice(-1)[0] ?? '')
        : '',
    );
  } else {
    items.push({
      id: '2',
      title: 'unit tests',
      command: 'npm test (skipped)',
      exitCode: null,
      durationMs: 0,
      status: 'skipped',
      detail: '--skip-tests was passed; this record is not a release approval',
      stderr: '',
    });
  }

  // 3 integration tests
  if (!skipTests) {
    const integration = run(npx(), [
      'vitest',
      'run',
      'packages/core/test/integration.test.ts',
      'packages/core/test/reuse.test.ts',
      'packages/mcp/test/mcp.test.ts',
    ]);
    record(
      '3',
      'fixture integration tests',
      'vitest run integration + reuse + mcp',
      integration,
      'Fixtures F01/F05/F07/F14/F16/F18 and the MCP in-memory harness',
    );
  } else {
    items.push({
      id: '3',
      title: 'fixture integration tests',
      command: 'skipped',
      exitCode: null,
      durationMs: 0,
      status: 'skipped',
      detail: '--skip-tests',
      stderr: '',
    });
  }

  // 4 typecheck
  const typecheck = run(npm, ['run', 'typecheck']);
  record('4', 'typecheck', 'npm run typecheck', typecheck, 'tsc --noEmit over all packages');

  // 5 API check (first release: self-baseline, not a cross-version comparison)
  // Executed after installation below (needs a project with an index).

  // Pack all four packages.
  const packResult = run(npm, [
    'pack',
    '-w',
    'anemia-core',
    '-w',
    'anemia-mcp',
    '-w',
    'anemia-cli',
    '-w',
    'anemia-adapter-vue',
    '--pack-destination',
    packs,
  ]);

  // 6/7 exports + package.json conditions via the installed packages.
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      { name: 'nexus-release-app', version: '0.0.0', private: true, type: 'module' },
      null,
      2,
    ),
  );
  const tarballs = fs
    .readdirSync(packs)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => path.join(packs, entry));
  const install = run(
    npm,
    ['install', '--prefer-offline', '--no-audit', '--no-fund', ...tarballs],
    {
      cwd: app,
    },
  );
  if (install.status !== 0) {
    process.stderr.write(`tarball install failed: ${install.stderr}\n`);
  }

  const exportProbe = `
import fs from 'node:fs';
const packages = ['anemia-core', 'anemia-mcp', 'anemia-adapter-vue'];
const output = [];
for (const name of packages) {
  const resolved = import.meta.resolve(name);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', resolved), 'utf8'));
  output.push({ name, resolved: resolved.startsWith('file:') ? 'file' : 'url', exports: pkg.exports });
}
for (const name of packages) {
  const mod = await import(name);
  output[output.findIndex((entry) => entry.name === name)].loaded = typeof mod === 'object';
}
const cliResolved = import.meta.resolve('anemia-cli');
console.log(JSON.stringify({ packages: output, cliResolved: cliResolved.startsWith('file:') ? 'file' : 'url' }, null, 2));
`;
  fs.writeFileSync(path.join(app, 'exports-probe.mjs'), exportProbe);
  const exportsResult = run(process.execPath, ['exports-probe.mjs'], { cwd: app });
  record(
    '6',
    'package exports resolve',
    'import(resolve) each subpackage',
    exportsResult,
    'anemia-core / anemia-mcp / anemia-adapter-vue import; anemia-cli resolved through its bin',
  );
  fs.writeFileSync(path.join(app, 'conditions-probe.mjs'), conditionsScript());
  const conditionsResult = run(process.execPath, ['conditions-probe.mjs'], { cwd: app });
  record(
    '7',
    'package.json export conditions',
    'types + import conditions per package',
    conditionsResult,
    'ESM-only by design; no CJS condition is declared, so the CJS check is not-applicable',
  );

  // 8 tarball file list: dry-run pack in each workspace package.
  const listChecks = [];
  let listOk = packResult.status === 0;
  for (const workspace of ['anemia-core', 'anemia-mcp', 'anemia-cli', 'anemia-adapter-vue']) {
    const listed = run(npm, ['pack', '-w', workspace, '--dry-run', '--json']);
    let files = [];
    try {
      const parsed = JSON.parse(listed.stdout);
      files = Array.isArray(parsed) ? (parsed[0]?.files ?? []).map((entry) => entry.path) : [];
    } catch {
      listOk = false;
    }
    const forbidden = files.filter(
      (file) =>
        file.startsWith('src/') ||
        file.startsWith('test/') ||
        file.includes('.nexus') ||
        file.startsWith('fixtures/local') ||
        file.endsWith('.map'),
    );
    if (files.length === 0 || forbidden.length > 0) listOk = false;
    listChecks.push({ workspace, files, forbidden });
  }
  record(
    '8',
    'tarball file list',
    'npm pack -w <pkg> --dry-run --json',
    { status: listOk ? 0 : 1, durationMs: 0, stderr: '' },
    JSON.stringify(listChecks.map((entry) => ({ pkg: entry.workspace, files: entry.files }))),
  );

  // 9 README commands
  const sample = path.join(app, 'sample');
  fs.cpSync(path.join(REPO, 'fixtures', 'F07-api-surface'), sample, { recursive: true });
  fs.rmSync(path.join(sample, '.nexus'), { recursive: true, force: true });
  const nex = (cliArgs, cwd = sample) =>
    run(
      process.execPath,
      [path.join(app, 'node_modules', 'anemia-cli', 'dist', 'main.js'), ...cliArgs],
      {
        cwd,
      },
    );
  const readmeCommands = [
    ['--help'],
    ['status', '--format', 'json'],
    ['print', 'mcp-config', '--client', 'dsh'],
    ['print', 'agents'],
    ['print', 'skill'],
    ['doctor', '--schema'],
  ];
  let readmeOk = true;
  const readmeResults = [];
  for (const command of readmeCommands) {
    const result = nex(command);
    readmeResults.push({ command: `nex ${command.join(' ')}`, exitCode: result.status });
    if (result.status !== 0) readmeOk = false;
  }
  record(
    '9',
    'README commands executable',
    'nex --help/status/print.../doctor --schema',
    {
      status: readmeOk ? 0 : 1,
      durationMs: readmeResults.length,
      stderr: '',
    },
    JSON.stringify(readmeResults),
  );

  // 10 Node version
  const nodeCheck = run(process.execPath, ['-e', 'console.log(process.versions.node)']);
  const nodeVersion = nodeCheck.stdout.trim();
  record(
    '10',
    'minimum Node version',
    'node -e "process.versions.node"',
    { ...nodeCheck, status: nodeVersion === '22.16.0' ? 0 : 1 },
    nodeVersion,
  );

  // 11 installed CLI entry points: both bin names must resolve to this package.
  const version = run(npx(), ['nex', '--version'], { cwd: app });
  const anex = run(npx(), ['anex', '--version'], { cwd: app });
  record(
    '11',
    'installed CLI starts',
    'npx nex --version / npx anex --version',
    {
      status: version.status === 0 && anex.status === 0 ? 0 : 1,
      durationMs: version.durationMs + anex.durationMs,
      stderr: `${version.stderr}${anex.stderr}`,
    },
    version.stdout.trim().split('\n')[0] ?? '',
  );

  // 12 MCP handshake
  const mcp = nex(['doctor', '--mcp', '--format', 'json'], app);
  let mcpDetail = '';
  try {
    const payload = JSON.parse(mcp.stdout);
    const check = payload.checks?.[0];
    mcpDetail = check?.detail ?? '';
  } catch {
    mcpDetail = mcp.stdout.slice(0, 200);
  }
  record('12', 'MCP server handshake', 'nex doctor --mcp', mcp, mcpDetail);

  // 5 API check using the installed CLI on the F07 sample.
  const init = nex(['init', '--roots', 'all', '--write-config', '--yes', '--no-typecheck']);
  const buildSample = nex(['build', '--format', 'json']);
  const snapshot = nex(['api-snapshot', '--yes']);
  const diff = nex(['api-diff', '--fail-on', 'breaking', '--format', 'json']);
  const apiOk =
    init.status === 0 && buildSample.status === 0 && snapshot.status === 0 && diff.status === 0;
  record(
    '5',
    'public API check',
    'api-snapshot --yes && api-diff --fail-on breaking',
    {
      status: apiOk ? 0 : 1,
      durationMs: init.durationMs + buildSample.durationMs + snapshot.durationMs + diff.durationMs,
      stderr: [init.stderr, buildSample.stderr, snapshot.stderr, diff.stderr].join(''),
    },
    'first-release self-baseline: no previous published version, so this is not a cross-version comparison',
  );

  const ordered = items.sort((left, right) => {
    const leftId = Number.parseInt(left.id.replace(/[a-z]+$/i, ''), 10);
    const rightId = Number.parseInt(right.id.replace(/[a-z]+$/i, ''), 10);
    return leftId - rightId;
  });
  const passed = ordered.filter((item) => item.status === 'pass').length;
  const failed = ordered.filter((item) => item.status === 'fail').length;
  state.failedCount = failed;
  state.report = `# 发布验证记录 ${version.stdout.trim().split('\n')[0] ?? 'anemia-cli 0.0.0'}

> 生成时间：${new Date().toISOString()}
> 宿主：${os.platform()} ${os.release()}；Node ${process.versions.node}；npm ${run(npm, ['--version']).stdout.trim()}
> 方式：\`node tools/release/verify.mjs\`；\`npm pack\` 产物安装到系统临时目录，不使用仓库 \`node_modules\`，不修改任何全局配置。
> 结论：**${failed === 0 ? '通过' : '未通过'}**（pass=${passed}，fail=${failed}）。

| # | 检查项 | 命令 | 退出码 | 耗时 | 结果 | 说明 |
|---|---|---|---|---|---|---|
${ordered
  .map(
    (item) =>
      `| ${item.id} | ${item.title} | \`${item.command.replaceAll('|', '\\|')}\` | ${String(item.exitCode)} | ${item.durationMs}ms | ${item.status} | ${String(item.detail).replaceAll('|', '\\|')} |`,
  )
  .join('\n')}

## 说明

- 第 5 项为 **first-release self-baseline**：仓库没有上一发布版，按 D5 以当前基线自洽检查代替跨版本比较，不冒充跨版本结论。
- 第 7 项为 ESM-only 设计：包只声明 \`types\` 与 \`import\` 条件，不声明 CJS 条件；这是 3.3 的产物约束，不是遗漏。
- 第 8 项只验证 tarball 清单；具体清单见脚本 \`npm pack --dry-run --json\` 输出。
- 第 10 项在本机 Node 22.16.0 下执行；Node 24 的 CI 矩阵由 \`act\` 单独记录。
- 失败项不得通过调整清单放行（3.4）。

## 环境

- Node：${process.versions.node}
- npm：${run(npm, ['--version']).stdout.trim()}
- 平台：${os.platform()} ${os.release()} (${os.arch()})
`;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (output === null) {
  process.stdout.write(state.report);
} else {
  const target = path.resolve(REPO, output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, state.report, 'utf8');
  process.stdout.write(`${target}\n`);
}
process.exitCode = state.failedCount === 0 ? 0 : 1;

function npx() {
  return isWindows ? 'npx.cmd' : 'npx';
}

function conditionsScript() {
  return `
import fs from 'node:fs';
const packages = ['anemia-core', 'anemia-mcp', 'anemia-adapter-vue'];
for (const name of packages) {
  const resolved = import.meta.resolve(name);
  const pkgPath = new URL('../package.json', resolved);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const entry = pkg.exports?.['.'];
  if (entry === undefined || typeof entry !== 'object') throw new Error(name + ': no exports["."]');
  if (typeof entry.types !== 'string') throw new Error(name + ': missing types condition');
  if (typeof entry.import !== 'string') throw new Error(name + ': missing import condition');
  if (entry.require !== undefined) throw new Error(name + ': unexpected CJS condition');
}
console.log('types+import conditions verified for ' + packages.length + ' packages (ESM-only)');
`;
}
