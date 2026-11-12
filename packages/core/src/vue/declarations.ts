import ts from 'typescript';

import type {
  ComponentEmit,
  ComponentProp,
  ComponentRecord,
  ComponentSlot,
  DeclarationRecord,
  PropsCoverage,
} from '../model.js';
import type { SymbolKind } from '../index/symbol-id.js';
import { sha256Hex } from '../util/hash.js';
import { generatedToSource, offsetToPosition, type VueProjection } from './project.js';

export interface GeneratedAnchor {
  /** Root-relative shadow document path (Phase 02 `.nexus/tmp/vue/...`). */
  docPath: string;
  nameLine: number;
  nameCol: number;
}

export interface VueDeclaration extends DeclarationRecord {
  generatedAnchor: GeneratedAnchor | null;
  isImport: boolean;
  syntheticComponent: boolean;
  componentMember: boolean;
}

export interface ComponentDraft {
  declaration: VueDeclaration;
  name: string;
  props: ComponentProp[];
  emits: ComponentEmit[];
  slots: ComponentSlot[];
  propsCoverage: PropsCoverage;
  source: ComponentRecord['source'];
  analysisEngine: string;
}

export interface VueSymbolCollection {
  declarations: VueDeclaration[];
  components: ComponentDraft[];
  filteredInternal: number;
  unmappedDeclarations: number;
  errors: string[];
  filteredInternalByFile: Map<string, number>;
}

const MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineSlots',
  'defineExpose',
  'defineModel',
  'withDefaults',
]);
const MAX_SIGNATURE_CHARS = 500;

function tokenize(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
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

function hasModifier(node: ts.Node, flag: ts.ModifierFlags): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & flag) !== 0;
}

function isInternalName(name: string): boolean {
  return name.startsWith('__VLS_') || MACROS.has(name);
}

function shadowAnchor(
  projection: VueProjection,
  generatedNameOffset: number,
  shadowDocPath: string,
  sf: ts.SourceFile,
): GeneratedAnchor | null {
  if (generatedNameOffset < 0) return null;
  const position = sf.getLineAndCharacterOfPosition(generatedNameOffset);
  void projection;
  return {
    docPath: shadowDocPath,
    nameLine: position.line,
    nameCol: position.character,
  };
}

function mapRange(
  projection: VueProjection,
  start: number,
  end: number,
): { startOffset: number; endOffset: number } | null {
  const startOffset = generatedToSource(projection, start);
  const endOffset = generatedToSource(projection, Math.max(start, end - 1));
  if (startOffset === null || endOffset === null) return null;
  return { startOffset, endOffset: endOffset + 1 };
}

function addDeclaration(input: {
  projection: VueProjection;
  rootId: string;
  sf: ts.SourceFile;
  shadowDocPath: string;
  node: ts.Node;
  nameNode: ts.Node;
  name: string;
  kind: SymbolKind;
  container: string;
  containerLocator: string;
  isImport: boolean;
  isTypeOnly: boolean;
  structuralOverride?: string;
  declarations: VueDeclaration[];
  ordinalCounters: Map<string, number>;
  synthetic?: boolean;
  exported?: boolean;
  componentMember?: boolean;
}): VueDeclaration | null {
  const {
    projection,
    rootId,
    sf,
    shadowDocPath,
    node,
    nameNode,
    name,
    kind,
    container,
    containerLocator,
    isImport,
    isTypeOnly,
    declarations,
    ordinalCounters,
  } = input;
  const generatedStart = node.getStart(sf);
  const generatedName = nameNode.getStart(sf);
  const generatedEnd = node.getEnd();
  const range = mapRange(projection, generatedStart, generatedEnd);
  const nameSource = generatedToSource(projection, generatedName);
  if (range === null || nameSource === null) return null;
  const namePosition = offsetToPosition(projection.sourceLineStarts, nameSource);
  const startPosition = offsetToPosition(projection.sourceLineStarts, range.startOffset);
  const endPosition = offsetToPosition(projection.sourceLineStarts, range.endOffset);
  const nameChain = container === '' ? name : `${container}.${name}`;
  const ordinalKey = `${projection.path}\\u0000${container}\\u0000${name}\\u0000${kind}`;
  const ordinal = ordinalCounters.get(ordinalKey) ?? 0;
  ordinalCounters.set(ordinalKey, ordinal + 1);
  const exported =
    input.exported ?? (hasModifier(node, ts.ModifierFlags.Export) || input.synthetic === true);
  const isDefault = hasModifier(node, ts.ModifierFlags.Default) || input.synthetic === true;
  const sourceText = projection.source.slice(range.startOffset, range.endOffset);
  const structural = input.structuralOverride ?? tokenize(sourceText);
  const declaration: VueDeclaration = {
    rootId,
    path: projection.path,
    name,
    nameChain,
    kind,
    startLine: startPosition.line,
    startCol: startPosition.col,
    endLine: endPosition.line,
    endCol: endPosition.col,
    nameLine: namePosition.line,
    nameCol: namePosition.col,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    signature: truncate(structural),
    structuralFingerprint: sha256Hex(structural),
    containerLocatorKey: containerLocator,
    overloadOrdinal: ordinal,
    isExported: exported,
    isDefault,
    exportKind: isDefault ? 'default' : exported ? 'named' : 'none',
    visibility: exported ? 'exported' : 'module-local',
    isTypeOnly,
    isAnonymous: false,
    syntaxContextHash: sha256Hex(
      `${projection.path}|${exported}|${isDefault}|${container}|${kind}`,
    ),
    sourceHash: projection.sourceHash,
    generatedAnchor: shadowAnchor(projection, generatedName, shadowDocPath, sf),
    isImport,
    syntheticComponent: input.synthetic === true,
    componentMember: input.componentMember === true,
  };
  declarations.push(declaration);
  return declaration;
}

