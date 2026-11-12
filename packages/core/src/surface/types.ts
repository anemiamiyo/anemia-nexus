/**
 * API Surface types (docs/06-api-surface.md 6.1/6.2/6.4). These are derived
 * build artifacts: they live in `.nexus/roots/<rootId>/surface.json` and in
 * `nexus.baseline.json`, never as a second source of truth next to the DB.
 */
export type SurfaceClass = 'public' | 'internal' | 'opaque';

export type SurfaceEvidenceSource =
  'manual-override' | 'package-exports' | 'explicit-entry' | 'barrel-derived' | 'none';

export type SurfaceExportKind = 'type' | 'value' | 'both';

export type SurfaceKind = 'value' | 'type' | 'component' | 'composable' | 'config';

export type SurfaceStability = 'stable' | 'experimental' | 'deprecated';

export interface SurfacePropsCoverage {
  resolved: number;
  total: number;
}

export interface SurfaceUnresolvedProp {
  name: string;
  typeText: string;
  reason: string;
}

export interface SurfaceEntry {
  name: string;
  normalizedSignature: string;
  /** Newline-joined overload signatures; deterministic order by overloadOrdinal. */
  signatures?: string[];
  kind: SurfaceKind;
  exportKind: SurfaceExportKind;
  isTypeOnly: boolean;
  runtimePresent: boolean;
  /** Package subpath (`"."`, `"./utils"`) or project-relative entry file. */
  entryPath: string | null;
  condition: string | null;
  evidenceSources: SurfaceEvidenceSource[];
  primaryEvidenceSource: SurfaceEvidenceSource;
  derived: boolean;
  stability: SurfaceStability;
  since: string;
  ownerModule: string | null;
  docLink: string | null;
  symbolId: string;
  identityConfidence: string;
  manualOverrideConflict?: boolean;
  propsCoverage?: SurfacePropsCoverage;
  unresolvedProps?: SurfaceUnresolvedProp[];
}

export interface SurfaceInternalRecord {
  name: string;
  normalizedSignature: string;
  kind: SurfaceKind;
  exportKind: SurfaceExportKind;
  isTypeOnly: boolean;
  runtimePresent: boolean;
  symbolId: string;
  evidenceSources: SurfaceEvidenceSource[];
  primaryEvidenceSource: SurfaceEvidenceSource;
}

export interface SurfaceOpaqueRecord {
  name: string;
  entryPath: string | null;
  condition: string | null;
  reason: string;
}

export interface DeprecatedChain {
  symbolId: string;
  name: string;
  /** Replacement symbolId when exactly one candidate resolves. */
  successorId: string | null;
  successorName: string | null;
  candidates: Array<{ symbolId: string; name: string; nameChain: string }>;
  status: 'resolved' | 'ambiguous' | 'no-successor';
  reason: string;
  removalVersion: string | null;
  deprecatedAt: string | null;
  suggestion: string;
}

export interface SurfaceRootSnapshot {
  surfaceVersion: 1;
  rootId: string;
  rootPath: string;
  packageName: string | null;
  buildId: string;
  buildFingerprint: string;
  packageVersion: string | null;
  surfaceHash: string;
  entries: SurfaceEntry[];
  internal: SurfaceInternalRecord[];
  opaque: SurfaceOpaqueRecord[];
  deprecated: DeprecatedChain[];
  warnings: string[];
}

export interface SurfaceSnapshot {
  surfaceVersion: 1;
  surfaceHash: string;
  roots: Record<string, SurfaceRootSnapshot>;
  warnings: string[];
}

export interface SurfaceBaselineRoot {
  rootPath: string;
  packageName: string | null;
  buildFingerprint: string;
  surfaceHash: string;
  entries: SurfaceEntry[];
  internal: SurfaceInternalRecord[];
  opaque: SurfaceOpaqueRecord[];
  deprecated: DeprecatedChain[];
}

export interface SurfaceBaseline {
  baselineVersion: 1;
  surfaceHash: string;
  roots: Record<string, SurfaceBaselineRoot>;
}

export type SurfaceDiffSeverity = 'breaking' | 'additive' | 'internal' | 'ambiguous';

export interface SurfaceDiffItem {
  id: string;
  severity: SurfaceDiffSeverity;
  code: string;
  rootId: string;
  name: string;
  entryPath: string | null;
  condition: string | null;
  before: SurfaceEntry | SurfaceInternalRecord | null;
  after: SurfaceEntry | SurfaceInternalRecord | null;
  evidence: {
    beforeEvidenceSources: SurfaceEvidenceSource[];
    afterEvidenceSources: SurfaceEvidenceSource[];
    beforeExportKind: SurfaceExportKind | null;
    afterExportKind: SurfaceExportKind | null;
    symbolId: string | null;
  };
  rationale: string;
}

export interface SurfaceDiff {
  command: 'api-diff';
  base: string;
  buildFingerprint: string | null;
  counts: {
    total: number;
    breaking: number;
    additive: number;
    internal: number;
    ambiguous: number;
  };
  surfaceHash: string | null;
  baselineSurfaceHash: string | null;
  items: SurfaceDiffItem[];
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  notes: string[];
}
