import ts from 'typescript';

import type { VueDeclaration } from './declarations.js';
import { offsetToPosition, type TemplateRange, type VueProjection } from './project.js';

export interface TemplateFallbackOptions {
  projection: VueProjection;
  declarations: readonly VueDeclaration[];
  declarationSymbolId: ReadonlyMap<VueDeclaration, string>;
  /** Prop name -> prop-member declaration symbol id. */
  propMembers: ReadonlyMap<string, string>;
  /** Prop name -> whether the prop is required (no default / not optional). */
  propRequired: ReadonlyMap<string, boolean>;
  /** Prop name -> declared type text, used to resolve `prop.member` chains. */
  propTypes: ReadonlyMap<string, string>;
  /** `<Type>.<member>` -> declaration symbol id for unambiguous user members. */
  memberTargets: ReadonlyMap<string, string>;
  /** `${line}\0${col}` positions that already have a SCIP-derived template edge. */
  coveredPositions: ReadonlySet<string>;
}

export interface TemplateFallbackEdge {
  targetSymbolId: string;
  sourceOffset: number;
  relationClass: 'certain' | 'heuristic';
  role: 'template:interpolation' | 'template:template-binding';
}

const VALUE_KINDS = new Set(['var', 'fn', 'class', 'enum']);

function positionKey(line: number, col: number): string {
  return `${line}:${col}`;
}

/**
 * Recovers member-expression / prop edges that the SCIP occurrence stream
 * failed to surface (a missing reference or a reference whose generated span
 * could not be mapped back to the SFC). The pass is deliberately conservative:
 * it only emits an edge when the target declaration is already known, and it
 * never touches a source position that SCIP already covered.
 */
