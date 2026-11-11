import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { styleText } from 'node:util';

const root = process.cwd();
const dir = path.join(root, 'phase00/tmp/g6', process.version);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const checks = {};

// node:sqlite file-backed read/write, including reopen.
{
  const dbPath = path.join(dir, 'probe.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t (name) VALUES (?)').run('anemia');
  const row = db.prepare('SELECT name FROM t WHERE id = 1').get();
  db.close();
  const reopened = new DatabaseSync(dbPath, { readOnly: true });
  const count = reopened.prepare('SELECT COUNT(*) AS n FROM t').get().n;
  reopened.close();
  checks.sqlite = row?.name === 'anemia' && count === 1;
}

// util.styleText is available and returns decorated text.
{
  const text = styleText('green', 'ok');
  checks.styleText = typeof text === 'string' && text.includes('ok');
}

// fs.watch recursive emits a change event on this platform.
{
  const watchDir = path.join(dir, 'watch');
  fs.mkdirSync(watchDir, { recursive: true });
  checks.watch = await new Promise((resolve) => {
    const watcher = fs.watch(watchDir, { recursive: true }, () => {
      clearTimeout(timer);
      watcher.close();
      resolve(true);
    });
    const timer = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, 2000);
    fs.writeFileSync(path.join(watchDir, 'file.txt'), 'x');
  });
}

// AbortSignal.timeout exists and aborts.
{
  const signal = AbortSignal.timeout(20);
  checks.abortSignalTimeout = await new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(true), { once: true });
    setTimeout(() => resolve(signal.aborted), 200);
  });
}

const result = {
  ok: Object.values(checks).every(Boolean),
  node: process.version,
  npm: process.env.npm_config_user_agent ?? null,
  platform: `${process.platform}/${process.arch}`,
  checks,
};
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
