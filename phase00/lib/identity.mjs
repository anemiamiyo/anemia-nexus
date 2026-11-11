import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadProject, collectDeclarations, toPosix } from './ts-declarations.mjs';

function sha(text, length = 16) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function normalizeDeclarationText(node) {
  return node
    .getText(node.getSourceFile())
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(text.toLowerCase().match(/[a-z_$][\w$]*/g) ?? []);
}

function nearestPackageName(fileName, root) {
  const absoluteRoot = path.resolve(root);
  let dir = path.dirname(path.resolve(fileName));
  for (;;) {
    const rel = path.relative(absoluteRoot, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) break;
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        return pkgJson.name ?? (rel || 'root');
      } catch {
        return rel || 'root';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'root';
}

function moduleFacts(sourceFile, checker) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exportNames = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).map((s) => s.name)
    : [];
  const importNames = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = statement.moduleSpecifier.text;
    importNames.push(spec);
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) importNames.push(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) importNames.push(element.name.text);
    }
  }
  return {
    exportNames: [...new Set(exportNames)].sort(),
    importNames: [...new Set(importNames)].sort(),
  };
}

export function snapshot(root) {
  const project = loadProject(root);
  const { declarations } = collectDeclarations(project);
  const sourceCache = new Map();
  const records = [];
  for (const decl of declarations) {
    if (decl.nameChain.includes('.')) continue;
    if (!['fn', 'class', 'var', 'interface', 'type', 'enum'].includes(decl.kind)) continue;
    const sf = decl.sourceFile;
    if (!sourceCache.has(sf.fileName)) {
      const text = sf.getText().replaceAll('\r\n', '\n');
      const facts = moduleFacts(sf, project.checker);
      sourceCache.set(sf.fileName, {
        text,
        sourceHash: sha(text, 16),
        tokenSet: tokens(text),
        ...facts,
      });
    }
    const fileFacts = sourceCache.get(sf.fileName);
    records.push({
      rootId: nearestPackageName(sf.fileName, root),
      path: decl.path,
      line: decl.line,
      col: decl.col,
      kind: decl.kind,
      nameChain: decl.nameChain,
      structuralFingerprint: sha(normalizeDeclarationText(decl.declaration), 16),
      sourceHash: fileFacts.sourceHash,
      exportNames: fileFacts.exportNames,
      importNames: fileFacts.importNames,
      tokenSet: fileFacts.tokenSet,
    });
  }
  records.sort((a, b) =>
    `${a.path}:${a.line}:${a.col}`.localeCompare(`${b.path}:${b.line}:${b.col}`),
  );
  return { root: path.resolve(root), records };
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

export function evidence(before, after, renamePairs = new Map()) {
  const e1 = renamePairs.get(before.path) === after.path;
  const e2 = jaccard(before.tokenSet, after.tokenSet) >= 0.8;
  const e3 = before.structuralFingerprint === after.structuralFingerprint;
  const e4 = jaccard(before.exportNames, after.exportNames) >= 0.6;
  const e5 = before.nameChain === after.nameChain;
  const e6 = jaccard(before.importNames, after.importNames) >= 0.6;
  return {
    E1: e1,
    E2: e2,
    E3: e3,
    E4: e4,
    E5: e5,
    E6: e6,
    values: {
      contentSimilarity: Number(jaccard(before.tokenSet, after.tokenSet).toFixed(3)),
      exportIntersection: Number(jaccard(before.exportNames, after.exportNames).toFixed(3)),
      importIntersection: Number(jaccard(before.importNames, after.importNames).toFixed(3)),
    },
  };
}

export function decideConfidence(ev) {
  if (ev.E3 && ev.E5 && (ev.E1 || ev.E4)) return 'high';
  if (ev.E3 && ev.E5) return 'medium';
  if (ev.E1 && ev.E2 && ev.E5) return 'medium';
  return 'low';
}

function newId(record, used) {
  let id =
    's_' +
    sha(
      `${record.rootId}\0${record.kind}\0${record.nameChain}\0${record.structuralFingerprint}`,
      16,
    );
  if (used.has(id)) {
    id += '#' + sha(`${record.path}:${record.line}:${record.col}`, 7);
  }
  used.add(id);
  return id;
}

export class IdentityRegistry {
  constructor() {
    this.active = new Map();
    this.retired = new Set();
    this.used = new Set();
    this.history = [];
  }

  seed(snapshotValue) {
    for (const record of snapshotValue.records) {
      const id = newId(record, this.used);
      record.id = id;
      this.active.set(id, { ...record, id });
    }
    return [...this.active.keys()];
  }

  migrate(snapshotValue, { renamePairs = new Map() } = {}) {
    const decisions = [];
    const matched = new Set();
    const retireLater = new Set();
    const beforeRecords = [...this.active.values()];

    for (const record of snapshotValue.records) {
      const samePosition = beforeRecords.find(
        (before) =>
          before.rootId === record.rootId &&
          before.path === record.path &&
          before.line === record.line &&
          before.col === record.col &&
          before.kind === record.kind &&
          before.nameChain === record.nameChain,
      );

      if (samePosition && samePosition.structuralFingerprint === record.structuralFingerprint) {
        matched.add(samePosition.id);
        decisions.push({
          record,
          symbolId: samePosition.id,
          confidence: 'high',
          evidence: ['same-position', 'E3'],
          reason: 'same file, position, kind, name and structural fingerprint',
          candidates: [],
          identityAmbiguous: false,
        });
        continue;
      }

      if (samePosition) {
        const moved = beforeRecords.find(
          (before) =>
            before.id !== samePosition.id &&
            before.nameChain === record.nameChain &&
            before.structuralFingerprint === record.structuralFingerprint,
        );
        if (moved) {
          const id = newId(record, this.used);
          decisions.push({
            record,
            symbolId: id,
            confidence: 'low',
            evidence: ['E5', 'E3'],
            reason:
              'content at this position changed while an identical declaration exists elsewhere',
            candidates: [samePosition.id, moved.id],
            identityAmbiguous: true,
            retired: [samePosition.id, moved.id],
          });
          matched.add(samePosition.id);
          matched.add(moved.id);
          retireLater.add(samePosition.id);
          retireLater.add(moved.id);
          continue;
        }
        matched.add(samePosition.id);
        decisions.push({
          record,
          symbolId: samePosition.id,
          confidence: 'high',
          evidence: ['same-position'],
          reason: 'same file and position; signature/body change does not change identity',
          candidates: [],
          identityAmbiguous: false,
        });
        continue;
      }

      const candidates = beforeRecords.filter(
        (before) => before.rootId === record.rootId && before.nameChain === record.nameChain,
      );
      if (candidates.length === 0) {
        const id = newId(record, this.used);
        decisions.push({
          record,
          symbolId: id,
          confidence: 'low',
          evidence: [],
          reason:
            record.rootId !== beforeRecords.find((b) => b.nameChain === record.nameChain)?.rootId &&
            beforeRecords.some((b) => b.nameChain === record.nameChain)
              ? 'cross-root move: new identity required'
              : 'no candidate',
          candidates: [],
          identityAmbiguous: false,
        });
        continue;
      }
      if (candidates.length > 1) {
        const id = newId(record, this.used);
        decisions.push({
          record,
          symbolId: id,
          confidence: 'low',
          evidence: ['E5'],
          reason: 'multiple candidates; ambiguity preserved',
          candidates: candidates.map((c) => c.id),
          identityAmbiguous: true,
          retired: candidates.map((c) => c.id),
        });
        for (const candidate of candidates) {
          matched.add(candidate.id);
          retireLater.add(candidate.id);
        }
        continue;
      }

      const candidate = candidates[0];
      const ev = evidence(candidate, record, renamePairs);
      const confidence = decideConfidence(ev);
      const inherit = confidence === 'high' || confidence === 'medium';
      const id = inherit ? candidate.id : newId(record, this.used);
      if (inherit) matched.add(candidate.id);
      decisions.push({
        record,
        symbolId: id,
        confidence,
        evidence: Object.entries(ev)
          .filter(([k, v]) => k.startsWith('E') && v)
          .map(([k]) => k),
        evidenceValues: ev.values,
        reason: inherit
          ? 'evidence satisfies inheritance rule'
          : 'evidence does not satisfy inheritance rule',
        candidates: [candidate.id],
        identityAmbiguous: false,
      });
    }

    for (const id of retireLater) {
      this.active.delete(id);
      this.retired.add(id);
    }

    for (const before of beforeRecords) {
      if (!matched.has(before.id)) {
        this.active.delete(before.id);
        this.retired.add(before.id);
      }
    }
    for (const decision of decisions) {
      this.active.set(decision.symbolId, { ...decision.record, id: decision.symbolId });
    }
    this.history.push({ snapshot: snapshotValue, decisions });
    return decisions;
  }
}
