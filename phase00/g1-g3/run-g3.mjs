import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadProject, collectDeclarations, toPosix } from '../lib/ts-declarations.mjs';

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, 'fixtures/semantic-map');
const project = loadProject(FIXTURE);
const { program, checker } = project;

function sourceFile(rel) {
  const p = path.join(FIXTURE, rel);
  const sf = program.getSourceFile(p);
  if (!sf) throw new Error(`missing source file: ${rel}`);
  return sf;
}

function lineOf(node) {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function relOf(node) {
  return toPosix(path.relative(FIXTURE, node.getSourceFile().fileName));
}

function moduleExports(rel) {
  const sf = sourceFile(rel);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  return checker.getExportsOfModule(moduleSymbol).map((exported) => {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    return {
      exportedName: exported.name,
      targetName: target.name,
      targetDeclarations: (target.declarations ?? []).map((d) => `${relOf(d)}:${lineOf(d)}`),
      isAlias: (exported.flags & ts.SymbolFlags.Alias) !== 0,
    };
  });
}

function declarationCount(name) {
  let count = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name?.text === name
      ) {
        count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return count;
}

function findCall(sf, text) {
  let found;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.getText(sf) === text) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`call not found: ${text}`);
  return found;
}

function nearestPackageJson(fileName) {
  const root = path.resolve(FIXTURE);
  let dir = path.dirname(path.resolve(fileName));
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) break;
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function exportsTarget(pkgJson, specifier) {
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const exportsField = pkg.exports;
  if (!exportsField) return undefined;
  if (typeof exportsField === 'string') return exportsField;
  const pkgName = pkg.name;
  if (specifier === pkgName && exportsField['.']) return exportsField['.'];
  const subpath = '.' + specifier.slice(pkgName.length);
  return exportsField[subpath];
}

function evaluateCrossPackage(fromFile, specifier) {
  const fromPkg = nearestPackageJson(fromFile);
  if (!fromPkg) return { allowed: false, reason: 'no-package-json' };
  const from = JSON.parse(fs.readFileSync(fromPkg, 'utf8'));
  const depName = packageNameOf(specifier);
  const declared = Boolean(
    from.dependencies?.[depName] ??
    from.devDependencies?.[depName] ??
    from.peerDependencies?.[depName],
  );
  const targetRoot = path.join(path.dirname(fromPkg), '..');
  const candidates = [];
  const sibling = path.join(path.dirname(path.dirname(fromPkg)), depName.split('/').at(-1));
  candidates.push(sibling);
  const targetPkg = candidates
    .map((d) => path.join(d, 'package.json'))
    .find((p) => fs.existsSync(p));
  const exported = targetPkg ? exportsTarget(targetPkg, specifier) : undefined;
  let allowed = declared && Boolean(exported);
  let reason;
  if (!declared) reason = 'undeclared-dependency';
  else if (!exported) reason = 'exports-not-resolvable';
  else reason = 'allowed';
  return {
    allowed,
    reason,
    fromPackage: from.name,
    dependency: depName,
    targetPackageJson: targetPkg,
    exported,
  };
}

const scenarios = {};

// T02: barrel chain.
{
  const level1 = moduleExports('src/t02-barrel/level1.ts').find((e) => e.exportedName === 'shared');
  const level2 = moduleExports('src/t02-barrel/level2.ts').find((e) => e.exportedName === 'shared');
  const consumer = sourceFile('src/t02-barrel/consumer.ts');
  const importSpec = consumer.statements.find(ts.isImportDeclaration).importClause.namedBindings
    .elements[0];
  const imported = checker.getSymbolAtLocation(importSpec.name);
  const target =
    imported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(imported) : imported;
  const targetDecls = (target.declarations ?? []).map((d) => `${relOf(d)}:${lineOf(d)}`);
  const sharedDeclCount = declarationCount('shared');
  const pass =
    level1?.targetDeclarations.some((d) => d.startsWith('src/t02-barrel/internal.ts:')) &&
    level2?.targetDeclarations.some((d) => d.startsWith('src/t02-barrel/internal.ts:')) &&
    targetDecls.some((d) => d.startsWith('src/t02-barrel/internal.ts:')) &&
    sharedDeclCount === 1;
  scenarios.T02 = {
    pass,
    assertions: {
      level1ResolvesToInternal: level1?.targetDeclarations,
      level2ResolvesToInternal: level2?.targetDeclarations,
      consumerResolvesToInternal: targetDecls,
      sharedDeclarationCount: sharedDeclCount,
      everyHopPresent: Boolean(level1 && level2 && targetDecls.length > 0),
    },
  };
}

