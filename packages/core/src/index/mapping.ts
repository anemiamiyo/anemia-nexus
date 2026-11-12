import ts from 'typescript';

import type {
  DeclarationRecord,
  IdentityConfidence,
  MappingQuality,
  ReferenceRecord,
  SymbolRecord,
} from '../model.js';
import { collisionSuffix, computeAnonymousSymbolId, computeSymbolId } from './symbol-id.js';
import {
  isDefinition,
  isImport,
  isWriteAccess,
  scipDescriptorName as descriptorName,
  type ScipIndexData,
  type ScipOccurrence,
} from './scip.js';

export interface PreviousIdentity {
  locatorKey: string;
  symbolId: string;
  confidence: IdentityConfidence;
  evidence: string[];
}

export interface IdentityAssignment {
  declaration: DeclarationRecord;
  symbolId: string;
  volatile: boolean;
  identityConfidence: IdentityConfidence;
  identityEvidence: string[];
  mappingQuality: MappingQuality;
  scipSymbol: string | null;
}

export interface MappingStats {
  eligible: number;
  exact: number;
  structural: number;
  conflict: number;
  ambiguous: number;
  unmapped: number;
  mappingSuccessRate: number;
  falseMatchCount: number;
  collisions: number;
}

export interface MappingResult {
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  scipSymbolBySymbolId: Map<string, string | null>;
  /** Global SCIP symbol (non-local descriptors) -> symbolId, used by the Vue merger. */
  scipSymbolToSymbolId: Map<string, string>;
  stats: MappingStats;
  unmappedReasonCounts: Record<string, number>;
  externalReferences: number;
  localOrUnmappedReferences: number;
}

export function locatorKey(
  declaration: Pick<DeclarationRecord, 'path' | 'startLine' | 'startCol' | 'kind' | 'nameChain'>,
): string {
  return `${declaration.path}:${declaration.startLine}:${declaration.startCol}:${declaration.kind}:${declaration.nameChain}`;
}

function anchorKey(relativePath: string, line: number, col: number): string {
  return `${relativePath.replaceAll('\\', '/')}:${line}:${col}`;
}

interface DefinitionEntry {
  symbol: string;
  occurrence: ScipOccurrence;
  documentPath: string;
}

function collectDefinitions(index: ScipIndexData): Map<string, DefinitionEntry[]> {
  const map = new Map<string, DefinitionEntry[]>();
  for (const document of index.documents) {
    for (const occurrence of document.occurrences) {
      if (!isDefinition(occurrence) || occurrence.symbol === '') continue;
      const start = occurrence.range[0];
      const startCol = occurrence.range[1];
      if (typeof start !== 'number' || typeof startCol !== 'number') continue;
      const key = anchorKey(document.path, start + 1, startCol);
      const list = map.get(key) ?? [];
      list.push({ symbol: occurrence.symbol, occurrence, documentPath: document.path });
      map.set(key, list);
    }
  }
  return map;
}

export function assignIdentities(
  declarations: readonly DeclarationRecord[],
  rootId: string,
  previous: ReadonlyMap<string, PreviousIdentity>,
): { assignments: IdentityAssignment[]; collisions: number } {
  const used = new Map<string, string>();
  const collisionsByLocator: string[] = [];
  const assignments: IdentityAssignment[] = [];

  const sorted = [...declarations].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.startLine !== right.startLine) return left.startLine - right.startLine;
    return left.startCol - right.startCol;
  });

  for (const declaration of sorted) {
    const key = locatorKey(declaration);
    let symbolId: string;
    let volatile = declaration.isAnonymous;
    let identityConfidence: IdentityConfidence = declaration.isAnonymous ? 'medium' : 'high';
    let identityEvidence: string[] = declaration.isAnonymous
      ? ['position-anchored']
      : ['same-build'];
    const prior = previous.get(key);
    if (prior !== undefined) {
      symbolId = prior.symbolId;
      identityConfidence = prior.confidence;
      identityEvidence = [...prior.evidence, 'same-locator'];
    } else if (declaration.isAnonymous) {
      symbolId = computeAnonymousSymbolId({
        rootId,
        kind: declaration.kind,
        path: declaration.path,
        startLine: declaration.startLine,
        startCol: declaration.startCol,
        syntaxContextHash: declaration.syntaxContextHash,
      });
    } else {
      symbolId = computeSymbolId({
        rootId,
        kind: declaration.kind,
        nameChain: declaration.nameChain,
        structuralFingerprint: declaration.structuralFingerprint,
      });
    }

    const existingLocator = used.get(symbolId);
    if (existingLocator !== undefined && existingLocator !== key) {
      symbolId += collisionSuffix(key);
      volatile = true;
      if (identityConfidence === 'high') identityConfidence = 'medium';
      identityEvidence = [...identityEvidence, 'collision-suffix'];
      collisionsByLocator.push(key);
    }
    used.set(symbolId, key);
    assignments.push({
      declaration,
      symbolId,
      volatile,
      identityConfidence,
      identityEvidence,
      mappingQuality: 'unmapped',
      scipSymbol: null,
    });
  }

  return { assignments, collisions: collisionsByLocator.length };
}