export function collectTemplateFallbackEdges(
  options: TemplateFallbackOptions,
): TemplateFallbackEdge[] {
  const { projection, declarations, declarationSymbolId } = options;
  const source = projection.source;
  const templateStart = projection.templateRange?.start ?? projection.source.length;
  const edges: TemplateFallbackEdge[] = [];
  const emitted = new Set<string>();

  const declarationsByName = new Map<string, VueDeclaration[]>();
  for (const declaration of declarations) {
    if (!VALUE_KINDS.has(declaration.kind)) continue;
    if (declaration.isTypeOnly) continue;
    if (declaration.nameChain !== declaration.name) continue;
    if (declaration.startOffset >= templateStart) continue;
    const list = declarationsByName.get(declaration.name) ?? [];
    list.push(declaration);
    declarationsByName.set(declaration.name, list);
  }
  for (const list of declarationsByName.values()) {
    list.sort((left, right) => left.startOffset - right.startOffset);
  }

  function findValueDeclaration(name: string): VueDeclaration | null {
    const list = declarationsByName.get(name);
    if (list === undefined || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  }

  function declaredType(declaration: VueDeclaration): string | null {
    const text = source.slice(declaration.startOffset, declaration.endOffset);
    // `collectVueSymbols` anchors a `const` declaration at its name, so the
    // slice may start at `formatter: Formatter` rather than `const formatter`.
    let match =
      /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)/.exec(
        text,
      );
    if (match?.[1] !== undefined) return match[1];
    match =
      /^\s*(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*(?:ref|shallowRef|computed)\s*<\s*([A-Za-z_$][\w$]*)/.exec(
        text,
      );
    if (match?.[1] !== undefined) return match[1];
    match = /\)\s*as\s+([A-Za-z_$][\w$]*)\s*$/.exec(text);
    if (match?.[1] !== undefined) return match[1];
    return null;
  }

  function propType(name: string): string | null {
    const text = options.propTypes.get(name);
    if (text === undefined) return null;
    return /^[A-Za-z_$][\w$]*$/.test(text.trim()) ? text.trim() : null;
  }

  function memberTarget(typeName: string | null, property: string): string | null {
    if (typeName === null || typeName === '') return null;
    const direct = options.memberTargets.get(`${typeName}.${property}`);
    if (direct !== undefined) return direct;
    // `formatter.save` in source can resolve to `Formatter.save` after
    // interface/type widening; only accept a case-insensitive owner match.
    for (const [chain, symbolId] of options.memberTargets) {
      const separator = chain.lastIndexOf('.');
      if (separator < 0) continue;
      if (chain.slice(separator + 1) !== property) continue;
      if (chain.slice(0, separator).toLowerCase() !== typeName.toLowerCase()) continue;
      return symbolId;
    }
    return null;
  }

  function emit(
    range: TemplateRange,
    sourceOffset: number,
    targetSymbolId: string,
    relationClass: 'certain' | 'heuristic',
  ): void {
    const position = offsetToPosition(projection.sourceLineStarts, sourceOffset);
    const key = positionKey(position.line, position.col);
    if (options.coveredPositions.has(key) || emitted.has(key)) return;
    emitted.add(key);
    edges.push({
      targetSymbolId,
      sourceOffset,
      relationClass,
      role: range.kind === 'interpolation' ? 'template:interpolation' : 'template:template-binding',
    });
  }

  function resolveBare(range: TemplateRange, name: string, sourceOffset: number): void {
    const prop = options.propMembers.get(name);
    if (prop !== undefined) {
      const required = options.propRequired.get(name) === true;
      emit(range, sourceOffset, prop, required ? 'certain' : 'heuristic');
      return;
    }
    const declaration = findValueDeclaration(name);
    if (declaration === null) return;
    const symbolId = declarationSymbolId.get(declaration);
    if (symbolId === undefined) return;
    emit(range, sourceOffset, symbolId, 'certain');
  }

  function resolveMember(
    range: TemplateRange,
    node: ts.PropertyAccessExpression,
    sf: ts.SourceFile,
  ): void {
    const property = node.name.text;
    const base = node.expression;
    if (!ts.isIdentifier(base)) return;
    const baseName = base.text;
    if (baseName === 'props' || baseName === '__props' || baseName === '$props') {
      const prop = options.propMembers.get(property);
      if (prop !== undefined) {
        const required = options.propRequired.get(property) === true;
        emit(range, range.start + node.name.getStart(sf), prop, required ? 'certain' : 'heuristic');
      }
      return;
    }
    const baseDeclaration = findValueDeclaration(baseName);
    const basePropType = propType(baseName);
    const typeName = baseDeclaration === null ? null : declaredType(baseDeclaration);
    // Fall back to the source owner name when the annotation is inferred or
    // `import(...)`-shaped; member access itself is still name evidence.
    const target =
      memberTarget(typeName ?? basePropType, property) ?? memberTarget(baseName, property);
    if (target === null) return;
    emit(range, range.start + node.name.getStart(sf), target, 'heuristic');
  }

  function visit(range: TemplateRange, node: ts.Node, sf: ts.SourceFile): void {
    if (ts.isPropertyAccessExpression(node)) {
      resolveMember(range, node, sf);
      visit(range, node.expression, sf);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (isBareValueIdentifier(node)) {
        resolveBare(range, node.text, range.start + node.getStart(sf));
      }
      return;
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      visit(range, node.expression, sf);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      visit(range, node.initializer, sf);
      return;
    }
    ts.forEachChild(node, (child) => visit(range, child, sf));
  }

  const propNames = [...options.propMembers.keys()];
  for (const range of projection.templateRanges) {
    if (range.kind !== 'interpolation' && range.kind !== 'binding') continue;
    const text = source.slice(range.start, range.end);
    if (text.trim() === '') continue;
    // Cheap gate: only member accesses and known prop names need recovery.
    if (!text.includes('.') && !propNames.some((name) => text.includes(name))) continue;
    const sf = ts.createSourceFile(
      '__nexus_template.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    // Vue accepts a few expression dialects TS does not; skip rather than risk
    // inventing edges from a broken parse.
    const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if ((parseDiagnostics?.length ?? 0) > 0) continue;
    for (const statement of sf.statements) visit(range, statement, sf);
  }

  edges.sort((left, right) => left.sourceOffset - right.sourceOffset);
  return edges;
}

function isBareValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false;
  }
  if (
    ts.isTypeReferenceNode(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  return true;
}
