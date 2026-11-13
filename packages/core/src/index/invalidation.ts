import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RootManifest } from '../store/manifest.js';
import { databasePath } from '../store/manifest.js';
import { openDatabase } from '../store/db.js';
import { SCHEMA_VERSION } from '../store/schema.js';
import { ANALYZER_VERSION } from './analyzer.js';
import { sha256Hex } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';
import { readTsconfig } from '../discovery/tsconfig.js';
import type { ScannedFile } from '../discovery/scan.js';

/**
 * Explicit invalidation table (docs/12-indexing.md 12.1). This is the single
 * source of truth used by change classification and documented by `doctor`;
 * adding a change source here is the only way to widen invalidation.
 */
export interface InvalidationRule {
  id: string;
  source: string;
  invalidates: string[];
  scope: 'file' | 'root' | 'workspace';
}

export const INVALIDATION_RULES: readonly InvalidationRule[] = [
  {
    id: 'file-content',
    source: '文件内容变化',
    invalidates: ['该文件符号', '该文件出边（引用/调用）', '指向它的反向边'],
    scope: 'file',
  },
  {
    id: 'symbol-signature',
    source: '符号签名变化',
    invalidates: ['反向引用集合', 'Surface 快照', '下游符号', 'api-diff 基线'],
    scope: 'root',
  },
  {
    id: 'export-barrel',
    source: '导出 / barrel 变化',
    invalidates: ['重导出链引用', 'Surface 判定', '架构模块图'],
    scope: 'root',
  },
  {
    id: 'identity-migration',
    source: '符号身份迁移',
    invalidates: ['历史表新增', '旧 ID 为 key 的边重写', 'Surface/基线 ID 引用'],
    scope: 'root',
  },
  {
    id: 'tsconfig',
    source: 'tsconfig / 路径别名',
    invalidates: ['该 root 全局重建（不做局部推断）'],
    scope: 'root',
  },
  {
    id: 'package-json',
    source: 'package.json / 锁文件',
    invalidates: ['依赖图', '外部符号解析', '架构规则', 'cross-package 边'],
    scope: 'root',
  },
  {
    id: 'vue-projector',
    source: 'Vue 投影器或 language-core 版本',
    invalidates: ['全部 .vue 投影与坐标转译（等效全局重建）'],
    scope: 'root',
  },
  {
    id: 'root-set',
    source: '根集合变化',
    invalidates: ['受影响 root（新增全量、移除删除、其余按 configHash）'],
    scope: 'workspace',
  },
  {
    id: 'config-merge',
    source: '配置合并结果变化',
    invalidates: ['该 root 全局重建'],
    scope: 'root',
  },
  {
    id: 'analyzer',
    source: '分析器或 Schema 版本',
    invalidates: ['全局重建（按附录 A 判定迁移）'],
    scope: 'workspace',
  },
  {
    id: 'symbol-id-algorithm',
    source: 'symbolId 生成算法变化',
    invalidates: ['全局重建 + 历史表重算（不兼容，需升 schemaVersion）'],
    scope: 'workspace',
  },
  {
    id: 'ignore',
    source: 'ignore / include / style.aliases 变化',
    invalidates: ['全局重建（边界变化）'],
    scope: 'root',
  },
];

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  kind: FileChangeKind;
  path: string;
  previousPath?: string;
  sourceHash?: string;
}

export interface RootChangeInput {
  rootId: string;
  previousManifest: RootManifest | null;
  currentFiles: readonly ScannedFile[];
  currentConfigHash: string;
  currentTsconfigHash: string;
  currentIgnoreHash: string;
  currentRootSetHash: string;
  currentAnalyzerVersion?: unknown;
  currentSchemaVersion?: number;
  /** `--rebuild-affected` */
  forceFull?: boolean;
  /** `--files <glob>` patterns (already validated by the CLI). */
  forcedGlobs?: readonly string[];
}

export interface RootChangePlan {
  rootId: string;
  mode: 'fresh' | 'incremental' | 'full';
  reasons: string[];
  files: FileChange[];
  counts: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    total: number;
  };
  invalidatedFiles: string[];
  invalidatedTruncated: boolean;
  previousBuildId: string | null;
}