function lookupScipTarget(symbol: string, map: ReadonlyMap<string, string>): string | null {
  const direct = map.get(symbol);
  if (direct !== undefined) return direct;
  // SCIP models a constructor as `Class#`<constructor>`().`; the class symbol
  // itself is the identity used by the declaration index.
  const classSymbol = symbol.replace(/`<constructor>`\(\)\.$/, '');
  if (classSymbol !== symbol) {
    const classId = map.get(classSymbol);
    if (classId !== undefined) return classId;
  }
  return null;
}

function pickDefinition(entries: readonly DefinitionEntry[] | undefined): DefinitionEntry | null {
  if (entries === undefined || entries.length === 0) return null;
  // Multiple definitions at one anchor (declaration merging) share a SCIP
  // symbol; choosing the first sorted entry is deterministic.
  const sorted = [...entries].sort((left, right) =>
    left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0,
  );
  return sorted[0] ?? null;
}

function classifyMapping(declaration: DeclarationRecord, entry: DefinitionEntry): MappingQuality {
  const descriptor = descriptorName(entry.symbol);
  if (descriptor === declaration.name) return 'exact';
  if (descriptor === '' && declaration.isAnonymous) return 'structural';
  if (descriptor === '') return 'structural';
  return 'conflict';
}

function isExternalSymbol(symbol: string, projectDefinitionSymbols: ReadonlySet<string>): boolean {
  return !projectDefinitionSymbols.has(symbol);
}

function findEnclosingDeclaration(
  declarations: readonly DeclarationRecord[],
  offset: number,
): DeclarationRecord | null {
  let best: DeclarationRecord | null = null;
  for (const declaration of declarations) {
    if (offset < declaration.startOffset || offset >= declaration.endOffset) continue;
    if (best === null || declaration.startOffset >= best.startOffset) best = declaration;
  }
  return best;
}

interface AliasSpecifier {
  propertyOffset: number;
  nameOffset: number;
}

/** `a as b` positions in import/export specifiers; used to align with tsserver. */
function aliasSpecifiers(sourceFile: ts.SourceFile): AliasSpecifier[] {
  const output: AliasSpecifier[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.propertyName !== undefined) {
            output.push({
              propertyOffset: element.propertyName.getStart(sourceFile),
              nameOffset: element.name.getStart(sourceFile),
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.propertyName !== undefined) {
            output.push({
              propertyOffset: element.propertyName.getStart(sourceFile),
              nameOffset: element.name.getStart(sourceFile),
            });
          }
        }
      }
    }
  }
  return output;
}

export interface ExtractReferencesOptions {
  index: ScipIndexData;
  assignments: readonly IdentityAssignment[];
  sourceFiles: ReadonlyMap<string, ts.SourceFile>;
  buildId: string;
}

