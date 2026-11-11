import path from 'node:path';
import ts from 'typescript';

import type { DeclarationRecord } from '../model.js';
import type { SymbolKind } from './symbol-id.js';
import { contentHash } from '../util/hash.js';
import { sha256Hex } from '../util/hash.js';
import { isInside, relativePosix } from '../util/paths.js';

const MAX_SIGNATURE_CHARS = 500;

interface PendingNode {
  node: ts.Node;
  container: string;
  containerLocator: string;
  containerExported: boolean;
}

function modifierFlags(node: ts.Node): number {
  if (!ts.canHaveModifiers(node)) return 0;
  return ts.getCombinedModifierFlags(node as ts.Declaration);
}

function hasModifier(node: ts.Node, flag: ts.ModifierFlags): boolean {
  return (modifierFlags(node) & flag) !== 0;
}

function tokenize(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const parts: string[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    parts.push(scanner.getTokenText());
    token = scanner.scan();
  }
  return parts.join(' ');
}

function truncate(value: string, max = MAX_SIGNATURE_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function kindOfName(node: ts.Node): string {
  return ts.SyntaxKind[node.kind] ?? String(node.kind);
}

function memberStructuralText(member: ts.Node, sf: ts.SourceFile): string {
  if (!ts.isClassElement(member) && !ts.isTypeElement(member)) return '';
  const nameNode = (member as ts.NamedDeclaration).name;
  const name =
    nameNode === undefined
      ? ''
      : ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)
        ? nameNode.text
        : 'computed';
  const typeNode = (member as { type?: ts.TypeNode }).type;
  const typeText = typeNode === undefined ? '' : tokenize(typeNode.getText(sf));
  return `${kindOfName(member)}:${name}:${typeText}:${modifierFlags(member)}`;
}

function structuralText(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    const headerEnd =
      node.members.length > 0 ? (node.members[0] as ts.Node).getStart(sf) : node.getEnd();
    const header = tokenize(sf.text.slice(node.getStart(sf), headerEnd));
    const members: string[] = [];
    for (const member of node.members) {
      const text = memberStructuralText(member, sf);
      if (text !== '') members.push(text);
    }
    return `${header}|${members.join('|')}`;
  }
  if (ts.isModuleDeclaration(node)) {
    const bodyStart = node.body === undefined ? node.getEnd() : node.body.getStart(sf);
    return tokenize(sf.text.slice(node.getStart(sf), bodyStart));
  }
  if (ts.isFunctionLike(node)) {
    const body = (node as ts.FunctionLikeDeclaration).body;
    const end = body === undefined ? node.getEnd() : body.getStart(sf);
    return tokenize(sf.text.slice(node.getStart(sf), end));
  }
  return tokenize(node.getText(sf));
}

function declarationName(node: ts.Node): ts.Node | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name ?? null;
  }
  return null;
}

interface AddContext {
  sf: ts.SourceFile;
  rootId: string;
  path: string;
  sourceHash: string;
  isBarrel: boolean;
  ordinalCounters: Map<string, number>;
  declarations: DeclarationRecord[];
}

