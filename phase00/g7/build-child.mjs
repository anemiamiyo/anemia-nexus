import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { loadProject, collectDeclarations } from '../lib/ts-declarations.mjs';

const [, , projectDir] = process.argv;
const root = path.resolve(projectDir);
const started = performance.now();
let peakRss = 0;
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const timer = setInterval(sample, 50);

const project = loadProject(root);
sample();
const { declarations } = collectDeclarations(project);
sample();

const dbPath = path.join(root, 'index.db');
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, path TEXT);
  CREATE TABLE refs (source TEXT, target TEXT);
  CREATE TABLE files (path TEXT, hash TEXT);
`);
db.exec('BEGIN IMMEDIATE');
const insertSymbol = db.prepare('INSERT INTO symbols (name, kind, path) VALUES (?, ?, ?)');
for (const decl of declarations) {
  insertSymbol.run(decl.name, decl.kind, decl.path);
}
const insertRef = db.prepare('INSERT INTO refs (source, target) VALUES (?, ?)');
for (const sf of project.program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  const rel = path.relative(root, sf.fileName).split(path.sep).join('/');
  const visit = (node) => {
    if (ts.isIdentifier(node)) insertRef.run(rel, node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
sample();
db.exec('COMMIT');
const symbolCount = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
db.close();
clearInterval(timer);
sample();

const dbSize = fs.statSync(dbPath).size;
const loc = (() => {
  let n = 0;
  for (const file of fs.readdirSync(path.join(root, 'src'))) {
    n += fs.readFileSync(path.join(root, 'src', file), 'utf8').split('\n').length;
  }
  return n;
})();

console.log(
  JSON.stringify({
    projectDir: root,
    node: process.version,
    files: fs.readdirSync(path.join(root, 'src')).length,
    loc,
    symbols: symbolCount,
    peakRssMB: Number((peakRss / 1024 / 1024).toFixed(1)),
    finalRssMB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    durationMs: Math.round(performance.now() - started),
    dbSizeMB: Number((dbSize / 1024 / 1024).toFixed(1)),
  }),
);