interface DefineCall {
  call: ts.CallExpression;
  typeArgument: ts.TypeNode | null;
}

function findMacroCalls(sf: ts.SourceFile): Map<string, DefineCall> {
  const found = new Map<string, DefineCall>();
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (MACROS.has(name) && !found.has(name)) {
        found.set(name, { call: node, typeArgument: node.typeArguments?.[0] ?? null });
      }
    }
    for (let index = node.getChildCount() - 1; index >= 0; index -= 1) {
      stack.push(node.getChildAt(index));
    }
  }
  return found;
}

function isUnresolvedType(checker: ts.TypeChecker, type: ts.Type): string | null {
  if ((type.flags & ts.TypeFlags.Any) !== 0) return 'type-any';
  if ((type.flags & ts.TypeFlags.Never) !== 0) return 'type-never';
  if ((type as { intrinsicName?: string }).intrinsicName === 'error') return 'type-error';
  void checker;
  return null;
}

function sourceTypeText(
  projection: VueProjection,
  sf: ts.SourceFile,
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
  fallbackType: ts.Type,
): string {
  if (node !== undefined) {
    const start = generatedToSource(projection, node.getStart(sf));
    const end = generatedToSource(projection, Math.max(node.getStart(sf), node.getEnd() - 1));
    if (start !== null && end !== null) {
      const text = projection.source.slice(start, end + 1).trim();
      if (text !== '') return text;
    }
  }
  return checker.typeToString(fallbackType);
}

function collectProps(
  projection: VueProjection,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  call: DefineCall | undefined,
  defaultedNames: Set<string>,
): ComponentProp[] {
  if (call === undefined || call.typeArgument === null) return [];
  const propsType = checker.getTypeAtLocation(call.typeArgument);
  const props: ComponentProp[] = [];
  for (const symbol of propsType.getProperties()) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const propertyType = checker.getTypeOfSymbolAtLocation(
      symbol,
      declaration ?? call.typeArgument,
    );
    const reason = isUnresolvedType(checker, propertyType);
    const typeNode =
      declaration !== undefined && ts.isPropertySignature(declaration)
        ? declaration.type
        : declaration !== undefined && ts.isPropertyDeclaration(declaration)
          ? declaration.type
          : undefined;
    const typeText = sourceTypeText(projection, sf, typeNode, checker, propertyType);
    const optional =
      (symbol.flags & ts.SymbolFlags.Optional) !== 0 ||
      (declaration !== undefined &&
        ts.isPropertySignature(declaration) &&
        declaration.questionToken !== undefined);
    props.push({
      name: symbol.getName(),
      typeText,
      required: !optional && !defaultedNames.has(symbol.getName()),
      resolved: reason === null,
      reason,
    });
  }
  props.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return props;
}

