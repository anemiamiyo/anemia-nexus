import type { ReferenceRecord, SymbolRecord } from '../model.js';
import type { IdentityAssignment, MappingStats } from '../index/mapping.js';
import { toSymbolRecord } from '../index/mapping.js';
import {
  isDefinition,
  isImport,
  isWriteAccess,
  scipDescriptorName,
  type ScipDocument,
  type ScipOccurrence,
} from '../index/scip.js';
import type { ComponentDraft, VueDeclaration } from './declarations.js';
import {
  generatedToSource,
  isInsideTemplate,
  offsetToPosition,
  templateRangeAt,
  type VueProjection,
} from './project.js';

export interface VueTemplateEdgeStats {
  total: number;
  certain: number;
  heuristic: number;
  dynamicUnresolved: number;
}

export interface VuePerFileStats {
  filteredInternal: number;
  templateEdges: number;
}

export interface VueMappingResult {
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  scipSymbolBySymbolId: Map<string, string | null>;
  scipSymbolToSymbolId: Map<string, string>;
  qualityBySymbolId: Map<string, 'exact' | 'structural' | 'conflict' | 'ambiguous' | 'unmapped'>;
  stats: MappingStats;
  unmappedReasonCounts: Record<string, number>;
  externalReferences: number;
  localOrUnmappedReferences: number;
  filteredInternal: number;
  templateEdges: VueTemplateEdgeStats;
  perFile: Map<string, VuePerFileStats>;
  componentSymbolByPath: Map<string, string>;
}

export interface MapVueSymbolsOptions {
  buildId: string;
  projections: readonly VueProjection[];
  documents: readonly ScipDocument[];
  assignments: readonly IdentityAssignment[];
  tsScipSymbolToSymbolId: ReadonlyMap<string, string>;
  components: readonly ComponentDraft[];
}

function utf8ColumnToUnit(lineText: string, byteColumn: number): number {
  if (byteColumn <= 0) return 0;
  let bytes = 0;
  let units = 0;
  for (const character of lineText) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > byteColumn) break;
    bytes += size;
    units += character.length;
    if (bytes === byteColumn) return units;
  }
  return units;
}

function utf16ColumnToByte(lineText: string, unitColumn: number): number {
  if (unitColumn <= 0) return 0;
  let units = 0;
  let bytes = 0;
  for (const character of lineText) {
    if (units >= unitColumn) break;
    units += character.length;
    bytes += Buffer.byteLength(character, 'utf8');
  }
  return bytes;
}

function scipPositionKey(docPath: string, line: number, byteCol: number): string {
  return `${docPath}\\u0000${line}\\u0000${byteCol}`;
}

function localKey(docPath: string, symbol: string): string {
  return `${docPath}\\u0000${symbol}`;
}

function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

function isInternalSymbol(symbol: string): boolean {
  return symbol.includes('__VLS_');
}

/**
 * SCIP type-literal descriptors look like `__VLS_Props#typeLiteral4:label.`;
 * `scipDescriptorName` stops at `#`/`.`, so strip the type-literal prefix too.
 */
function vueDescriptorName(symbol: string): string {
  const descriptor = scipDescriptorName(symbol);
  const colon = descriptor.lastIndexOf(':');
  return colon === -1 ? descriptor : descriptor.slice(colon + 1);
}

function memberExpressionBefore(source: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1;
  return index >= 0 && source[index] === '.';
}

function isClosingTagAt(source: string, offset: number): boolean {
  if (offset < 2) return false;
  let index = offset - 1;
  while (index >= 0 && (source[index] === ' ' || source[index] === '\t')) index -= 1;
  return source[index] === '/' && source[index - 1] === '<';
}

function findEnclosingDeclaration(
  declarations: readonly VueDeclaration[],
  offset: number,
): VueDeclaration | null {
  let best: VueDeclaration | null = null;
  for (const declaration of declarations) {
    if (offset < declaration.startOffset || offset >= declaration.endOffset) continue;
    if (best === null || declaration.startOffset >= best.startOffset) best = declaration;
  }
  return best;
}