function addDeclaration(
  context: AddContext,
  node: ts.Node,
  nameNode: ts.Node | null,
  name: string,
  kind: SymbolKind,
  container: string,
  containerLocator: string,
  anonymous = false,
  containerExported = false,
): void {
  const { sf } = context;
  const start = node.getStart(sf);
  const end = node.getEnd();
  if (nameNode === null) return;
  const nameStart = nameNode.getStart(sf);
  const namePos = sf.getLineAndCharacterOfPosition(nameStart);
  const startPos = sf.getLineAndCharacterOfPosition(start);
  const endPos = sf.getLineAndCharacterOfPosition(end);
  const nameChain = container === '' ? name : `${container}.${name}`;
  const ordinalKey = `${context.path}\u0000${container}\u0000${name}\u0000${kind}`;
  const ordinal = context.ordinalCounters.get(ordinalKey) ?? 0;
  context.ordinalCounters.set(ordinalKey, ordinal + 1);

  const exported = hasModifier(node, ts.ModifierFlags.Export);
  const isDefault = hasModifier(node, ts.ModifierFlags.Default);
  const isPrivate = hasModifier(node, ts.ModifierFlags.Private);
  const isProtected = hasModifier(node, ts.ModifierFlags.Protected);
  const visible = exported || (containerExported && !isPrivate && !isProtected);
  const visibility = isPrivate
    ? 'private'
    : isProtected
      ? 'protected'
      : exported
        ? 'exported'
        : visible
          ? 'public'
          : 'module-local';
  const syntaxContextHash = sha256Hex(
    `${context.path}|${exported}|${isDefault}|${context.isBarrel}|${container}`,
  );
  const structure = structuralText(node, sf);
  context.declarations.push({
    rootId: context.rootId,
    path: context.path,
    name,
    nameChain,
    kind,
    startLine: startPos.line + 1,
    startCol: startPos.character,
    endLine: endPos.line + 1,
    endCol: endPos.character,
    nameLine: namePos.line + 1,
    nameCol: namePos.character,
    startOffset: start,
    endOffset: end,
    signature: truncate(structure),
    structuralFingerprint: sha256Hex(structure),
    containerLocatorKey: containerLocator,
    overloadOrdinal: ordinal,
    isExported: visible,
    isDefault,
    exportKind: isDefault ? 'default' : exported ? 'named' : 'none',
    visibility,
    isTypeOnly: kind === 'interface' || kind === 'type',
    isAnonymous: anonymous,
    syntaxContextHash,
    sourceHash: context.sourceHash,
  });
}

function memberKind(member: ts.Node): SymbolKind | null {
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) return 'var';
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) return 'fn';
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) return 'fn';
  return null;
}

/**
 * Collects project-level declarations (top level, class/interface members,
 * namespace members). Function-local declarations are intentionally excluded.
 * The traversal uses an explicit stack (no recursion).
 */
