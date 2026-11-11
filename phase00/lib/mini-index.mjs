import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadProject, collectDeclarations, toPosix } from './ts-declarations.mjs';

const SCHEMA_VERSION = 1;

function sha(text, length = 16) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileHash(text) {
  return sha(text.replaceAll('\r\n', '\n'), 16);
}

function lineOf(node) {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isInside(root, fileName) {
  const rel = path.relative(path.resolve(root), path.resolve(fileName));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function symbolIdFor(record, used) {
  let id =
    's_' +
    sha(
      `${record.path}\0${record.kind}\0${record.nameChain}\0${record.ordinal}\0${record.signature}`,
      16,
    );
  if (used.has(id)) id += '#' + sha(`${record.path}:${record.line}:${record.col}`, 7);
  used.add(id);
  return id;
}

export function buildIndex(root, { cache } = {}) {
  const project = loadProject(root);
  const { program, checker } = project;
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isInside(root, sf.fileName));
  const sourceTexts = new Map();
  const fileHashes = new Map();
  for (const sf of sourceFiles) {
    const rel = toPosix(path.relative(root, sf.fileName));
    const text = sf.getText().replaceAll('\r\n', '\n');
    sourceTexts.set(rel, text);
    fileHashes.set(rel, fileHash(text));
  }

  const { declarations } = collectDeclarations(project);
  const used = new Set();
  const symbolByDeclaration = new Map();
  const symbolByTsSymbol = new Map();
  const symbols = [];
  let reusedFiles = 0;
  const newCache = new Map();

  const declarationsByFile = new Map();
  for (const decl of declarations) {
    const list = declarationsByFile.get(decl.path) ?? [];
    list.push(decl);
    declarationsByFile.set(decl.path, list);
  }

  for (const [rel, decls] of declarationsByFile) {
    const cached = cache?.get(rel);
    const unchanged = cached && cached.sourceHash === fileHashes.get(rel);
    if (unchanged) reusedFiles += 1;
    const cachedByKey = new Map(
      (cached?.symbols ?? []).map((s) => [
        `${s.line}:${s.col}:${s.kind}:${s.nameChain}:${s.ordinal}`,
        s,
      ]),
    );
    for (const decl of decls) {
      const key = `${decl.line}:${decl.col}:${decl.kind}:${decl.nameChain}:${decl.ordinal}`;
      const cachedSymbol = unchanged ? cachedByKey.get(key) : undefined;
      const signature = normalize(decl.declaration.getText(decl.sourceFile));
      const id = cachedSymbol?.id ?? symbolIdFor({ ...decl, signature }, used);
      const record = {
        id,
        name: decl.name,
        nameChain: decl.nameChain,
        kind: decl.kind,
        path: decl.path,
        line: decl.line,
        col: decl.col,
        signature,
        exported: true,
      };
      symbols.push(record);
      symbolByDeclaration.set(decl, record);
      if (decl.symbol) symbolByTsSymbol.set(decl.symbol, record);
    }
    newCache.set(rel, {
      sourceHash: fileHashes.get(rel),
      symbols: symbols.filter((s) => s.path === rel).map((s) => ({ ...s })),
    });
  }

  symbols.sort((a, b) => a.id.localeCompare(b.id));

  function resolveTarget(node) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return symbolByTsSymbol.get(target);
  }

  const references = [];
  const calls = [];
  const visit = (node, sf) => {
    if (ts.isIdentifier(node)) {
      const target = resolveTarget(node);
      if (target) {
        const isCall = node.parent && ts.isCallExpression(node.parent);
        references.push(
          `${toPosix(path.relative(root, sf.fileName))}|${target.id}|${isCall ? 'call' : 'ref'}|certain|${isCall ? 'typed' : 'direct'}`,
        );
      }
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const declaration = signature?.declaration;
      if (declaration) {
        const target = [...symbolByDeclaration.entries()].find(
          ([d]) => d.declaration === declaration,
        )?.[1];
        if (target) {
          calls.push(
            `${toPosix(path.relative(root, sf.fileName))}|${target.id}|call|certain|typed`,
          );
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, sf));
  };
  for (const sf of sourceFiles) visit(sf, sf);

  const exportsList = [];
  const dependencies = [];
  for (const sf of sourceFiles) {
    const rel = toPosix(path.relative(root, sf.fileName));
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol) {
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const targetSymbol =
          exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const target = symbolByTsSymbol.get(targetSymbol);
        if (target) {
          exportsList.push(`${rel}|${exported.name}|${target.id}|false`);
        }
      }
    }
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
      const declaration = moduleSymbol?.declarations?.[0];
      const targetFile = declaration?.getSourceFile().fileName;
      if (targetFile && isInside(root, targetFile)) {
        dependencies.push(
          `${rel}|${toPosix(path.relative(root, targetFile))}|${statement.moduleSpecifier.text}`,
        );
      }
    }
  }

  const surface = exportsList.slice().sort();
  const surfaceHash = 'sh_' + sha(surface.join('\n'), 16);
  const configText = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
  const filesHash =
    'fh_' +
    sha(
      [...fileHashes.entries()]
        .sort()
        .map(([p, h]) => `${p}:${h}`)
        .join('\n'),
      16,
    );
  const buildFingerprint =
    'bf_' +
    sha(
      [
        filesHash,
        sha(configText, 16),
        `schema=${SCHEMA_VERSION}`,
        `ts=${ts.version}`,
        'scip=0.4.0',
        'node=' + process.version,
      ].join('\0'),
      20,
    );

  const fileStatus = [...fileHashes.entries()].sort().map(([p, h]) => `${p}|${h}|indexed`);
  const coverage = {
    files: fileHashes.size,
    symbols: symbols.length,
    references: references.length,
    calls: calls.length,
    dependencies: dependencies.length,
    exports: exportsList.length,
  };

  return {
    output: {
      symbols,
      identity: symbols.map((s) => `${s.id}|active`).sort(),
      references: references.slice().sort(),
      exports: exportsList.slice().sort(),
      files: fileStatus,
      surfaceHash,
      edges: [...dependencies, ...calls].sort(),
      buildFingerprint,
      coverage,
      manifest: {
        schemaVersion: SCHEMA_VERSION,
        buildFingerprint,
        fileCount: coverage.files,
        symbolCount: coverage.symbols,
        referenceCount: coverage.references,
      },
    },
    cache: newCache,
    reusedFiles,
  };
}