function classifyTemplateEdge(
  projection: VueProjection,
  sourceOffset: number,
): { role: string; kind: ReferenceRecord['kind']; heuristic: boolean; dynamic: boolean } | null {
  const range = templateRangeAt(projection, sourceOffset);
  if (range === null) return null;
  if (range.kind === 'tag') {
    if (isClosingTagAt(projection.source, sourceOffset)) return null;
    return { role: 'template:component-use', kind: 'read', heuristic: false, dynamic: false };
  }
  if (range.kind === 'interpolation') {
    return {
      role: 'template:interpolation',
      kind: 'read',
      heuristic: memberExpressionBefore(projection.source, sourceOffset),
      dynamic: false,
    };
  }
  if (range.kind === 'dynamic-arg') {
    return { role: 'template:dynamic-argument', kind: 'read', heuristic: false, dynamic: true };
  }
  return {
    role: 'template:template-binding',
    kind: 'read',
    heuristic: memberExpressionBefore(projection.source, sourceOffset),
    dynamic: false,
  };
}

/**
 * Maps Vue declarations to SCIP descriptors and derives template / script
 * references from the shadow documents (docs/04-architecture.md 4.1.2/4.1.4,
 * 4.3.2). All coordinates in the result are `.vue` source coordinates.
 */
export function mapVueSymbolsAndReferences(options: MapVueSymbolsOptions): VueMappingResult {
  const projectionByDocPath = new Map<string, VueProjection>();
  const projectionByPath = new Map<string, VueProjection>();
  const perFile = new Map<string, VuePerFileStats>();
  for (const projection of options.projections) {
    projectionByPath.set(projection.path, projection);
    perFile.set(projection.path, { filteredInternal: 0, templateEdges: 0 });
  }
  const declarationsBySymbolId = new Map<string, VueDeclaration>();
  const declarationSymbolId = new Map<VueDeclaration, string>();
  const anchorBySymbolId = new Map<string, { docPath: string; line: number; byteCol: number }>();
  for (const assignment of options.assignments) {
    const declaration = assignment.declaration as VueDeclaration;
    declarationsBySymbolId.set(assignment.symbolId, declaration);
    declarationSymbolId.set(declaration, assignment.symbolId);
    const projection = projectionByPath.get(declaration.path);
    const anchor = declaration.generatedAnchor;
    if (projection !== undefined && anchor !== null) {
      projectionByDocPath.set(anchor.docPath, projection);
      const lineStart = projection.generatedLineStarts[anchor.nameLine] ?? 0;
      const lineEnd =
        projection.generatedLineStarts[anchor.nameLine + 1] ?? projection.generated.length;
      const lineText = projection.generated.slice(lineStart, lineEnd);
      anchorBySymbolId.set(assignment.symbolId, {
        docPath: anchor.docPath,
        line: anchor.nameLine,
        byteCol: utf16ColumnToByte(lineText, anchor.nameCol),
      });
    }
  }
  // Safety net: resolve any projected document by suffix when the declaration map
  // did not run (e.g. a file with no user declarations other than the component).
  for (const projection of options.projections) {
    for (const document of options.documents) {
      if (document.path.endsWith(`/${projection.rootRelativePath}.ts`)) {
        projectionByDocPath.set(document.path, projection);
      }
    }
  }

  const occurrencesByPosition = new Map<string, ScipOccurrence[]>();
  for (const document of options.documents) {
    for (const occurrence of document.occurrences) {
      const line = occurrence.range[0];
      const col = occurrence.range[1];
      if (typeof line !== 'number' || typeof col !== 'number') continue;
      const key = scipPositionKey(document.path, line, col);
      const list = occurrencesByPosition.get(key) ?? [];
      list.push(occurrence);
      occurrencesByPosition.set(key, list);
    }
  }

  const componentSymbolByPath = new Map<string, string>();
  for (const [symbolId, declaration] of declarationsBySymbolId) {
    if (declaration.kind === 'component') componentSymbolByPath.set(declaration.path, symbolId);
  }

  const stats: MappingStats = {
    eligible: 0,
    exact: 0,
    structural: 0,
    conflict: 0,
    ambiguous: 0,
    unmapped: 0,
    mappingSuccessRate: 0,
    falseMatchCount: 0,
    collisions: 0,
  };
  const unmappedReasonCounts: Record<string, number> = {};
  const scipSymbolBySymbolId = new Map<string, string | null>();
  const qualityBySymbolId = new Map<
    string,
    'exact' | 'structural' | 'conflict' | 'ambiguous' | 'unmapped'
  >();
  const symbolKeyToSymbolId = new Map<string, string>();
  const symbols: SymbolRecord[] = [];

  for (const assignment of options.assignments) {
    const declaration = declarationsBySymbolId.get(assignment.symbolId) as VueDeclaration;
    const anchor = anchorBySymbolId.get(assignment.symbolId);
    let quality: 'exact' | 'structural' | 'conflict' | 'unmapped' = 'unmapped';
    let scipSymbol: string | null = null;
    if (declaration.syntheticComponent) {
      unmappedReasonCounts['synthetic-component'] =
        (unmappedReasonCounts['synthetic-component'] ?? 0) + 1;
    } else if (anchor === undefined) {
      unmappedReasonCounts['no-generation-anchor'] =
        (unmappedReasonCounts['no-generation-anchor'] ?? 0) + 1;
    } else {
      const candidates = occurrencesByPosition.get(
        scipPositionKey(anchor.docPath, anchor.line, anchor.byteCol),
      );
      const occurrence = candidates?.[0];
      if (occurrence === undefined) {
        unmappedReasonCounts['no-scip-occurrence'] =
          (unmappedReasonCounts['no-scip-occurrence'] ?? 0) + 1;
      } else {
        scipSymbol = occurrence.symbol;
        if (isLocalSymbol(occurrence.symbol)) {
          quality = 'exact';
        } else {
          const descriptor = vueDescriptorName(occurrence.symbol);
          if (descriptor === declaration.name) quality = 'exact';
          else if (descriptor === '' && declaration.isAnonymous) quality = 'structural';
          else if (descriptor === '') quality = 'structural';
          else {
            quality = 'conflict';
            stats.conflict += 1;
            stats.falseMatchCount += 1;
            unmappedReasonCounts['name-mismatch'] =
              (unmappedReasonCounts['name-mismatch'] ?? 0) + 1;
          }
        }
        if (quality === 'exact') stats.exact += 1;
        else if (quality === 'structural') stats.structural += 1;
        if (scipSymbol !== null) {
          symbolKeyToSymbolId.set(
            isLocalSymbol(scipSymbol) ? localKey(anchor.docPath, scipSymbol) : scipSymbol,
            assignment.symbolId,
          );
        }
      }
    }
    if (!declaration.syntheticComponent) {
      stats.eligible += 1;
      if (quality === 'unmapped') stats.unmapped += 1;
    }
    scipSymbolBySymbolId.set(assignment.symbolId, scipSymbol);
    qualityBySymbolId.set(assignment.symbolId, quality);
    const record = toSymbolRecord(assignment, quality === 'unmapped' ? 'unmapped' : quality);
    record.analysisEngine = 'vue-language-core';
    symbols.push(record);
  }

  stats.mappingSuccessRate =
    stats.eligible === 0 ? 0 : (stats.exact + stats.structural) / stats.eligible;

  const declarationsByPath = new Map<string, VueDeclaration[]>();
  const propMemberByPath = new Map<string, Map<string, string>>();
  for (const [symbolId, declaration] of declarationsBySymbolId) {
    const list = declarationsByPath.get(declaration.path) ?? [];
    list.push(declaration);
    declarationsByPath.set(declaration.path, list);
    if (declaration.componentMember && declaration.nameChain.includes('.$props.')) {
      const members = propMemberByPath.get(declaration.path) ?? new Map<string, string>();
      members.set(declaration.name, symbolId);
      propMemberByPath.set(declaration.path, members);
    }
  }
  // Interface / type-literal prop members are not tagged `componentMember`; add
  // them using the component drafts so defaulted props can be resolved.
  for (const componentDraft of options.components) {
    const members =
      propMemberByPath.get(componentDraft.declaration.path) ?? new Map<string, string>();
    const candidates = declarationsByPath.get(componentDraft.declaration.path) ?? [];
    for (const prop of componentDraft.props) {
      if (members.has(prop.name)) continue;
      const match = candidates.find(
        (declaration) =>
          declaration.name === prop.name &&
          declaration.nameChain !== prop.name &&
          (declaration.kind === 'var' || declaration.kind === 'fn'),
      );
      if (match !== undefined) {
        const symbolId = declarationSymbolId.get(match);
        if (symbolId !== undefined) members.set(prop.name, symbolId);
      }
    }
    propMemberByPath.set(componentDraft.declaration.path, members);
  }
  for (const list of declarationsByPath.values()) {
    list.sort((left, right) => left.startOffset - right.startOffset);
  }

  function identifierAt(projection: VueProjection, offset: number): string {
    const match = /^[A-Za-z_$][\w$]*/.exec(projection.source.slice(offset));
    return match?.[0] ?? '';
  }

  const references: ReferenceRecord[] = [];
  const seen = new Set<string>();
  let filteredInternal = 0;
  let externalReferences = 0;
  let localOrUnmappedReferences = 0;
  const templateEdges: VueTemplateEdgeStats = {
    total: 0,
    certain: 0,
    heuristic: 0,
    dynamicUnresolved: 0,
  };

  for (const document of options.documents) {
    const projection = projectionByDocPath.get(document.path);
    if (projection === undefined) continue;
    const declarations = declarationsByPath.get(projection.path) ?? [];
    const componentSymbolId = componentSymbolByPath.get(projection.path) ?? null;
    for (const occurrence of document.occurrences) {
      const line = occurrence.range[0];
      const byteCol = occurrence.range[1];
      if (typeof line !== 'number' || typeof byteCol !== 'number') continue;
      if (isDefinition(occurrence)) continue;
      const lineStart = projection.generatedLineStarts[line] ?? 0;
      const lineEnd = projection.generatedLineStarts[line + 1] ?? projection.generated.length;
      const lineText = projection.generated.slice(lineStart, lineEnd);
      const sourceOffset = generatedToSource(
        projection,
        lineStart + utf8ColumnToUnit(lineText, byteCol),
      );
      const internal = isInternalSymbol(occurrence.symbol);
      if (sourceOffset === null) {
        if (internal || occurrence.symbol.includes(projection.rootRelativePath)) {
          filteredInternal += 1;
          const entry = perFile.get(projection.path);
          if (entry !== undefined) entry.filteredInternal += 1;
        } else {
          localOrUnmappedReferences += 1;
        }
        continue;
      }
      const symbolIdFromEngine = isLocalSymbol(occurrence.symbol)
        ? symbolKeyToSymbolId.get(localKey(document.path, occurrence.symbol))
        : (symbolKeyToSymbolId.get(occurrence.symbol) ??
          options.tsScipSymbolToSymbolId.get(occurrence.symbol));
      const inTemplate = isInsideTemplate(projection, sourceOffset);
      let symbolId = symbolIdFromEngine;
      let usedPropFallback = false;
      if (symbolId === undefined && inTemplate) {
        // Volar lowers defaulted props through a generated `__VLS_defaults`
        // object, so the SCIP target can be a generated alias. In template scope
        // an unresolved identifier matching a declared prop is that prop. This
        // is name-based evidence, so the edge is heuristic
        // (docs/08-relations.md 8.1).
        const propMembers = propMemberByPath.get(projection.path);
        const name = identifierAt(projection, sourceOffset);
        if (propMembers !== undefined && name !== '') {
          symbolId = propMembers.get(name);
          usedPropFallback = symbolId !== undefined;
        }
      }
      if (symbolId === undefined) {
        if (internal) {
          filteredInternal += 1;
          const entry = perFile.get(projection.path);
          if (entry !== undefined) entry.filteredInternal += 1;
        } else if (isLocalSymbol(occurrence.symbol)) {
          localOrUnmappedReferences += 1;
        } else {
          externalReferences += 1;
        }
        continue;
      }
      const position = offsetToPosition(projection.sourceLineStarts, sourceOffset);
      if (inTemplate) {
        const edge = classifyTemplateEdge(projection, sourceOffset);
        if (edge === null) continue;
        const relationClass = edge.dynamic
          ? 'dynamic-unresolved'
          : edge.heuristic || usedPropFallback
            ? 'heuristic'
            : 'certain';
        const confidence = edge.dynamic
          ? 'unresolved'
          : edge.heuristic || usedPropFallback
            ? 'heuristic'
            : 'typed';
        const dedupeKey = `${projection.path}\\u0000${position.line}\\u0000${position.col}\\u0000${symbolId}\\u0000${edge.role}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        references.push({
          targetSymbolId: symbolId,
          targetScipSymbol: null,
          sourceSymbolId: componentSymbolId,
          sourceFile: projection.path,
          kind: edge.kind,
          role: edge.role,
          relationClass,
          confidence,
          analysisEngine: 'vue-language-core',
          line: position.line,
          col: position.col,
          unresolvedReason: edge.dynamic ? 'dynamic-argument-key' : null,
          buildId: options.buildId,
        });
        templateEdges.total += 1;
        if (relationClass === 'certain') templateEdges.certain += 1;
        else if (relationClass === 'heuristic') templateEdges.heuristic += 1;
        else templateEdges.dynamicUnresolved += 1;
        const entry = perFile.get(projection.path);
        if (entry !== undefined) entry.templateEdges += 1;
        continue;
      }
      const enclosing = findEnclosingDeclaration(declarations, sourceOffset);
      const sourceSymbolId = enclosing === null ? null : declarationSymbolId.get(enclosing);
      const dedupeKey = `${projection.path}\\u0000${position.line}\\u0000${position.col}\\u0000${symbolId}\\u0000${occurrence.symbol}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      references.push({
        targetSymbolId: symbolId,
        targetScipSymbol: null,
        sourceSymbolId: sourceSymbolId ?? componentSymbolId,
        sourceFile: projection.path,
        kind: isImport(occurrence) ? 'import' : isWriteAccess(occurrence) ? 'write' : 'read',
        role: isImport(occurrence) ? 'import' : isWriteAccess(occurrence) ? 'write' : 'read',
        relationClass: 'certain',
        confidence: 'typed',
        analysisEngine: 'vue-language-core',
        line: position.line,
        col: position.col,
        unresolvedReason: null,
        buildId: options.buildId,
      });
    }
  }

  references.sort((left, right) => {
    if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.col !== right.col) return left.col - right.col;
    const leftTarget = left.targetSymbolId ?? '';
    const rightTarget = right.targetSymbolId ?? '';
    return leftTarget < rightTarget ? -1 : leftTarget > rightTarget ? 1 : 0;
  });
  symbols.sort((left, right) =>
    left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0,
  );

  return {
    symbols,
    references,
    scipSymbolBySymbolId,
    scipSymbolToSymbolId: new Map(
      [...symbolKeyToSymbolId].filter(([key]) => !key.includes('\\u0000')),
    ),
    qualityBySymbolId,
    stats,
    unmappedReasonCounts,
    externalReferences,
    localOrUnmappedReferences,
    filteredInternal,
    templateEdges,
    perFile,
    componentSymbolByPath,
  };
}