export function collectDeclarations(
  program: ts.Program,
  rootAbs: string,
  projectRoot: string,
  rootId: string,
): DeclarationRecord[] {
  const declarations: DeclarationRecord[] = [];
  const ordinalCounters = new Map<string, number>();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isInside(rootAbs, sf.fileName))
    .sort((left, right) =>
      left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0,
    );

  for (const sf of sourceFiles) {
    const relative = relativePosix(projectRoot, sf.fileName);
    const isBarrel =
      sf.statements.length > 0 &&
      sf.statements.every(
        (statement) =>
          ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement) ||
          ts.isExportAssignment(statement),
      );
    const context: AddContext = {
      sf,
      rootId,
      path: relative,
      sourceHash: contentHash(sf.text),
      isBarrel,
      ordinalCounters,
      declarations,
    };
    const stack: PendingNode[] = [];
    for (let index = sf.statements.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: sf.statements[index] as ts.Node,
        container: '',
        containerLocator: '',
        containerExported: false,
      });
    }

    while (stack.length > 0) {
      const { node, container, containerLocator, containerExported } = stack.pop() as PendingNode;
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addDeclaration(
              context,
              node,
              declaration.name,
              declaration.name.text,
              'var',
              container,
              containerLocator,
              false,
              containerExported,
            );
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(node)) {
        if (node.name !== undefined) {
          addDeclaration(
            context,
            node,
            node.name,
            node.name.text,
            'fn',
            container,
            containerLocator,
            false,
            containerExported,
          );
        } else if (hasModifier(node, ts.ModifierFlags.Default)) {
          addDeclaration(context, node, node, 'default', 'fn', container, containerLocator, true);
        }
        continue;
      }
      if (ts.isClassDeclaration(node)) {
        if (node.name !== undefined) {
          addDeclaration(
            context,
            node,
            node.name,
            node.name.text,
            'class',
            container,
            containerLocator,
            false,
            containerExported,
          );
          const classChain = container === '' ? node.name.text : `${container}.${node.name.text}`;
          const classLocator = `${relative}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).character}`;
          for (let index = node.members.length - 1; index >= 0; index -= 1) {
            stack.push({
              node: node.members[index] as ts.Node,
              container: classChain,
              containerLocator: classLocator,
              containerExported: hasModifier(node, ts.ModifierFlags.Export),
            });
          }
        } else if (hasModifier(node, ts.ModifierFlags.Default)) {
          addDeclaration(
            context,
            node,
            node,
            'default',
            'class',
            container,
            containerLocator,
            true,
          );
        }
        continue;
      }
      if (ts.isInterfaceDeclaration(node)) {
        addDeclaration(
          context,
          node,
          node.name,
          node.name.text,
          'interface',
          container,
          containerLocator,
          false,
          containerExported,
        );
        const chain = container === '' ? node.name.text : `${container}.${node.name.text}`;
        const locator = `${relative}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).character}`;
        for (let index = node.members.length - 1; index >= 0; index -= 1) {
          stack.push({
            node: node.members[index] as ts.Node,
            container: chain,
            containerLocator: locator,
            containerExported: hasModifier(node, ts.ModifierFlags.Export),
          });
        }
        continue;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        addDeclaration(
          context,
          node,
          node.name,
          node.name.text,
          'type',
          container,
          containerLocator,
          false,
          containerExported,
        );
        continue;
      }
      if (ts.isEnumDeclaration(node)) {
        addDeclaration(
          context,
          node,
          node.name,
          node.name.text,
          'enum',
          container,
          containerLocator,
          false,
          containerExported,
        );
        continue;
      }
      if (ts.isModuleDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const chain = container === '' ? node.name.text : `${container}.${node.name.text}`;
          addDeclaration(
            context,
            node,
            node.name,
            node.name.text,
            'ns',
            container,
            containerLocator,
            false,
            containerExported,
          );
          const locator = `${relative}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).character}`;
          if (node.body !== undefined && ts.isModuleBlock(node.body)) {
            for (let index = node.body.statements.length - 1; index >= 0; index -= 1) {
              stack.push({
                node: node.body.statements[index] as ts.Node,
                container: chain,
                containerLocator: locator,
                containerExported: hasModifier(node, ts.ModifierFlags.Export),
              });
            }
          }
        }
        continue;
      }
      if (ts.isExportAssignment(node)) {
        const expression = node.expression;
        if (ts.isFunctionExpression(expression) && expression.name !== undefined) {
          addDeclaration(
            context,
            expression,
            expression.name,
            expression.name.text,
            'fn',
            container,
            containerLocator,
            false,
            containerExported,
          );
        } else if (ts.isClassExpression(expression) && expression.name !== undefined) {
          addDeclaration(
            context,
            expression,
            expression.name,
            expression.name.text,
            'class',
            container,
            containerLocator,
            false,
            containerExported,
          );
        } else if (ts.isFunctionExpression(expression) || ts.isClassExpression(expression)) {
          addDeclaration(
            context,
            expression,
            expression,
            'default',
            ts.isFunctionExpression(expression) ? 'fn' : 'class',
            container,
            containerLocator,
            true,
          );
        }
        continue;
      }
      const kind = memberKind(node);
      if (kind !== null) {
        const nameNode = declarationName(node);
        if (
          nameNode !== null &&
          (ts.isIdentifier(nameNode) ||
            ts.isStringLiteral(nameNode) ||
            ts.isNumericLiteral(nameNode))
        ) {
          addDeclaration(
            context,
            node,
            nameNode,
            nameNode.text,
            kind,
            container,
            containerLocator,
            false,
            containerExported,
          );
        }
      }
    }
  }

  declarations.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.startLine !== right.startLine) return left.startLine - right.startLine;
    return left.startCol - right.startCol;
  });
  return declarations;
}

export function createSyntaxProgram(
  fileNames: readonly string[],
  options: ts.CompilerOptions | null,
): ts.Program {
  return ts.createProgram({
    rootNames: [...fileNames],
    options: {
      ...(options ?? {}),
      noEmit: true,
      noResolve: true,
      skipLibCheck: true,
      allowJs: false,
      types: [],
    },
  });
}

export function isDeclarationInside(declaration: DeclarationRecord, offset: number): boolean {
  return offset >= declaration.startOffset && offset < declaration.endOffset;
}

export function sourceFileKey(projectRoot: string, fileName: string): string {
  return relativePosix(projectRoot, path.resolve(fileName));
}
