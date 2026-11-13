/**
 * anemia-core public API. Build and query layers are separated; the CLI is the
 * only consumer in Phase 01.
 */
export { NexusError, nexusError, mapUnknownError, isNexusError, ERROR_META } from './errors.js';
export type { ErrorCode, ErrorCategory, Severity } from './errors.js';
export {
  EXIT_SUCCESS,
  EXIT_BLOCKING,
  EXIT_WARNING,
  EXIT_USAGE,
  EXIT_INTERNAL,
  exitCodeForError,
  exitCodeForWarnings,
} from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';
export { configSchema, DEFAULT_CONFIG } from './config/schema.js';
export type { NexusConfig, OutputConfig } from './config/schema.js';
export { configJsonSchema } from './config/json-schema.js';
export { loadConfig, type LoadedConfig } from './config/load.js';
export { discoverRoots, readWorkspaceDeclarations } from './discovery/roots.js';
export type { DiscoveryResult, RootCandidate, WorkspaceDeclaration } from './discovery/roots.js';
export { checkTypecheck } from './discovery/typecheck.js';
export { runInit } from './init.js';
export type { InitOptions, InitPlan, InitResult, InitCandidateView } from './init.js';
export { buildWorkspace, clearTmp } from './index/build.js';
export { BuildWriter, commitBuild, WRITE_BATCH_SIZE } from './store/commit.js';
export {
  createSurfaceSnapshot,
  diffCurrentSurface,
  writeBaselineSnapshot,
  buildSurfaceLookup,
} from './surface/service.js';
export { buildSurface } from './surface/builder.js';
export { diffSnapshots } from './surface/diff.js';
export { readSurface, readBaseline } from './surface/store.js';
export type {
  DeprecatedChain,
  SurfaceBaseline,
  SurfaceDiff,
  SurfaceDiffItem,
  SurfaceEntry,
  SurfaceEvidenceSource,
  SurfaceExportKind,
  SurfaceInternalRecord,
  SurfaceOpaqueRecord,
  SurfaceRootSnapshot,
  SurfaceSnapshot,
} from './surface/types.js';
export type {
  BuildOptions,
  BuildProgressEvent,
  BuildResult,
  RootBuildResult,
} from './index/build.js';
export { SCHEMA_VERSION as BUILD_SCHEMA_VERSION } from './index/fingerprint.js';
export { statusReport, verifyFreshness, findActiveRoot, CAPABILITIES } from './status.js';
export type {
  StatusReport,
  StatusOptions,
  RootStatus,
  SelfInfo,
  WarningItem,
  ConfigStatus,
  VerifyFreshnessInput,
} from './status.js';
export { runDoctor, unsupportedDoctorFlag } from './doctor.js';
export type { DoctorReport, DoctorCheck, DoctorOptions, CheckStatus } from './doctor.js';
export { dumpVueMap } from './vue/dump.js';
export { querySymbol, queryReferences, querySearch, queryDependencies } from './query/service.js';
export type {
  QueryOptions,
  SymbolItem,
  ReferenceItem,
  SearchItem,
  SymbolQueryResult,
  ReferencesQueryResult,
  SearchQueryResult,
  DependencyQueryType,
  DependencyItem,
  DependencyQueryResult,
} from './query/service.js';
export { openReadStore } from './store/read.js';
export {
  deriveRootState,
  beginIndexing,
  endIndexing,
  readIndexingMarker,
  clearStaleIndexingMarker,
  isTransitionAllowed,
  assertTransition,
  STATE_TRANSITIONS,
  STATE_NAMES,
} from './store/state.js';
export type {
  IndexState,
  IndexingMarker,
  StateDerivationInput,
  StateDerivation,
} from './store/state.js';
export { recoverRoot, recoverWorkspace } from './store/recovery.js';
export type { RecoveryOutcome, RecoveryResult, WorkspaceRecoveryResult } from './store/recovery.js';
export {
  readWorkspace,
  writeWorkspaceAtomic,
  buildWorkspaceSnapshot,
  reconcileWorkspace,
} from './store/workspace.js';
export type { WorkspaceSnapshot, WorkspaceRootEntry, WorkspaceCheck } from './store/workspace.js';
export {
  INVALIDATION_RULES,
  classifyRootChanges,
  planRootChange,
  diffFileSets,
  computeTsconfigHash,
  computeInvalidatedClosure,
  readCommittedFiles,
  matchFileGlob,
} from './index/invalidation.js';
export type {
  InvalidationRule,
  FileChange,
  FileChangeKind,
  RootChangeInput,
  RootChangePlan,
} from './index/invalidation.js';
export {
  GlobalResourceCoordinator,
  computeResourceBudget,
  computeRootWeights,
  orderRootsByDependencies,
  DEGRADATION_LADDER,
} from './scheduler.js';
export type {
  ResourceConfig,
  ResourceBudget,
  RootWeight,
  DegradationFlags,
  DegradationStage,
} from './scheduler.js';
export {
  verifyIncrementalEquivalence,
  compareRoot,
  formatEquivalenceReport,
  EQUIVALENCE_FIELDS,
} from './index/equivalence.js';
export type { EquivalenceResult, EquivalenceField, FieldComparison } from './index/equivalence.js';
export { computeBuildFingerprint, computeRootSetHash, platformId } from './index/fingerprint.js';
export { CRASH_POINTS } from './store/inject.js';
export { resolveQueryScope } from './query/routing.js';
export type { QueryScope, ScopeSelection, ScopeCandidate } from './query/routing.js';
export { analyzeImpact, impactData } from './audit/impact.js';
export type {
  ImpactOptions,
  ImpactResult,
  RootImpactReport,
  ImpactItem,
  ImpactRisk,
  ImpactTarget,
  ImpactTargetKind,
  StyleDependent,
} from './audit/impact.js';
export { runPreflight } from './audit/preflight.js';
export type { PreflightData, PreflightOptions, PreflightSource } from './audit/preflight.js';
export { runPostflight } from './audit/postflight.js';
export type {
  ChangedSymbol,
  FailOn,
  Finding,
  PostflightData,
  PostflightOptions,
} from './audit/postflight.js';
export { runVerify, readTrust, writeTrust, commandSignature } from './audit/verify.js';
export type {
  TrustEntry,
  TrustFile,
  VerifyCommandResult,
  VerifyOptions,
  VerifyResult,
} from './audit/verify.js';
export { buildTaskContext } from './audit/context.js';
export type { ContextItem, TaskContextPacket } from './audit/context.js';
export {
  findSimilar,
  extractSymbolNames,
  scoreCandidate,
  parseSignature,
  SIMILARITY_RULES_VERSION,
} from './audit/similar.js';
export type { SimilarityCandidate, SimilarityBreakdown, SignatureParts } from './audit/similar.js';
export { probeSqlite } from './store/db.js';
export type {
  Coverage,
  Counts,
  QueryEnvelope,
  StalenessState,
  SymbolRecord,
  ReferenceRecord,
  DependencyRecord,
  CallRecord,
  BlindSpot,
} from './model.js';
export { stableStringify } from './util/stable-json.js';
export { contentHash, sha256Hex, sha256Base32 } from './util/hash.js';
export { base32Encode } from './util/base32.js';
export { SCIP_VERSION } from './index/analyzer.js';