export function mapSymbolsAndReferences(options: ExtractReferencesOptions): MappingResult {
  const { index, assignments } = options;
  const definitions = collectDefinitions(index);
  const projectDefinitionSymbols = new Set<string>();
  for (const entries of definitions.values()) {
    for (const entry of entries) projectDefinitionSymbols.add(entry.symbol);
  }

  const byLocator = new Map<string, IdentityAssignment>();
  for (const assignment of assignments) {
    byLocator.set(
      anchorKey(
        assignment.declaration.path,
        assignment.declaration.nameLine,
        assignment.declaration.nameCol,
      ),
      assignment,
    );
  }

  const stats: MappingStats = {
    eligible: assignments.length,
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
  const symbols: SymbolRecord[] = [];
  const scipToSymbolId = new Map<string, string>();
  const scipSymbolBySymbolId = new Map<string, string | null>();

  for (const assignment of assignments) {
    const declaration = assignment.declaration;
    const key = anchorKey(declaration.path, declaration.nameLine, declaration.nameCol);
    const entry = pickDefinition(definitions.get(key));
    let mappingQuality: MappingQuality;
    let scipSymbol: string | null = null;
    if (entry === null) {
      mappingQuality = 'unmapped';
      stats.unmapped += 1;
      unmappedReasonCounts['no-definition-at-location'] =
        (unmappedReasonCounts['no-definition-at-location'] ?? 0) + 1;
    } else {
      scipSymbol = entry.symbol;
      mappingQuality = classifyMapping(declaration, entry);
      if (mappingQuality === 'exact') stats.exact += 1;
      else if (mappingQuality === 'structural') stats.structural += 1;
      else {
        stats.conflict += 1;
        stats.falseMatchCount += 1;
        unmappedReasonCounts['name-mismatch'] = (unmappedReasonCounts['name-mismatch'] ?? 0) + 1;
      }
      const current = scipToSymbolId.get(entry.symbol);
      if (current === undefined) scipToSymbolId.set(entry.symbol, assignment.symbolId);
    }
    scipSymbolBySymbolId.set(assignment.symbolId, scipSymbol);
    const record = toSymbolRecord(assignment, mappingQuality);
    symbols.push(record);
  }

  stats.collisions = assignments.filter((assignment) =>
    assignment.identityEvidence.includes('collision-suffix'),
  ).length;
  stats.mappingSuccessRate =
    stats.eligible === 0 ? 0 : (stats.exact + stats.structural) / stats.eligible;

  const references: ReferenceRecord[] = [];
  let externalReferences = 0;
  let localOrUnmappedReferences = 0;
  const seenReferences = new Set<string>();

  for (const document of index.documents) {
    const sourceFile = options.sourceFiles.get(document.path);
    const declarationsForFile = assignments
      .filter((assignment) => assignment.declaration.path === document.path)
      .map((assignment) => assignment.declaration)
      .sort((left, right) => left.startOffset - right.startOffset);
    for (const occurrence of document.occurrences) {
      if (isDefinition(occurrence)) continue;
      if (occurrence.symbol === '') continue;
      const line = occurrence.range[0];
      const col = occurrence.range[1];
      if (typeof line !== 'number' || typeof col !== 'number') continue;
      const targetSymbolId = lookupScipTarget(occurrence.symbol, scipToSymbolId);
      const targetMapped = targetSymbolId !== null;
      if (!targetMapped) {
        if (isExternalSymbol(occurrence.symbol, projectDefinitionSymbols)) {
          externalReferences += 1;
          continue;
        }
        localOrUnmappedReferences += 1;
      }
      let sourceSymbolId: string | null = null;
      if (sourceFile !== undefined) {
        const offset = sourceFile.getPositionOfLineAndCharacter(line, col);
        const enclosing = findEnclosingDeclaration(declarationsForFile, offset);
        if (enclosing !== null) {
          const assignment = byLocator.get(
            anchorKey(enclosing.path, enclosing.nameLine, enclosing.nameCol),
          );
          sourceSymbolId = assignment?.symbolId ?? null;
        }
      }
      const dedupeKey = `${document.path}\u0000${occurrence.symbol}\u0000${sourceSymbolId ?? ''}\u0000${line}\u0000${col}`;
      if (seenReferences.has(dedupeKey)) continue;
      seenReferences.add(dedupeKey);
      const relationClass = targetMapped ? 'certain' : 'dynamic-unresolved';
      const kind = isImport(occurrence) ? 'import' : isWriteAccess(occurrence) ? 'write' : 'read';
      references.push({
        targetSymbolId,
        targetScipSymbol: occurrence.symbol,
        sourceSymbolId,
        sourceFile: document.path,
        kind,
        role: isImport(occurrence) ? 'import' : isWriteAccess(occurrence) ? 'write' : 'read',
        relationClass,
        confidence: targetMapped ? 'typed' : 'unresolved',
        analysisEngine: 'scip',
        line: line + 1,
        col,
        unresolvedReason: targetMapped ? null : 'unmapped-project-symbol',
        buildId: options.buildId,
      });
    }
  }

  // tsserver counts both `a` and `b` in `a as b`; SCIP records the local alias
  // binding at `a` and the target at `b`. Mirror the oracle by adding an edge at
  // the property-name position when the alias-name occurrence resolved.
  for (const document of index.documents) {
    const sourceFile = options.sourceFiles.get(document.path);
    if (sourceFile === undefined) continue;
    const occurrences = new Map<string, ScipOccurrence>();
    for (const occurrence of document.occurrences) {
      if (isDefinition(occurrence)) continue;
      const line = occurrence.range[0];
      const col = occurrence.range[1];
      if (typeof line !== 'number' || typeof col !== 'number') continue;
      occurrences.set(`${line}:${col}`, occurrence);
    }
    const declarationsForFile = assignments
      .filter((assignment) => assignment.declaration.path === document.path)
      .map((assignment) => assignment.declaration)
      .sort((left, right) => left.startOffset - right.startOffset);
    for (const specifier of aliasSpecifiers(sourceFile)) {
      const namePos = sourceFile.getLineAndCharacterOfPosition(specifier.nameOffset);
      const nameOccurrence = occurrences.get(`${namePos.line}:${namePos.character}`);
      if (nameOccurrence === undefined) continue;
      const targetSymbolId = lookupScipTarget(nameOccurrence.symbol, scipToSymbolId);
      if (targetSymbolId === null) continue;
      const propertyPos = sourceFile.getLineAndCharacterOfPosition(specifier.propertyOffset);
      const propertyLine = propertyPos.line + 1;
      const propertyCol = propertyPos.character;
      const dedupeKey = `${document.path}\u0000${nameOccurrence.symbol}\u0000\u0000${propertyLine}\u0000${propertyCol}`;
      if (seenReferences.has(dedupeKey)) continue;
      seenReferences.add(dedupeKey);
      const enclosing = findEnclosingDeclaration(declarationsForFile, specifier.propertyOffset);
      let sourceSymbolId: string | null = null;
      if (enclosing !== null) {
        const assignment = byLocator.get(
          anchorKey(enclosing.path, enclosing.nameLine, enclosing.nameCol),
        );
        sourceSymbolId = assignment?.symbolId ?? null;
      }
      references.push({
        targetSymbolId,
        targetScipSymbol: nameOccurrence.symbol,
        sourceSymbolId,
        sourceFile: document.path,
        kind: 'read',
        role: 'alias',
        relationClass: 'certain',
        confidence: 'typed',
        analysisEngine: 'ts-syntax',
        line: propertyLine,
        col: propertyCol,
        unresolvedReason: null,
        buildId: options.buildId,
      });
    }
  }

  references.sort((left, right) => {
    if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.col !== right.col) return left.col - right.col;
    return (left.targetScipSymbol ?? '') < (right.targetScipSymbol ?? '') ? -1 : 1;
  });

  symbols.sort((left, right) =>
    left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0,
  );
  return {
    symbols,
    references,
    scipSymbolBySymbolId,
    scipSymbolToSymbolId: scipToSymbolId,
    stats,
    unmappedReasonCounts,
    externalReferences,
    localOrUnmappedReferences,
  };
}

