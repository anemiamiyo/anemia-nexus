import ts from 'typescript';

import type { CallRecord, Confidence, DeclarationRecord, RelationClass } from '../model.js';
import { ANALYZER_VERSION } from '../index/analyzer.js';
import { isInside, relativePosix } from '../util/paths.js';
import type { IdentityAssignment } from '../index/mapping.js';

export interface CallExtractionInput {
  program: ts.Program;
  checker: ts.TypeChecker;
  projectRoot: string;
  rootAbs: string;
  assignments: readonly IdentityAssignment[];
}

export interface CallExtractionResult {
  calls: CallRecord[];
  byResolution: Record<Confidence, number>;
  unresolved: number;
}

interface DeclarationIndex {
  byAnchor: Map<string, string>;
  byPath: Map<string, DeclarationRecord[]>;
  byNameByPath: Map<string, Map<string, DeclarationRecord[]>>;
}

function anchorKey(relativePath: string, line: number, col: number): string {
  return `${relativePath}:${line}:${col}`;
}

function nameNodeOf(declaration: ts.Declaration): ts.Node | null {
  const name = (declaration as ts.NamedDeclaration).name;
  return name ?? null;
}

function buildIndex(assignments: readonly IdentityAssignment[]): DeclarationIndex {
  const byAnchor = new Map<string, string>();
  const byPath = new Map<string, DeclarationRecord[]>();
  const byNameByPath = new Map<string, Map<string, DeclarationRecord[]>>();
  for (const assignment of assignments) {
    const declaration = assignment.declaration;
    const relative = declaration.path.replaceAll('\\\\', '/');
    byAnchor.set(
      anchorKey(relative, declaration.nameLine, declaration.nameCol),
      assignment.symbolId,
    );
    const list = byPath.get(relative) ?? [];
    list.push(declaration);
    byPath.set(relative, list);
    const names = byNameByPath.get(relative) ?? new Map<string, DeclarationRecord[]>();
    const nameList = names.get(declaration.name) ?? [];
    nameList.push(declaration);
    names.set(declaration.name, nameList);
    byNameByPath.set(relative, names);
  }
  for (const list of byPath.values()) {
    list.sort((left, right) => left.startOffset - right.startOffset);
  }
  return { byAnchor, byPath, byNameByPath };
}

function findEnclosing(
  declarations: readonly DeclarationRecord[] | undefined,
  offset: number,
): DeclarationRecord | null {
  if (declarations === undefined) return null;
  let best: DeclarationRecord | null = null;
  let low = 0;
  let high = declarations.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = declarations[middle] as DeclarationRecord;
    if (current.startOffset <= offset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  for (let index = candidate; index >= 0; index -= 1) {
    const current = declarations[index] as DeclarationRecord;
    if (current.endOffset <= offset) break;
    if (offset >= current.startOffset && offset < current.endOffset) {
      if (best === null || current.startOffset > best.startOffset) best = current;
    }
  }
  return best;
}

function symbolIdForDeclaration(
  declaration: ts.Declaration,
  projectRoot: string,
  index: DeclarationIndex,
): { symbolId: string | null; path: string | null } {
  const sourceFile = declaration.getSourceFile();
  const nameNode = nameNodeOf(declaration);
  if (nameNode === null) return { symbolId: null, path: null };
  const position = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
  const relative = relativePosix(projectRoot, sourceFile.fileName);
  const symbolId =
    index.byAnchor.get(anchorKey(relative, position.line + 1, position.character)) ?? null;
  return { symbolId, path: relative };
}

function resolvedSymbolId(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  projectRoot: string,
  index: DeclarationIndex,
): { symbolId: string | null; path: string | null; symbol: ts.Symbol | null } {
  let symbol: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(expression)) {
    symbol = checker.getSymbolAtLocation(expression.name);
  } else if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      symbol = checker.getSymbolAtLocation(argument);
    }
  } else {
    symbol = checker.getSymbolAtLocation(expression);
  }
  if (symbol === undefined) return { symbolId: null, path: null, symbol: null };
  let target = symbol;
  if ((target.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      target = checker.getAliasedSymbol(target);
    } catch {
      // unresolved alias: keep the original symbol
    }
  }
  for (const declaration of target.declarations ?? []) {
    const mapped = symbolIdForDeclaration(declaration, projectRoot, index);
    if (mapped.symbolId !== null) {
      return { symbolId: mapped.symbolId, path: mapped.path, symbol: target };
    }
  }
  return { symbolId: null, path: null, symbol: target };
}

function expressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function isDynamicCallee(expression: ts.Expression): string | null {
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument === undefined || !ts.isStringLiteralLike(argument)) return 'dynamic-callee';
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'eval') return 'eval';
    if (expression.text === 'Function') return 'reflection';
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === 'call' || expression.name.text === 'apply') {
      return 'dynamic-call-target';
    }
  }
  return null;
}

function relationFor(resolution: Confidence): RelationClass {
  if (resolution === 'direct' || resolution === 'typed') return 'certain';
  if (resolution === 'heuristic') return 'heuristic';
  return 'dynamic-unresolved';
}

/**
 * Static call graph for TS/TSX (docs/08-relations.md 8.1). The walk is
 * iterative; Vue script calls are deliberately not invented here.
 */
