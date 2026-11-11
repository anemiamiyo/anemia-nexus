import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [, , projectDir] = process.argv;
const root = path.resolve(projectDir);
const started = performance.now();
const dbPath = path.join(root, 'index.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const symbols = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
const rss = process.memoryUsage().rss;
db.close();
console.log(
  JSON.stringify({
    symbols,
    queryRssMB: Number((rss / 1024 / 1024).toFixed(1)),
    durationMs: Math.round(performance.now() - started),
    dbSizeMB: Number((fs.statSync(dbPath).size / 1024 / 1024).toFixed(1)),
  }),
);