function collectEmits(
  projection: VueProjection,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  call: DefineCall | undefined,
): ComponentEmit[] {
  if (call === undefined || call.typeArgument === null) return [];
  const emitsType = checker.getTypeAtLocation(call.typeArgument);
  const emits: ComponentEmit[] = [];
  const seen = new Set<string>();
  for (const symbol of emitsType.getProperties()) {
    const name = symbol.getName();
    if (seen.has(name)) continue;
    seen.add(name);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const propertyType = checker.getTypeOfSymbolAtLocation(
      symbol,
      declaration ?? call.typeArgument,
    );
    const typeNode =
      declaration !== undefined && ts.isPropertySignature(declaration)
        ? declaration.type
        : undefined;
    emits.push({
      name,
      payloadType: sourceTypeText(projection, sf, typeNode, checker, propertyType),
    });
  }
  for (const signature of emitsType.getCallSignatures()) {
    const parameters = signature.getParameters();
    const first = parameters[0];
    if (first === undefined) continue;
    const firstDeclaration = first.valueDeclaration ?? first.declarations?.[0];
    const firstType = checker.getTypeOfSymbolAtLocation(
      first,
      firstDeclaration ?? call.typeArgument,
    );
    if ((firstType.flags & ts.TypeFlags.StringLiteral) === 0) continue;
    const name = (firstType as ts.StringLiteralType).value;
    if (seen.has(name)) continue;
    seen.add(name);
    const second = parameters[1];
    let payloadType = '[]';
    if (second !== undefined) {
      const secondDeclaration = second.valueDeclaration ?? second.declarations?.[0];
      const secondType = checker.getTypeOfSymbolAtLocation(
        second,
        secondDeclaration ?? call.typeArgument,
      );
      payloadType = checker.typeToString(secondType);
    }
    emits.push({ name, payloadType });
  }
  emits.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return emits;
}

function collectSlots(
  projection: VueProjection,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  call: DefineCall | undefined,
): ComponentSlot[] {
  if (call === undefined || call.typeArgument === null) return [];
  const slotsType = checker.getTypeAtLocation(call.typeArgument);
  const slots: ComponentSlot[] = [];
  for (const symbol of slotsType.getProperties()) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const slotType = checker.getTypeOfSymbolAtLocation(symbol, declaration ?? call.typeArgument);
    const never = (slotType.flags & ts.TypeFlags.Never) !== 0;
    const parameters: string[] = [];
    for (const signature of slotType.getCallSignatures()) {
      const parts: string[] = [];
      for (const parameter of signature.getParameters()) {
        const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
        const parameterType = checker.getTypeOfSymbolAtLocation(
          parameter,
          parameterDeclaration ?? call.typeArgument,
        );
        parts.push(`${parameter.getName()}: ${checker.typeToString(parameterType)}`);
      }
      parameters.push(parts.length === 0 ? '{}' : `{ ${parts.join('; ')} }`);
    }
    slots.push({
      name: symbol.getName(),
      paramsType: parameters.join(' | ') || 'never',
      resolved: !never,
      reason: never ? 'slot-never' : null,
    });
  }
  slots.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return slots;
}

function withDefaultsNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'withDefaults'
    ) {
      const defaults = node.arguments[1];
      if (defaults !== undefined && ts.isObjectLiteralExpression(defaults)) {
        for (const property of defaults.properties) {
          const propertyName = ts.isPropertyAssignment(property)
            ? property.name
            : ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined;
          if (
            propertyName !== undefined &&
            (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName))
          ) {
            names.add(propertyName.text);
          }
        }
      }
    }
    for (let index = node.getChildCount() - 1; index >= 0; index -= 1) {
      stack.push(node.getChildAt(index));
    }
  }
  return names;
}

function componentStructuralText(
  props: readonly ComponentProp[],
  emits: readonly ComponentEmit[],
  slots: readonly ComponentSlot[],
  declarations: readonly VueDeclaration[],
): string {
  return JSON.stringify({
    props: props.map((prop) => [prop.name, prop.typeText, prop.required]),
    emits: emits.map((emit) => [emit.name, emit.payloadType]),
    slots: slots.map((slot) => [slot.name, slot.paramsType, slot.resolved]),
    symbols: declarations
      .filter((declaration) => !declaration.syntheticComponent)
      .map((declaration) => [
        declaration.kind,
        declaration.nameChain,
        declaration.structuralFingerprint,
      ])
      .sort(),
  });
}