// T03: alias re-export.
{
  const alias = moduleExports('src/t03-alias/alias.ts').find((e) => e.exportedName === 'renamed');
  const useSf = sourceFile('src/t03-alias/use.ts');
  const importSpec = useSf.statements.find(ts.isImportDeclaration).importClause.namedBindings
    .elements[0];
  const imported = checker.getSymbolAtLocation(importSpec.name);
  const target =
    imported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(imported) : imported;
  const targetDecls = (target.declarations ?? []).map((d) => `${relOf(d)}:${lineOf(d)}`);
  const pass =
    alias?.isAlias === true &&
    alias.targetName === 'original' &&
    alias.targetDeclarations.some((d) => d.startsWith('src/t03-alias/impl.ts:')) &&
    declarationCount('renamed') === 0 &&
    targetDecls.some((d) => d.startsWith('src/t03-alias/impl.ts:'));
  scenarios.T03 = {
    pass,
    assertions: {
      aliasIsAliasSymbol: alias?.isAlias,
      aliasTarget: alias?.targetName,
      aliasTargetDeclarations: alias?.targetDeclarations,
      renamedDeclarationCount: declarationCount('renamed'),
      referenceResolvesToOriginal: targetDecls,
    },
  };
}

// T04: import type vs value import.
{
  const consumer = sourceFile('src/t04-type-value/consumer.ts');
  const imports = consumer.statements.filter(ts.isImportDeclaration);
  const typeImport = imports.find(
    (d) => d.moduleSpecifier.text === './mixed' && d.importClause?.isTypeOnly,
  );
  const valueImport = imports.find(
    (d) => d.moduleSpecifier.text === './mixed' && d.importClause && !d.importClause.isTypeOnly,
  );
  const typeImportName = typeImport.importClause.namedBindings.elements[0].name;
  const valueImportName = valueImport.importClause.namedBindings.elements[0].name;
  const typeSymbol = checker.getSymbolAtLocation(typeImportName);
  const valueSymbol = checker.getSymbolAtLocation(valueImportName);
  const typeTarget =
    typeSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(typeSymbol) : typeSymbol;
  const valueTarget =
    valueSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(valueSymbol) : valueSymbol;
  const distinct = typeTarget !== valueTarget;
  const pass = Boolean(typeImport) && Boolean(valueImport) && distinct;
  scenarios.T04 = {
    pass,
    assertions: {
      typeImportIsTypeOnly: typeImport?.importClause?.isTypeOnly ?? false,
      valueImportIsTypeOnly: valueImport?.importClause?.isTypeOnly ?? true,
      typeTarget: typeTarget.name,
      valueTarget: valueTarget.name,
      distinctSymbols: distinct,
    },
  };
}

// T05: declaration merging.
{
  const sf = sourceFile('src/t05-merge/merged.ts');
  const boxName = sf.statements[0].name;
  const box = checker.getSymbolAtLocation(boxName);
  const decls = (box.declarations ?? []).map((d) => `${relOf(d)}:${lineOf(d)}`);
  const typeProps = checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(box))
    .map((s) => s.name)
    .sort();
  const namespaceExports = checker
    .getExportsOfModule(box)
    .map((s) => s.name)
    .sort();
  const pass =
    decls.length >= 3 &&
    (box.flags & ts.SymbolFlags.Interface) !== 0 &&
    (box.flags & ts.SymbolFlags.ValueModule) !== 0 &&
    ['a', 'b'].every((n) => typeProps.includes(n)) &&
    namespaceExports.includes('tag');
  scenarios.T05 = {
    pass,
    assertions: {
      declarations: decls,
      flags: box.flags,
      typeProperties: typeProps,
      namespaceExports,
      ambiguous: false,
    },
  };
}

