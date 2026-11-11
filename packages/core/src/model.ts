import type { SymbolKind } from './index/symbol-id.js';

export type RelationClass = 'certain' | 'heuristic' | 'dynamic-unresolved';
export type Confidence = 'direct' | 'typed' | 'heuristic' | 'unresolved';
export type IdentityConfidence = 'high' | 'medium' | 'low';
export type Visibility = 'exported' | 'public' | 'protected' | 'private' | 'module-local';
export type MappingQuality = 'exact' | 'structural' | 'conflict' | 'ambiguous' | 'unmapped';
export type ReferenceKind = 'import' | 'export' | 'read' | 'write' | 'call' | 'type' | 'unknown';

export interface SourceRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface DeclarationRecord extends SourceRange {
  rootId: string;
  path: string;
  name: string;
  nameChain: string;
  kind: SymbolKind;
  /** Name-node position; the SCIP definition anchor for mapping. */
  nameLine: number;
  nameCol: number;
  /** Offsets into the source file, used to attribute references to a source symbol. */
  startOffset: number;
  endOffset: number;
  signature: string;
  structuralFingerprint: string;
  containerLocatorKey: string;
  overloadOrdinal: number;
  isExported: boolean;
  isDefault: boolean;
  exportKind: 'named' | 'default' | 'none';
  visibility: Visibility;
  isTypeOnly: boolean;
  isAnonymous: boolean;
  syntaxContextHash: string;
  sourceHash: string;
}

export interface SymbolRecord {
  symbolId: string;
  rootId: string;
  path: string;
  kind: SymbolKind;
  name: string;
  nameChain: string;
  signature: string;
  visibility: Visibility;
  isPublic: boolean;
  exportKind: 'named' | 'default' | 'none';
  analysisEngine: string;
  isTypeOnly: boolean;
  identityConfidence: IdentityConfidence;
  identityEvidence: string[];
  volatile: boolean;
  anonymous: boolean;
  nameLine: number;
  nameCol: number;
  declarationLocator: SourceRange & {
    rootId: string;
    path: string;
    kind: SymbolKind;
    nameChain: string;
    overloadOrdinal: number;
    containerLocatorKey: string;
    syntaxContextHash: string;
    sourceHash: string;
  };
  mappingQuality: MappingQuality;
}

export interface ReferenceRecord {
  targetSymbolId: string | null;
  targetScipSymbol: string | null;
  sourceSymbolId: string | null;
  sourceFile: string;
  kind: ReferenceKind;
  role: string;
  relationClass: RelationClass;
  confidence: Confidence;
  analysisEngine: string;
  line: number;
  col: number;
  unresolvedReason: string | null;
  buildId: string;
}

export interface Coverage {
  filesCovered: number;
  filesSkipped: number;
  filesIgnored: number;
  filesFailed: number;
  resolved: number;
  unresolved: number;
  unmapped: number;
}

export interface Counts {
  total: number;
  returned: number;
  certain: number;
  heuristic: number;
  dynamicUnresolved: number;
  partial: number;
}

export interface QueryEnvelope<T> {
  command: string;
  rootId: string | null;
  counts: Counts;
  coverage: Coverage;
  truncated: boolean;
  nextCursor: string | null;
  staleness: StalenessState | 'uninitialized';
  buildFingerprint: string | null;
  identityAmbiguous: boolean;
  degraded: string[];
  items: T[];
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  budget: { layer: string; maxTokens: number | null; maxFiles: number | null };
  mode: 'normal' | 'syntax-only' | 'scoped';
  notes: string[];
}

export type StalenessState = 'fresh' | 'dirty' | 'indexing' | 'stale' | 'failed';

export const EMPTY_COVERAGE: Coverage = {
  filesCovered: 0,
  filesSkipped: 0,
  filesIgnored: 0,
  filesFailed: 0,
  resolved: 0,
  unresolved: 0,
  unmapped: 0,
};

export const EMPTY_COUNTS: Counts = {
  total: 0,
  returned: 0,
  certain: 0,
  heuristic: 0,
  dynamicUnresolved: 0,
  partial: 0,
};