function scriptTagOffset(source: string): number {
  const info = /<script(?:\s|>)/.exec(source);
  return info === null ? 0 : info.index;
}

function findTypeLiteral(sf: ts.SourceFile, aliasName: string): ts.TypeLiteralNode | null {
  for (const statement of sf.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === aliasName &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      return statement.type;
    }
  }
  return null;
}

/**
 * `<script>` + `<script setup>` are projected into one file where the setup body
 * is wrapped in `const __VLS_export = await (async () => { ... })()`. The setup
 * bindings are still user declarations, so the wrapper body is visited as a
 * top-level statement list.
 */
function unwrapSetupBody(node: ts.Expression | undefined): ts.Block | null {
  let current: ts.Node | undefined = node;
  if (current !== undefined && ts.isAwaitExpression(current)) current = current.expression;
  if (current !== undefined && ts.isParenthesizedExpression(current)) current = current.expression;
  if (current !== undefined && ts.isCallExpression(current)) current = current.expression;
  if (current !== undefined && ts.isParenthesizedExpression(current)) current = current.expression;
  if (current !== undefined && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))) {
    const body = current.body;
    if (body !== undefined && ts.isBlock(body)) return body;
  }
  return null;
}

export interface CollectVueOptions {
  program: ts.Program;
  rootId: string;
  projections: readonly VueProjection[];
  shadowAbsoluteByProjectPath: ReadonlyMap<string, string>;
  shadowDocPathByProjectPath: ReadonlyMap<string, string>;
}

/**
 * Collects Vue declarations and component metadata from the shadow program.
 * `docs/04-architecture.md` 4.1.2 filtering: a declaration is kept only when its
 * name and its full range map back to `.vue` source coordinates.
 */