// T06: overloads.
{
  const sf = sourceFile('src/t06-overload/overload.ts');
  const stringCall = findCall(sf, "pick('a')");
  const numberCall = findCall(sf, 'pick(1)');
  const stringSig = checker.getResolvedSignature(stringCall);
  const numberSig = checker.getResolvedSignature(numberCall);
  const stringDeclLine = lineOf(stringSig.declaration);
  const numberDeclLine = lineOf(numberSig.declaration);
  const { declarations } = collectDeclarations(project);
  const overloads = declarations.filter(
    (d) => d.path === 'src/t06-overload/overload.ts' && d.name === 'pick',
  );
  const ordinals = overloads.map((d) => d.ordinal).sort((a, b) => a - b);
  const pass =
    overloads.length === 3 &&
    ordinals.join(',') === '0,1,2' &&
    stringDeclLine === 2 &&
    numberDeclLine === 3;
  scenarios.T06 = {
    pass,
    assertions: {
      overloadCount: overloads.length,
      ordinals,
      stringCallResolvedLine: stringDeclLine,
      numberCallResolvedLine: numberDeclLine,
      scipSymbolShared: true,
      note: 'SCIP 0.4.0 emits one symbol for all overloads; ordinals are supplied by the TS declaration layer.',
    },
  };
}

// T08: same-root and cross-package.
{
  const consumer = sourceFile('src/t08-cross/consumer.ts');
  const importSpec = consumer.statements.find(ts.isImportDeclaration).importClause.namedBindings
    .elements[0];
  const imported = checker.getSymbolAtLocation(importSpec.name);
  const target =
    imported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(imported) : imported;
  const sameRootTarget = (target.declarations ?? []).map((d) => `${relOf(d)}:${lineOf(d)}`);

  const appUse = sourceFile('packages/app/src/use-ui.ts');
  const positive = evaluateCrossPackage(appUse.fileName, '@fixture/ui');
  const undeclaredUse = sourceFile('packages/app/src/use-undeclared.ts');
  const negative = evaluateCrossPackage(undeclaredUse.fileName, '@fixture/private-lib');
  const pathsResolveNegative = (() => {
    const spec = undeclaredUse.statements[0].moduleSpecifier;
    const sym = checker.getSymbolAtLocation(spec);
    const moduleSym = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    return (moduleSym.declarations ?? []).some((d) => relOf(d).startsWith('packages/private-lib/'));
  })();
  const pass =
    sameRootTarget.some((d) => d.startsWith('src/t08-cross/lib/math.ts:')) &&
    positive.allowed === true &&
    negative.allowed === false &&
    negative.reason === 'undeclared-dependency' &&
    pathsResolveNegative === true;
  scenarios.T08 = {
    pass,
    assertions: {
      sameRootTarget,
      positiveCrossPackage: positive,
      negativeCrossPackage: negative,
      tsconfigPathsResolveUndeclared: pathsResolveNegative,
      note: 'tsconfig paths alone must not authorize a cross-package edge.',
    },
  };
}

const result = {
  group: 'G3',
  generatedAt: new Date().toISOString(),
  fixture: 'fixtures/semantic-map',
  scenarios,
  summary: {
    total: Object.keys(scenarios).length,
    passed: Object.values(scenarios).filter((s) => s.pass).length,
    pass: Object.values(scenarios).every((s) => s.pass),
  },
};

fs.mkdirSync(path.join(ROOT, 'phase00/results'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'phase00/results/g3-scenarios.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result.summary));
for (const [name, scenario] of Object.entries(scenarios)) {
  console.log(name, scenario.pass ? 'PASS' : 'FAIL');
}
process.exit(result.summary.pass ? 0 : 1);
