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
export { querySymbol, queryReferences, querySearch } from './query/service.js';
export type {
  QueryOptions,
  SymbolItem,
  ReferenceItem,
  SearchItem,
  SymbolQueryResult,
  ReferencesQueryResult,
  SearchQueryResult,
} from './query/service.js';
export { openReadStore } from './store/read.js';
export { probeSqlite } from './store/db.js';
export type {
  Coverage,
  Counts,
  QueryEnvelope,
  StalenessState,
  SymbolRecord,
  ReferenceRecord,
} from './model.js';
export { stableStringify } from './util/stable-json.js';
export { contentHash, sha256Hex, sha256Base32 } from './util/hash.js';
export { base32Encode } from './util/base32.js';
export { SCIP_VERSION } from './index/analyzer.js';
