import { sha256Base32, sha256Hex } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';
import { ANALYZER_VERSION } from './analyzer.js';

export { SCHEMA_VERSION } from '../store/schema.js';

export interface BuildFingerprintFields {
  filesHash: string;
  configHash: string;
  /**
   * Content hash of the root tsconfig (Phase 06). Path aliases, `include`,
   * `references` and compiler options live here, so a tsconfig change must
   * change the fingerprint (docs/12-indexing.md 12.1).
   */
  tsconfigHash: string;
  schemaVersion: number;
  analyzerVersion: typeof ANALYZER_VERSION;
  rootSetHash: string;
  nodeVersion: string;
  sqliteVersion: string;
  platform: string;
  degraded: string[];
}

/**
 * `buildFingerprint = "bf_" + base32(sha256(canonical input))[0..20]`
 * (docs/05-data-model.md 5.11). `builtAt` and `gitCommit` are never inputs.
 */
export function computeBuildFingerprint(fields: BuildFingerprintFields): string {
  const canonical = stableStringify({
    filesHash: fields.filesHash,
    configHash: fields.configHash,
    tsconfigHash: fields.tsconfigHash,
    schemaVersion: fields.schemaVersion,
    analyzerVersion: fields.analyzerVersion,
    rootSetHash: fields.rootSetHash,
    nodeVersion: fields.nodeVersion,
    sqliteVersion: fields.sqliteVersion,
    platform: fields.platform,
    degraded: [...fields.degraded].sort(),
  });
  return `bf_${sha256Base32(canonical, 20)}`;
}

export interface RootSetEntry {
  rootId: string;
  rootPath: string;
  packageName: string | null;
  configHash: string;
}

export function computeRootSetHash(entries: readonly RootSetEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => (left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0))
    .map((entry) => ({
      rootId: entry.rootId,
      rootPath: entry.rootPath,
      packageName: entry.packageName,
      configHash: entry.configHash,
    }));
  return sha256Hex(stableStringify(canonical));
}

export function platformId(): string {
  return `${process.platform}-${process.arch}`;
}
