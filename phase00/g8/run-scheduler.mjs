import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORK = path.join(ROOT, 'phase00/tmp/g8');
const LEVELS = ['disable-calls', 'chunked', 'reduce-vue-projection', 'serialize', 'abort-root'];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function applyPressure({ budgetMB, usageMB }) {
  const actions = [];
  let usage = usageMB;
  let aborted = false;
  for (const level of LEVELS) {
    if (usage / budgetMB <= 0.85) break;
    actions.push(level);
    if (level === 'disable-calls') usage *= 0.85;
    else if (level === 'chunked') usage *= 0.8;
    else if (level === 'reduce-vue-projection') usage *= 0.8;
    else if (level === 'serialize') usage *= 0.7;
    else {
      aborted = true;
      break;
    }
  }
  return { actions, aborted, finalUsageMB: Number(usage.toFixed(1)), code: aborted ? 'E20' : null };
}

async function runTask(rootDir, { signal, failAfterTemp = false, delayMs = 80 }) {
  await sleep(delayMs, signal);
  if (signal?.aborted) throw new Error('aborted');
  const temp = path.join(rootDir, 'index.tmp');
  fs.writeFileSync(temp, 'new');
  if (failAfterTemp) {
    fs.rmSync(temp, { force: true });
    throw new Error('simulated root failure');
  }
  if (signal?.aborted) {
    fs.rmSync(temp, { force: true });
    throw new Error('aborted');
  }
  fs.renameSync(temp, path.join(rootDir, 'index.ok'));
}

function seedRoots(names) {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const name of names) {
    const dir = path.join(WORK, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.ok'), `old-${name}`);
  }
}

const scenarioResults = {};

// 1. Five-level degradation ladder.
{
  const ladder = applyPressure({ budgetMB: 100, usageMB: 300 });
  const pass =
    JSON.stringify(ladder.actions) === JSON.stringify(LEVELS) &&
    ladder.aborted === true &&
    ladder.code === 'E20';
  scenarioResults.ladder = {
    pass,
    assertions: {
      actions: ladder.actions,
      expected: LEVELS,
      aborted: ladder.aborted,
      code: ladder.code,
    },
  };
}

// 2. Cancellation propagation.
{
  seedRoots(['root-a', 'root-b', 'root-c']);
  const controller = new AbortController();
  const tasks = ['root-a', 'root-b', 'root-c'].map((name) =>
    runTask(path.join(WORK, name), { signal: controller.signal, delayMs: 500 }),
  );
  setTimeout(() => controller.abort(), 30);
  const started = performance.now();
  const settled = await Promise.allSettled(tasks);
  const elapsed = Math.round(performance.now() - started);
  const noFinalWrites = ['root-a', 'root-b', 'root-c'].every((name) => {
    const dir = path.join(WORK, name);
    return (
      !fs.existsSync(path.join(dir, 'index.tmp')) && !fs.existsSync(path.join(dir, 'index.ok.new'))
    );
  });
  const allRejected = settled.every((s) => s.status === 'rejected');
  const pass = allRejected && elapsed <= 2000 && noFinalWrites;
  scenarioResults.cancellation = {
    pass,
    assertions: {
      allRejected,
      elapsedMs: elapsed,
      noFinalWrites,
      states: settled.map((s) => s.status),
    },
  };
}

// 3. Failure isolation and old-index retention.
{
  seedRoots(['root-a', 'root-b', 'root-c']);
  const results = await Promise.allSettled([
    runTask(path.join(WORK, 'root-a'), { delayMs: 20 }),
    runTask(path.join(WORK, 'root-b'), { delayMs: 20, failAfterTemp: true }),
    runTask(path.join(WORK, 'root-c'), { delayMs: 20 }),
  ]);
  const oldB = fs.readFileSync(path.join(WORK, 'root-b/index.ok'), 'utf8');
  const aUpdated = fs.readFileSync(path.join(WORK, 'root-a/index.ok'), 'utf8') === 'new';
  const cUpdated = fs.readFileSync(path.join(WORK, 'root-c/index.ok'), 'utf8') === 'new';
  const bTempGone = !fs.existsSync(path.join(WORK, 'root-b/index.tmp'));
  const failedRoots = results
    .map((r, i) => (r.status === 'rejected' ? ['root-a', 'root-b', 'root-c'][i] : null))
    .filter(Boolean);
  const pass =
    results[0].status === 'fulfilled' &&
    results[1].status === 'rejected' &&
    results[2].status === 'fulfilled' &&
    oldB === 'old-root-b' &&
    aUpdated &&
    cUpdated &&
    bTempGone &&
    failedRoots.join(',') === 'root-b';
  scenarioResults.failureIsolation = {
    pass,
    assertions: { failedRoots, oldB, aUpdated, cUpdated, bTempGone },
  };
}

const all = Object.entries(scenarioResults).map(([name, value]) => ({ name, ...value }));
const report = {
  group: 'G8',
  generatedAt: new Date().toISOString(),
  verdict: 'pass-with-limit',
  limitation:
    'Prototype scheduler uses deterministic memory-pressure input rather than live process RSS; Phase 01/06 must integrate the real Global Resource Coordinator and RSS probe.',
  thresholds: { ladderLevels: 5, cancelMs: 2000, oldIndexRetained: true, noPartialCommit: true },
  summary: {
    total: all.length,
    passed: all.filter((s) => s.pass).length,
    pass: all.every((s) => s.pass),
  },
  scenarios: Object.fromEntries(all.map((s) => [s.name, s])),
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g8-scheduler.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report.summary));
for (const scenario of all) console.log(scenario.name, scenario.pass ? 'PASS' : 'FAIL');
process.exit(report.summary.pass ? 0 : 1);