export function symbolsFromAssignments(
  assignments: readonly IdentityAssignment[],
  mappingQuality: MappingQuality = 'unmapped',
): SymbolRecord[] {
  return assignments.map((assignment) => toSymbolRecord(assignment, mappingQuality));
}

export function toSymbolRecord(
  assignment: IdentityAssignment,
  mappingQuality: MappingQuality,
): SymbolRecord {
  const d = assignment.declaration;
  return {
    symbolId: assignment.symbolId,
    rootId: d.rootId,
    path: d.path,
    kind: d.kind,
    name: d.name,
    nameChain: d.nameChain,
    signature: d.signature,
    visibility: d.visibility,
    isPublic: d.isExported,
    exportKind: d.exportKind,
    analysisEngine: mappingQuality === 'unmapped' ? 'ts-syntax' : 'scip+ts',
    isTypeOnly: d.isTypeOnly,
    identityConfidence: assignment.identityConfidence,
    volatile: assignment.volatile,
    anonymous: d.isAnonymous,
    nameLine: d.nameLine,
    nameCol: d.nameCol,
    declarationLocator: {
      rootId: d.rootId,
      path: d.path,
      startLine: d.startLine,
      startCol: d.startCol,
      endLine: d.endLine,
      endCol: d.endCol,
      kind: d.kind,
      nameChain: d.nameChain,
      overloadOrdinal: d.overloadOrdinal,
      containerLocatorKey: d.containerLocatorKey,
      syntaxContextHash: d.syntaxContextHash,
      sourceHash: d.sourceHash,
    },
    mappingQuality,
    identityEvidence: assignment.identityEvidence,
  };
}
