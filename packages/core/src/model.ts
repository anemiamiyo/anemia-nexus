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

/**
 * Seven mandatory relation fields (docs/08-relations.md 8.1.3). Values are
 * persisted as one JSON column so every edge can answer "why".
 */
export interface RelationEvidence {
  sourceOfTruth: string;
  analysisVersion: string;
  constraints: string[];
  missReason: string | null;
}

export type DependencyType =
  | 'import'
  | 'import-type'
  | 'export'
  | 'require'
  | 'dynamic-import'
  | 'cross-package'
  | 'style-import'
  | 'style-use'
  | 'style-forward'
  | 'style-src'
  | 'style-link';

export interface DependencyRecord {
  sourceFile: string;
  targetFile: string | null;
  sourceRootId: string;
  targetRootId: string | null;
  isCrossRoot: boolean;
  sourceModule?: string | null;
  targetModule?: string | null;
  depType: DependencyType;
  specifier: string;
  relationClass: RelationClass;
  confidence: Confidence;
  analysisEngine: string;
  line: number;
  col: number;
  unresolvedReason: string | null;
  evidence: RelationEvidence;
}

export interface CallRecord {
  callerSymbolId: string | null;
  calleeSymbolId: string | null;
  callerFile: string;
  calleeFile: string | null;
  line: number;
  col: number;
  resolution: Confidence;
  relationClass: RelationClass;
  confidence: Confidence;
  analysisEngine: string;
  unresolvedReason: string | null;
  evidence: RelationEvidence;
}

export interface ArchitectureModuleRecord {
  name: string;
  include: string[];
  allow: string[] | null;
  fileCount: number;
  symbolCount: number;
}

export type TestType = 'unit' | 'integration' | 'e2e' | 'unknown';

export interface TestRecord {
  testFile: string;
  targetSymbolId: string | null;
  targetFile: string | null;
  testType: TestType;
  relationClass: RelationClass;
  confidence: Confidence;
  analysisEngine: string;
  line: number;
  evidence: RelationEvidence;
}

export interface ArchitectureViolationRecord {
  ruleId: string;
  fromModule: string;
  toModule: string;
  sourceFile: string;
  targetFile: string;
  line: number;
  col: number;
  depType: DependencyType;
  relationClass: RelationClass;
  confidence: Confidence;
  analysisEngine: string;
  evidence: RelationEvidence;
}

export type BlindSpotCategory = 'code' | 'style' | 'multi-root' | 'coverage';

export interface BlindSpot {
  category: BlindSpotCategory;
  missReason: string;
  affectedFiles: number;
  potentiallyAffectedSymbols: number | null;
  estimateMethod: string | null;
  manualCheckHint: string;
  sample: string[];
  sourceQuery: string;
}

export interface Coverage {
  filesCovered: number;
  filesSkipped: number;
  filesIgnored: number;
  filesFailed: number;
  resolved: number;
  unresolved: number;
  unmapped: number;
  /** Volar-internal symbols/edges dropped by docs/04-architecture.md 4.1.2. */
  filteredInternal: number;
  styleFiles?: number;
  styleEdges?: number;
  styleResolved?: number;
  styleUnresolved?: number;
  dependencies?: number;
  calls?: number;
  crossRootEdges?: number;
  architectureViolations?: number;
}

export interface ComponentProp {
  name: string;
  typeText: string;
  required: boolean;
  resolved: boolean;
  reason: string | null;
}

export interface ComponentEmit {
  name: string;
  payloadType: string;
}

export interface ComponentSlot {
  name: string;
  paramsType: string;
  resolved: boolean;
  reason: string | null;
}

export interface PropsCoverage {
  resolved: number;
  total: number;
  unresolved: Array<{ name: string; typeText: string; reason: string }>;
}

export interface ComponentRecord {
  symbolId: string;
  name: string;
  props: ComponentProp[];
  emits: ComponentEmit[];
  slots: ComponentSlot[];
  propsCoverage: PropsCoverage;
  analysisEngine: string;
  source: 'typed' | 'syntax' | 'none';
}

export interface VueFileMetaRecord {
  path: string;
  sourceHash: string;
  projectorVersion: string;
  languageCoreVersion: string;
  generatedBytes: number;
  generatedAt: string;
  filteredInternal: number;
  templateEdges: number;
}

export interface VueAnalysisSummary {
  files: number;
  projected: number;
  failed: number;
  symbols: number;
  mappedSymbols: number;
  unmappedSymbols: number;
  filteredInternal: number;
  components: number;
  propsCoverage: PropsCoverage;
  templateEdges: {
    total: number;
    certain: number;
    heuristic: number;
    dynamicUnresolved: number;
  };
  unmappedReasons: Record<string, number>;
  errors: string[];
}

export interface Counts {
  total: number;
  returned: number;
  certain: number;
  heuristic: number;
  dynamicUnresolved: number;
  partial: number;
}

export interface RootGroup<T> {
  rootId: string;
  rootPath: string;
  staleness: StalenessState;
  buildFingerprint: string | null;
  counts: Counts;
  coverage: Coverage;
  items: T[];
  truncated: boolean;
  nextCursor: string | null;
  notes: string[];
}

export interface QueryEnvelope<T> {
  command: string;
  rootId: string | null;
  /** Query-time root scope (docs/05-data-model.md 5.9). */
  scope?: 'root' | 'roots' | 'all';
  /** Per-root groups for `roots` / `all`; groups keep their own order. */
  byRoot?: RootGroup<T>[];
  /** Same name found in more than one root: never merged, never silently picked. */
  globalAmbiguous?: boolean;
  identityCandidates?: unknown[];
  staleRoots?: string[];
  failedRoots?: string[];
  completeness?: 'complete' | 'partial';
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
  filteredInternal: 0,
};

export const EMPTY_COUNTS: Counts = {
  total: 0,
  returned: 0,
  certain: 0,
  heuristic: 0,
  dynamicUnresolved: 0,
  partial: 0,
};