export function readCommittedFiles(
  projectRoot: string,
  rootId: string,
): { buildId: string; files: Map<string, string> } | null {
  const dbPath = databasePath(projectRoot, rootId);
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    const schema = db.prepare('select value from meta where key = ?').get('schema_version') as
      { value?: unknown } | undefined;
    if (schema === undefined || Number(schema.value) !== SCHEMA_VERSION) return null;
    const build = db
      .prepare(
        "select build_id as buildId from build_record where status = 'committed' order by started_at desc limit 1",
      )
      .get() as { buildId?: unknown } | undefined;
    if (build === undefined || typeof build.buildId !== 'string') return null;
    const rows = db
      .prepare('select path, source_hash as sourceHash from files where build_id = ?')
      .all(build.buildId) as Array<Record<string, unknown>>;
    const files = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.path === 'string' && typeof row.sourceHash === 'string') {
        files.set(row.path, row.sourceHash);
      }
    }
    return { buildId: build.buildId, files };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function matchFileGlob(relativePath: string, glob: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return globToRegExp(glob.replaceAll('\\', '/')).test(normalized);
}

/** Compare current content hashes against the previous committed build. */
export function diffFileSets(
  previous: ReadonlyMap<string, string>,
  current: readonly ScannedFile[],
): FileChange[] {
  const currentMap = new Map(current.map((file) => [file.path, file.sourceHash]));
  const added: FileChange[] = [];
  const modified: FileChange[] = [];
  const deleted: FileChange[] = [];
  for (const [filePath, sourceHash] of currentMap) {
    const before = previous.get(filePath);
    if (before === undefined) added.push({ kind: 'added', path: filePath, sourceHash });
    else if (before !== sourceHash) modified.push({ kind: 'modified', path: filePath, sourceHash });
  }
  for (const [filePath, sourceHash] of previous) {
    if (!currentMap.has(filePath)) deleted.push({ kind: 'deleted', path: filePath, sourceHash });
  }

  // Rename pairing: a deleted + added row with the same sourceHash is a rename
  // only when the pairing is unique on both sides; otherwise keep add/delete.
  const addedByHash = new Map<string, FileChange[]>();
  for (const entry of added) {
    const hash = entry.sourceHash ?? '';
    const list = addedByHash.get(hash) ?? [];
    list.push(entry);
    addedByHash.set(hash, list);
  }
  const deletedByHash = new Map<string, FileChange[]>();
  for (const entry of deleted) {
    const hash = entry.sourceHash ?? '';
    const list = deletedByHash.get(hash) ?? [];
    list.push(entry);
    deletedByHash.set(hash, list);
  }
  const renamed: FileChange[] = [];
  const consumedAdded = new Set<string>();
  const consumedDeleted = new Set<string>();
  for (const [hash, deletedList] of deletedByHash) {
    const addedList = addedByHash.get(hash);
    if (addedList === undefined || addedList.length !== 1 || deletedList.length !== 1) continue;
    if (hash === '') continue;
    const from = deletedList[0] as FileChange;
    const to = addedList[0] as FileChange;
    renamed.push({
      kind: 'renamed',
      path: to.path,
      previousPath: from.path,
      sourceHash: hash,
    });
    consumedAdded.add(to.path);
    consumedDeleted.add(from.path);
  }
  return [
    ...added.filter((entry) => !consumedAdded.has(entry.path)),
    ...modified,
    ...deleted.filter((entry) => !consumedDeleted.has(entry.path)),
    ...renamed,
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function scrubRootPaths(value: unknown, rootNorm: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('\\', '/').replaceAll(rootNorm, '<root>');
  }
  if (Array.isArray(value)) return value.map((entry) => scrubRootPaths(entry, rootNorm));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = scrubRootPaths((value as Record<string, unknown>)[key], rootNorm);
    }
    return output;
  }
  return value;
}

/**
 * The hash must be identical for the same tsconfig content in two different
 * checkout directories (12.2 compares a full build in one directory with an
 * incremental build in another). Absolute paths derived by TypeScript
 * (`configFilePath`, `pathsBasePath`, `baseUrl`, ...) are normalized to
 * `<root>` before hashing.
 */
