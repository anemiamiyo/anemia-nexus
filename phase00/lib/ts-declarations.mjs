import path from 'node:path';
import ts from 'typescript';

/**
 * Phase 00 prototype only. Loads a fixture project with the TypeScript Compiler API.
 * This is not the Phase 01 indexer.
 */
export function loadProject(root, configName = 'tsconfig.json') {
  const configPath = path.join(root, configName);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  if (parsed.errors.length > 0) {
    const text = parsed.errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`failed to parse ${configPath}:\n${text}`);
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return {
    root: path.resolve(root),
    configPath,
    parsed,
    program,
    checker: program.getTypeChecker(),
  };
}

export function isInsideRoot(root, fileName) {
  const rel = path.relative(path.resolve(root), path.resolve(fileName));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

function lineCol(sourceFile, position) {
  const lc = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: lc.line + 1, col: lc.character, offset: position };
}

/**
 * Collects named declarations that are eligible for the G1 mapping denominator:
 * top-level declarations, class members, interface members, and namespace members.
 * Function parameters, local variables, enum members, and type parameters are excluded.
 */
export function collectDeclarations(project) {
  const { root, program, checker } = project;
  const declarations = [];
  const overloadCounters = new Map();

  const add = (nameNode, sf, rel, kind, container, node) => {
    const name = nameNode.getText(sf);
    const pos = lineCol(sf, nameNode.getStart(sf));
    const nameChain = container ? `${container}.${name}` : name;
    const ordinalKey = `${rel}:${container}:${name}:${kind}`;
    const ordinal = overloadCounters.get(ordinalKey) ?? 0;
    overloadCounters.set(ordinalKey, ordinal + 1);
    const symbol = checker.getSymbolAtLocation(nameNode);
    declarations.push({
      path: rel,
      line: pos.line,
      col: pos.col,
      offset: pos.offset,
      name,
      nameChain,
      kind,
      ordinal,
      declaration: node,
      symbol,
      sourceFile: sf,
    });
  };

  const visitMembers = (members, sf, rel, container) => {
    for (const member of members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        add(member.name, sf, rel, 'property', container, member);
      } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        add(member.name, sf, rel, 'method', container, member);
      } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        add(member.name, sf, rel, 'accessor', container, member);
      }
    }
  };

  const visitStatements = (statements, sf, rel, container) => {
    for (const node of statements) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) add(decl.name, sf, rel, 'var', container, node);
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        add(node.name, sf, rel, 'fn', container, node);
      } else if (ts.isClassDeclaration(node) && node.name) {
        add(node.name, sf, rel, 'class', container, node);
        visitMembers(node.members, sf, rel, node.name.getText(sf));
      } else if (ts.isInterfaceDeclaration(node)) {
        add(node.name, sf, rel, 'interface', container, node);
        visitMembers(node.members, sf, rel, node.name.getText(sf));
      } else if (ts.isTypeAliasDeclaration(node)) {
        add(node.name, sf, rel, 'type', container, node);
      } else if (ts.isEnumDeclaration(node)) {
        add(node.name, sf, rel, 'enum', container, node);
      } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        add(node.name, sf, rel, 'ns', container, node);
        if (node.body && ts.isModuleBlock(node.body)) {
          visitStatements(node.body.statements, sf, rel, node.name.getText(sf));
        }
      }
    }
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!isInsideRoot(root, sf.fileName)) continue;
    const rel = toPosix(path.relative(root, sf.fileName));
    visitStatements(sf.statements, sf, rel, '');
  }

  return { declarations };
}
