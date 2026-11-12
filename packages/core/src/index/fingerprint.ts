import { sha256Base32, sha256Hex } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';
import { ANALYZER_VERSION } from './analyzer.js';

export { SCHEMA_VERSION } from '../store/schema.js';

export interface BuildFingerprintFields {
  filesHash: string;
  configHash: string;
  schemaVersion: number;
  analyzerVersion: typeof ANALYZER_VERSION;
  rootSetHash: string;
  nodeVersion: string;
  sqliteVersion: string;
  platform: string;
  degraded: string[];
}

export function computeBuildFingerprint(fields: BuildFingerprintFields): string {
  const canonical = stableStringify({
    filesHash: fields.filesHash,
    configHash: fields.configHash,
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