export function extractCalls(input: CallExtractionInput): CallExtractionResult {
  const index = buildIndex(input.assignments);
  const calls: CallRecord[] = [];
  const byResolution: Record<Confidence, number> = {
    direct: 0,
    typed: 0,
    heuristic: 0,
    unresolved: 0,
  };
  let unresolved = 0;

  const sourceFiles = input.program
    .getSourceFiles()
    .filter(
      (sourceFile) => !sourceFile.isDeclarationFile && isInside(input.rootAbs, sourceFile.fileName),
    )
    .sort((left, right) => (left.fileName < right.fileName ? -1 : 1));

  for (const sourceFile of sourceFiles) {
    const callerFile = relativePosix(input.projectRoot, sourceFile.fileName);
    const declarations = index.byPath.get(callerFile);
    const stack: ts.Node[] = [sourceFile];
    while (stack.length > 0) {
      const node = stack.pop() as ts.Node;
      const isCall =
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        !(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);
      if (isCall) {
        const call = node as ts.CallExpression | ts.NewExpression;
        const expression = call.expression;
        const position = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
        const caller = findEnclosing(declarations, expression.getStart(sourceFile));
        const callerSymbolId =
          caller === null
            ? null
            : (index.byAnchor.get(anchorKey(callerFile, caller.nameLine, caller.nameCol)) ?? null);
        const dynamicReason = isDynamicCallee(expression);
        const resolved = resolvedSymbolId(input.checker, expression, input.projectRoot, index);
        let resolution: Confidence;
        let calleeSymbolId: string | null = null;
        let calleeFile: string | null = null;
        let reason: string | null = null;
        if (dynamicReason !== null) {
          resolution = 'unresolved';
          reason = dynamicReason;
        } else if (resolved.symbolId !== null) {
          calleeSymbolId = resolved.symbolId;
          calleeFile = resolved.path;
          resolution = calleeFile === callerFile ? 'direct' : 'typed';
        } else if (resolved.symbol !== null && (resolved.symbol.declarations?.length ?? 0) === 0) {
          // Transient symbols (for example a property on `any`) have no
          // declaration. A unique same-file name is the only honest evidence.
          const name = expressionName(expression);
          const candidates =
            name === null ? [] : (index.byNameByPath.get(callerFile)?.get(name) ?? []);
          if (candidates.length === 1) {
            const candidate = candidates[0] as DeclarationRecord;
            calleeSymbolId =
              index.byAnchor.get(anchorKey(callerFile, candidate.nameLine, candidate.nameCol)) ??
              null;
            calleeFile = candidate.path;
            resolution = calleeSymbolId === null ? 'unresolved' : 'heuristic';
            if (resolution === 'unresolved') reason = 'unresolved-symbol';
          } else {
            resolution = 'unresolved';
            reason = 'unresolved-symbol';
          }
        } else if (resolved.symbol !== null) {
          // A symbol exists but is external (lib / node_modules): not a project
          // call edge and not a blind spot.
          resolution = 'typed';
          calleeSymbolId = null;
        } else {
          const name = expressionName(expression);
          const candidates =
            name === null ? [] : (index.byNameByPath.get(callerFile)?.get(name) ?? []);
          if (candidates.length === 1) {
            const candidate = candidates[0] as DeclarationRecord;
            calleeSymbolId =
              index.byAnchor.get(anchorKey(callerFile, candidate.nameLine, candidate.nameCol)) ??
              null;
            calleeFile = candidate.path;
            resolution = calleeSymbolId === null ? 'unresolved' : 'heuristic';
            if (resolution === 'unresolved') reason = 'unresolved-symbol';
          } else {
            resolution = 'unresolved';
            reason = 'unresolved-symbol';
          }
        }
        if (calleeSymbolId === null && resolution !== 'unresolved') {
          // External project call (lib / node_modules): skip rather than emit a
          // misleading unresolved row.
          const children = node.getChildren(sourceFile);
          for (let indexChild = children.length - 1; indexChild >= 0; indexChild -= 1) {
            stack.push(children[indexChild] as ts.Node);
          }
          continue;
        }
        const relationClass = relationFor(resolution);
        if (resolution === 'unresolved') unresolved += 1;
        byResolution[resolution] += 1;
        calls.push({
          callerSymbolId,
          calleeSymbolId,
          callerFile,
          calleeFile,
          line: position.line + 1,
          col: position.character,
          resolution,
          relationClass,
          confidence: resolution,
          analysisEngine: 'ts-ast',
          unresolvedReason: reason,
          evidence: {
            sourceOfTruth: 'ts-ast',
            analysisVersion: ANALYZER_VERSION.typescript,
            constraints: ['types-resolved'],
            missReason: reason,
          },
        });
      }
      const children = node.getChildren(sourceFile);
      for (let indexChild = children.length - 1; indexChild >= 0; indexChild -= 1) {
        stack.push(children[indexChild] as ts.Node);
      }
    }
  }

  calls.sort((left, right) => {
    if (left.callerFile !== right.callerFile) return left.callerFile < right.callerFile ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.col !== right.col) return left.col - right.col;
    return (left.calleeSymbolId ?? '') < (right.calleeSymbolId ?? '') ? -1 : 1;
  });
  return { calls, byResolution, unresolved };
}