export function tsconfigStat(rootAbs: string): { mtimeMs: number; size: number } {
  try {
    const stat = fs.statSync(path.join(rootAbs, 'tsconfig.json'));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

export function computeTsconfigHash(rootAbs: string, relativePath: string): string {
  const tsconfig = readTsconfig(rootAbs, relativePath);
  let content = '';
  try {
    const filePath = path.join(rootAbs, 'tsconfig.json');
    if (fs.existsSync(filePath))
      content = fs.readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n');
  } catch {
    content = '';
  }
  const rootNorm = rootAbs.replaceAll('\\', '/').replace(/\/+$/, '');
  return sha256Hex(
    stableStringify({
      content,
      options: scrubRootPaths(tsconfig.options ?? null, rootNorm),
      errors: tsconfig.errors,
    }),
  );
}

/**
 * Reverse closure over the last committed build: files that depend on,
 * reference, call or test a changed file. Bounded so a large refactor cannot
 * blow the command budget.
 */
export function computeInvalidatedClosure(
  projectRoot: string,
  rootId: string,
  seedFiles: readonly string[],
  limit = 2000,
): { files: string[]; truncated: boolean } {
  const dbPath = databasePath(projectRoot, rootId);
  if (!fs.existsSync(dbPath) || seedFiles.length === 0) {
    return { files: [...seedFiles].sort(), truncated: false };
  }
  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    const build = db
      .prepare(
        "select build_id as buildId from build_record where status = 'committed' order by started_at desc limit 1",
      )
      .get() as { buildId?: unknown } | undefined;
    if (build === undefined || typeof build.buildId !== 'string') {
      return { files: [...seedFiles].sort(), truncated: false };
    }
    const buildId = build.buildId;
    const seen = new Set<string>(seedFiles);
    let frontier = [...seedFiles];
    let truncated = false;
    while (frontier.length > 0) {
      if (seen.size > limit) {
        truncated = true;
        break;
      }
      const placeholders = frontier.map(() => '?').join(',');
      const found = new Set<string>();
      const queries: Array<[string, string[]]> = [
        [
          `select distinct source_file as file from dependencies where build_id = ? and target_file in (${placeholders})`,
          [buildId, ...frontier],
        ],
        [
          `select distinct r.source_file as file from "references" r join symbols s on s.symbol_id = r.target_symbol_id and s.build_id = r.build_id where r.build_id = ? and s.path in (${placeholders})`,
          [buildId, ...frontier],
        ],
        [
          `select distinct c.caller_file as file from calls c join symbols s on s.symbol_id = c.callee_symbol_id and s.build_id = c.build_id where c.build_id = ? and s.path in (${placeholders})`,
          [buildId, ...frontier],
        ],
        [
          `select distinct test_file as file from tests where build_id = ? and target_file in (${placeholders})`,
          [buildId, ...frontier],
        ],
      ];
      for (const [sql, params] of queries) {
        try {
          const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
          for (const row of rows) {
            if (typeof row.file === 'string') found.add(row.file);
          }
        } catch {
          // A missing optional table must not block invalidation.
        }
      }
      frontier = [];
      for (const file of found) {
        if (!seen.has(file)) {
          seen.add(file);
          frontier.push(file);
          if (seen.size > limit) {
            truncated = true;
            break;
          }
        }
      }
    }
    return { files: [...seen].sort(), truncated };
  } catch {
    return { files: [...seedFiles].sort(), truncated: false };
  } finally {
    db?.close();
  }
}

export function classifyRootChanges(
  input: RootChangeInput,
  previousFiles: ReadonlyMap<string, string> | null,
): RootChangePlan {
  const reasons: string[] = [];
  const previous = input.previousManifest;
  const files = previousFiles === null ? [] : diffFileSets(previousFiles, input.currentFiles);
  let mode: RootChangePlan['mode'] = 'fresh';

  if (previous === null) {
    mode = 'full';
    reasons.push('no-previous-index');
  } else {
    if (previous.schemaVersion !== (input.currentSchemaVersion ?? SCHEMA_VERSION)) {
      mode = 'full';
      reasons.push('schema-changed');
    }
    const analyzer = input.currentAnalyzerVersion ?? ANALYZER_VERSION;
    if (JSON.stringify(previous.analyzerVersion ?? null) !== JSON.stringify(analyzer)) {
      mode = 'full';
      reasons.push('analyzer-changed');
    }
    if (previous.configHash !== '' && previous.configHash !== input.currentConfigHash) {
      mode = 'full';
      reasons.push('config-merge');
    }
    if (
      previous.tsconfigHash !== undefined &&
      previous.tsconfigHash !== '' &&
      previous.tsconfigHash !== input.currentTsconfigHash
    ) {
      mode = 'full';
      reasons.push('tsconfig');
    }
    if (previous.ignoreHash !== '' && previous.ignoreHash !== input.currentIgnoreHash) {
      mode = 'full';
      reasons.push('ignore');
    }
    // A root-set change only builds new roots (no manifest) and leaves existing
    // roots untouched (docs/12-indexing.md 12.1 / docs/17-testing.md 17.2 #15).
    // `rootSetHash` still participates in the fingerprint, so a removed root is
    // reported by `doctor` and cleaned by the Phase 07 repair path.
    if (previous.recovered === true) {
      mode = 'full';
      reasons.push('recovered-manifest');
    }
    if (previous.statHash === undefined || previous.statHash === '') {
      mode = 'full';
      reasons.push('stat-fingerprint-missing');
    }
    if (previous.staleness !== undefined && previous.staleness !== 'fresh') {
      mode = 'full';
      reasons.push(`previous-${previous.staleness}`);
    }
    if (
      previous.staleness === 'stale' &&
      previous.warnings.some((w) => w.message === 'surface-mismatch')
    ) {
      mode = 'full';
      reasons.push('surface-mismatch');
    }
  }

  const forced = new Set<string>();
  for (const glob of input.forcedGlobs ?? []) {
    let matched = false;
    for (const file of input.currentFiles) {
      if (matchFileGlob(file.path, glob)) {
        forced.add(file.path);
        matched = true;
      }
    }
    if (!matched) reasons.push(`glob-no-match:${glob}`);
  }
  const forcedModified: FileChange[] = [...forced]
    .filter(
      (filePath) => !files.some((entry) => entry.path === filePath && entry.kind === 'modified'),
    )
    .map((filePath) => ({ kind: 'modified' as const, path: filePath }));
  const allFiles = [...files, ...forcedModified].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  if (mode !== 'full') {
    if (allFiles.length > 0) {
      mode = 'incremental';
      reasons.push('file-content');
    } else {
      mode = 'fresh';
    }
  }
  if (input.forceFull === true && mode !== 'fresh') {
    mode = 'full';
    reasons.push('rebuild-affected');
  }
  const counts = {
    added: allFiles.filter((entry) => entry.kind === 'added').length,
    modified: allFiles.filter((entry) => entry.kind === 'modified').length,
    deleted: allFiles.filter((entry) => entry.kind === 'deleted').length,
    renamed: allFiles.filter((entry) => entry.kind === 'renamed').length,
    total: allFiles.length,
  };
  const seed = allFiles.map((entry) => entry.path);
  return {
    rootId: input.rootId,
    mode,
    reasons: [...new Set(reasons)].sort(),
    files: allFiles,
    counts,
    invalidatedFiles: seed,
    invalidatedTruncated: false,
    previousBuildId: previous?.buildId ?? null,
  };
}

/**
 * Convenience wrapper used by `update`: reads the previous committed files and
 * computes the reverse closure for evidence.
 */
export function planRootChange(input: RootChangeInput, projectRoot: string): RootChangePlan {
  const read =
    input.previousManifest === null ? null : readCommittedFiles(projectRoot, input.rootId);
  const plan = classifyRootChanges(input, read?.files ?? null);
  if (plan.mode !== 'fresh' && read !== null) {
    const changed = plan.files.map((entry) => entry.path);
    const closure = computeInvalidatedClosure(projectRoot, input.rootId, changed);
    plan.invalidatedFiles = closure.files;
    plan.invalidatedTruncated = closure.truncated;
  }
  return plan;
}