export function collectVueSymbols(options: CollectVueOptions): VueSymbolCollection {
  const declarations: VueDeclaration[] = [];
  const components: ComponentDraft[] = [];
  const errors: string[] = [];
  const filteredInternalByFile = new Map<string, number>();
  let filteredInternal = 0;
  let unmappedDeclarations = 0;
  const ordinalCounters = new Map<string, number>();
  const checker = options.program.getTypeChecker();

  for (const projection of options.projections) {
    const shadowDocPath = options.shadowDocPathByProjectPath.get(projection.path);
    const shadowAbsolute = options.shadowAbsoluteByProjectPath.get(projection.path);
    if (shadowDocPath === undefined || shadowAbsolute === undefined) {
      errors.push(`${projection.path}: shadow document path is missing`);
      continue;
    }
    const sf = options.program.getSourceFile(shadowAbsolute);
    if (sf === undefined) {
      errors.push(`${projection.path}: shadow source file is not in the program`);
      continue;
    }
    const perFileStart = declarations.length;
    const perFileFilteredStart = filteredInternal;
    const macros = findMacroCalls(sf);
    const defaulted = withDefaultsNames(sf);
    const props = collectProps(projection, sf, checker, macros.get('defineProps'), defaulted);
    const emits = collectEmits(projection, sf, checker, macros.get('defineEmits'));
    const slots = collectSlots(projection, sf, checker, macros.get('defineSlots'));

    const add = (
      node: ts.Node,
      nameNode: ts.Node,
      name: string,
      kind: SymbolKind,
      container: string,
      containerLocator: string,
      isImport: boolean,
      isTypeOnly: boolean,
      structuralOverride?: string,
    ): void => {
      if (isInternalName(name)) {
        filteredInternal += 1;
        return;
      }
      const declaration = addDeclaration({
        projection,
        rootId: options.rootId,
        sf,
        shadowDocPath,
        node,
        nameNode,
        name,
        kind,
        container,
        containerLocator,
        isImport,
        isTypeOnly,
        structuralOverride,
        declarations,
        ordinalCounters,
      });
      if (declaration === null) {
        if (isInternalName(name)) filteredInternal += 1;
        else unmappedDeclarations += 1;
      }
    };

    const addMember = (
      member: ts.TypeElement,
      kind: SymbolKind,
      container: string,
      structural: string,
    ): void => {
      const nameNode = member.name;
      if (nameNode === undefined) return;
      const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : '';
      if (name === '' || isInternalName(name)) return;
      const declaration = addDeclaration({
        projection,
        rootId: options.rootId,
        sf,
        shadowDocPath,
        node: member,
        nameNode,
        name,
        kind,
        container,
        containerLocator: '',
        isImport: false,
        isTypeOnly: false,
        structuralOverride: structural,
        declarations,
        ordinalCounters,
        componentMember: true,
      });
      if (declaration === null) unmappedDeclarations += 1;
    };

    const componentContainer = projection.componentName;
    const propsLiteral = findTypeLiteral(sf, '__VLS_Props');
    if (propsLiteral !== null) {
      for (const member of propsLiteral.members) {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
        const nameNode = member.name;
        const name =
          nameNode !== undefined && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))
            ? nameNode.text
            : '';
        if (name === '') continue;
        addMember(
          member,
          ts.isMethodSignature(member) ? 'fn' : 'var',
          `${componentContainer}.$props`,
          member.getText(sf),
        );
      }
    }
    const emitsLiteral = findTypeLiteral(sf, '__VLS_Emit');
    if (emitsLiteral !== null) {
      for (const member of emitsLiteral.members) {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
        const nameNode = member.name;
        const name =
          nameNode !== undefined && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))
            ? nameNode.text
            : '';
        if (name === '') continue;
        addMember(member, 'var', `${componentContainer}.$emits`, member.getText(sf));
      }
    }
    const slotsLiteral = findTypeLiteral(sf, '__VLS_Slots');
    if (slotsLiteral !== null) {
      for (const member of slotsLiteral.members) {
        if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) continue;
        const nameNode = member.name;
        const name =
          nameNode !== undefined && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))
            ? nameNode.text
            : '';
        if (name === '') continue;
        addMember(member, 'fn', `${componentContainer}.$slots`, member.getText(sf));
      }
    }

    const visitTopLevel = (node: ts.Node, container: string, containerLocator: string): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause === undefined) return;
        const moduleName = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : '';
        if (clause.name !== undefined) {
          add(
            clause.name,
            clause.name,
            clause.name.text,
            'var',
            container,
            containerLocator,
            true,
            clause.isTypeOnly,
            `import:${moduleName}:default`,
          );
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            add(
              element.name,
              element.name,
              element.name.text,
              'var',
              container,
              containerLocator,
              true,
              clause.isTypeOnly || element.isTypeOnly,
              `import:${moduleName}:${element.propertyName?.text ?? element.name.text}`,
            );
          }
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          add(
            bindings.name,
            bindings.name,
            bindings.name.text,
            'var',
            container,
            containerLocator,
            true,
            clause.isTypeOnly,
            `import:${moduleName}:*`,
          );
        }
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === '__VLS_export') {
            const body = unwrapSetupBody(declaration.initializer);
            if (body !== null) {
              for (const statement of body.statements) visitTopLevel(statement, '', '');
            }
            continue;
          }
          const names = bindingNames(declaration.name);
          for (const nameNode of names) {
            const simple = ts.isIdentifier(declaration.name);
            add(
              simple ? declaration : nameNode,
              nameNode,
              nameNode.text,
              'var',
              container,
              containerLocator,
              false,
              false,
            );
          }
        }
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        add(node, node.name, node.name.text, 'fn', container, containerLocator, false, false);
        return;
      }
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        add(node, node.name, node.name.text, 'class', container, containerLocator, false, false);
        const chain = container === '' ? node.name.text : `${container}.${node.name.text}`;
        for (const member of node.members) {
          if (
            (ts.isPropertyDeclaration(member) ||
              ts.isMethodDeclaration(member) ||
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member)) &&
            member.name !== undefined &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
          ) {
            add(
              member,
              member.name,
              member.name.text,
              ts.isMethodDeclaration(member) ||
                ts.isGetAccessorDeclaration(member) ||
                ts.isSetAccessorDeclaration(member)
                ? 'fn'
                : 'var',
              chain,
              '',
              false,
              false,
            );
          }
        }
        return;
      }
      if (ts.isInterfaceDeclaration(node)) {
        add(node, node.name, node.name.text, 'interface', container, containerLocator, false, true);
        const chain = container === '' ? node.name.text : `${container}.${node.name.text}`;
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
          const nameNode = member.name;
          if (
            nameNode === undefined ||
            (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode))
          ) {
            continue;
          }
          add(
            member,
            nameNode,
            nameNode.text,
            ts.isMethodSignature(member) ? 'fn' : 'var',
            chain,
            '',
            false,
            true,
            member.getText(sf),
          );
        }
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        add(node, node.name, node.name.text, 'type', container, containerLocator, false, true);
        if (!isInternalName(node.name.text) && ts.isTypeLiteralNode(node.type)) {
          const chain = container === '' ? node.name.text : `${container}.${node.name.text}`;
          for (const member of node.type.members) {
            if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
            const nameNode = member.name;
            if (
              nameNode === undefined ||
              (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode))
            ) {
              continue;
            }
            add(
              member,
              nameNode,
              nameNode.text,
              ts.isMethodSignature(member) ? 'fn' : 'var',
              chain,
              '',
              false,
              true,
              member.getText(sf),
            );
          }
        }
        return;
      }
      if (ts.isEnumDeclaration(node)) {
        add(node, node.name, node.name.text, 'enum', container, containerLocator, false, false);
        return;
      }
      if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        add(node, node.name, node.name.text, 'ns', container, containerLocator, false, false);
      }
    };

    for (const statement of sf.statements) visitTopLevel(statement, '', '');

    const componentNames = declarations.slice(perFileStart);
    const structural = componentStructuralText(props, emits, slots, componentNames);
    const tagOffset = scriptTagOffset(projection.source);
    const tagPosition = offsetToPosition(projection.sourceLineStarts, tagOffset);
    const componentName = projection.componentName;
    const componentDeclaration: VueDeclaration = {
      rootId: options.rootId,
      path: projection.path,
      name: componentName,
      nameChain: componentName,
      kind: 'component',
      startLine: tagPosition.line,
      startCol: tagPosition.col,
      endLine: tagPosition.line,
      endCol: tagPosition.col,
      nameLine: tagPosition.line,
      nameCol: tagPosition.col,
      startOffset: tagOffset,
      endOffset: tagOffset,
      signature: truncate(
        `component props(${props.map((prop) => prop.name).join(',')}) emits(${emits
          .map((emit) => emit.name)
          .join(',')}) slots(${slots.map((slot) => slot.name).join(',')})`,
      ),
      structuralFingerprint: sha256Hex(structural),
      containerLocatorKey: '',
      overloadOrdinal: 0,
      isExported: true,
      isDefault: true,
      exportKind: 'default',
      visibility: 'exported',
      isTypeOnly: false,
      isAnonymous: false,
      syntaxContextHash: sha256Hex(`${projection.path}|component`),
      sourceHash: projection.sourceHash,
      generatedAnchor: null,
      isImport: false,
      syntheticComponent: true,
      componentMember: false,
    };
    declarations.push(componentDeclaration);
    const unresolved = props.filter((prop) => !prop.resolved);
    const defineProps = macros.get('defineProps');
    components.push({
      declaration: componentDeclaration,
      name: componentName,
      props,
      emits,
      slots,
      propsCoverage: {
        resolved: props.length - unresolved.length,
        total: props.length,
        unresolved: unresolved.map((prop) => ({
          name: prop.name,
          typeText: prop.typeText,
          reason: prop.reason ?? 'unresolved-type',
        })),
      },
      source:
        defineProps === undefined ? 'none' : defineProps.typeArgument !== null ? 'typed' : 'syntax',
      analysisEngine: 'vue-language-core',
    });
    filteredInternalByFile.set(projection.path, filteredInternal - perFileFilteredStart);
  }

  return {
    declarations,
    components,
    filteredInternal,
    unmappedDeclarations,
    errors,
    filteredInternalByFile,
  };
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const output: ts.Identifier[] = [];
  const stack: ts.BindingName[] = [name];
  while (stack.length > 0) {
    const current = stack.pop() as ts.BindingName;
    if (ts.isIdentifier(current)) {
      output.push(current);
      continue;
    }
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element)) continue;
      stack.push(element.name);
    }
  }
  return output;
}
