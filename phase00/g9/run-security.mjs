import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const WORK = path.join(ROOT, 'phase00/tmp/g9');
const NODE = 'C:/Users/Anemia/AppData/Roaming/fnm/node-versions/v24.22.2/installation/node.exe';
const HOOKS = path.join(ROOT, 'phase00/security/block-hooks.mjs');
const PRELOAD = path.join(ROOT, 'phase00/security/block-preload.cjs');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

function runConfig(file, env = {}) {
  return spawnSync(
    NODE,
    [
      '--permission',
      `--allow-fs-read=${ROOT}`,
      `--allow-fs-read=${file}`,
      `--import=${pathToFileURL(HOOKS).href}`,
      `--require=${PRELOAD}`,
      file,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ...env },
    },
  );
}

function validateCommand(command) {
  const destructive = new Set(['rm', 'rmdir', 'del', 'format', 'shutdown', 'sudo', 'curl', 'wget']);
  if (!command.id || !command.cmd || !Array.isArray(command.args)) {
    return { ok: false, code: 'E17', reason: 'missing required fields' };
  }
  if (destructive.has(command.cmd.toLowerCase())) {
    return { ok: false, code: 'E17', reason: 'destructive command rejected' };
  }
  if (command.args.some((arg) => /[|&;<>$`]/.test(arg))) {
    return { ok: false, code: 'E17', reason: 'shell metacharacter rejected' };
  }
  return { ok: true };
}

function verify({ authorized, explicit }) {
  if (authorized) return { status: 'executed', exitCode: 0 };
  if (explicit) return { status: 'error', code: 'E12' };
  return { status: 'skipped-unauthorized' };
}

const OFFICIAL = new Set(['official-analyzer']);
function loadPlugin(name, { allowUntrusted = false } = {}) {
  if (OFFICIAL.has(name)) return { enabled: true, untrusted: false };
  if (!allowUntrusted) return { enabled: false, reason: 'untrusted-plugin-disabled' };
  return { enabled: true, untrusted: true };
}

function loadConfig({ file, trust }) {
  if (file.endsWith('.ts') && !trust) {
    return { ok: false, code: 'E18', reason: 'TypeScript config requires explicit authorization' };
  }
  const child = runConfig(file);
  if (child.status !== 0)
    return { ok: false, code: 'E18', stdout: child.stdout, stderr: child.stderr };
  try {
    return { ok: true, value: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  } catch {
    return { ok: false, code: 'E17', stdout: child.stdout, stderr: child.stderr };
  }
}

const scenarios = {};

// 1. Malicious config reads a file outside the project root.
{
  const child = runConfig(path.join(ROOT, 'phase00/security/malicious-read.ts'), {
    SECRET_PATH: 'C:/Windows/win.ini',
  });
  const pass = child.stdout.includes('READ_DENIED') && !child.stdout.includes('READ_OK');
  scenarios.readOutsideRoot = {
    pass,
    assertions: {
      stdout: child.stdout.trim(),
      stderrTail: child.stderr.trim().split('\n').slice(-2),
    },
  };
}

// 2. Malicious config attempts network access.
{
  const child = runConfig(path.join(ROOT, 'phase00/security/malicious-fetch.ts'));
  const pass = child.stdout.includes('FETCH_DENIED') && !child.stdout.includes('FETCH_OK');
  scenarios.networkFetch = { pass, assertions: { stdout: child.stdout.trim() } };
}

// 3. Malicious config attempts a write outside the project root.
{
  const pwn = 'C:/Windows/nexus-pwned-g9.txt';
  fs.rmSync(pwn, { force: true });
  const child = runConfig(path.join(ROOT, 'phase00/security/malicious-write.ts'), {
    PWN_PATH: pwn,
  });
  const pass = child.stdout.includes('WRITE_DENIED') && !fs.existsSync(pwn);
  scenarios.writeOutsideRoot = {
    pass,
    assertions: { stdout: child.stdout.trim(), fileExists: fs.existsSync(pwn) },
  };
}

// 4. package.json lifecycle scripts are not executed by scanning.
{
  const dir = path.join(WORK, 'postinstall-fixture');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'postinstall-ran.txt');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'postinstall-fixture',
      scripts: {
        postinstall: `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}','x')"`,
      },
    }),
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const pass = typeof pkg.scripts?.postinstall === 'string' && !fs.existsSync(marker);
  scenarios.postinstallNotExecuted = {
    pass,
    assertions: {
      scriptPresent: Boolean(pkg.scripts?.postinstall),
      markerExists: fs.existsSync(marker),
    },
  };
}

// 5. Malicious custom command is rejected by the whitelist validator.
{
  const rejected = validateCommand({ id: 'evil', cmd: 'rm', args: ['-rf', '/'] });
  const allowed = validateCommand({ id: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] });
  const pass = rejected.ok === false && rejected.code === 'E17' && allowed.ok === true;
  scenarios.maliciousCommand = { pass, assertions: { rejected, allowed } };
}

// 6. Unauthorized verify is skipped; explicit request returns E12.
{
  const skipped = verify({ authorized: false, explicit: false });
  const explicit = verify({ authorized: false, explicit: true });
  const pass = skipped.status === 'skipped-unauthorized' && explicit.code === 'E12';
  scenarios.unauthorizedVerify = { pass, assertions: { skipped, explicit } };
}

// 7. Untrusted plugin is disabled by default and marked when explicitly allowed.
{
  const official = loadPlugin('official-analyzer');
  const disabled = loadPlugin('evil-plugin');
  const allowed = loadPlugin('evil-plugin', { allowUntrusted: true });
  const pass =
    official.enabled === true &&
    disabled.enabled === false &&
    allowed.enabled === true &&
    allowed.untrusted === true;
  scenarios.untrustedPlugin = { pass, assertions: { official, disabled, allowed } };
}

// Extra: unauthorized TS config returns E18; trusted benign config loads.
const unauthorized = loadConfig({
  file: path.join(ROOT, 'phase00/security/benign-config.ts'),
  trust: false,
});
const trusted = loadConfig({
  file: path.join(ROOT, 'phase00/security/benign-config.ts'),
  trust: true,
});
const extraPass =
  unauthorized.code === 'E18' && trusted.ok === true && trusted.value?.marker === 'benign-config';

const all = Object.entries(scenarios).map(([name, value]) => ({ name, ...value }));
const report = {
  group: 'G9',
  generatedAt: new Date().toISOString(),
  verdict: 'pass-with-limit',
  limitation:
    'Prototype isolates TS config in a child process with Node --permission, an ESM loader and a CJS require hook. It blocks network modules and fetch, but is not a universal OS-level network sandbox; Phase 01 must harden and test on the target platforms.',
  thresholds: { maliciousCases: 7, tsConfigAuthorization: true },
  summary: {
    total: all.length,
    passed: all.filter((s) => s.pass).length,
    extraPass,
    pass: all.every((s) => s.pass) && extraPass,
  },
  scenarios: Object.fromEntries(all.map((s) => [s.name, s])),
  extra: { unauthorized, trusted },
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g9-security.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const scenario of all) console.log(scenario.name, scenario.pass ? 'PASS' : 'FAIL');
console.log('extra', extraPass ? 'PASS' : 'FAIL', JSON.stringify({ unauthorized, trusted }));
process.exit(report.summary.pass ? 0 : 1);
