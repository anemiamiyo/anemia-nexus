import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { configJsonSchema } from './config/json-schema.js';
import { loadConfig, type LoadedConfig } from './config/load.js';
import { resolveRootConfig } from './config/merge.js';
import {
  BUILTIN_IGNORE_DIRS,
  BUILTIN_IGNORE_FILES,
  BUILTIN_IGNORE_GLOBS,
} from './config/builtin.js';
import { nexusError } from './errors.js';
import { statusReport } from './status.js';
import {
  integrityCheck,
  latestCommittedBuild,
  openDatabase,
  readSchemaVersion,
  requiredIndexesPresent,
} from './store/db.js';
import { databasePath, manifestPath, readManifest, rootDirectory } from './store/manifest.js';
import { SCHEMA_VERSION } from './store/schema.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  suggestion: string | null;
  evidence: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
  exitCode: 0 | 1 | 2;
  schema: Record<string, unknown> | null;
  roots: Array<{ rootId: string; rootPath: string }>;
}

export interface DoctorOptions {
  projectRoot: string;
  trustConfig?: boolean;
  schemaOnly?: boolean;
}

function nodeVersionOk(version: string): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major > 22) return true;
  if (major < 22) return false;
  return minor >= 16;
}

function check(
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  options: { suggestion?: string; evidence?: Record<string, unknown> } = {},
): DoctorCheck {
  return {
    id,
    title,
    status,
    detail,
    suggestion: options.suggestion ?? null,
    evidence: options.evidence ?? {},
  };
}

/**
 * Base doctor checks for Phase 01 (checklist I07). `--repair`, `--mcp` and
 * `--dump-vue-map` are not provided and must be rejected by the CLI, not
 * silently treated as success.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  if (options.schemaOnly === true) {
    return {
      checks: [],
      summary: { pass: 0, warn: 0, fail: 0 },
      exitCode: 0,
      schema: configJsonSchema(),
      roots: [],
    };
  }

  const projectRoot = path.resolve(options.projectRoot);
  const checks: DoctorCheck[] = [];

  checks.push(
    nodeVersionOk(process.versions.node)
      ? check('node-version', 'Node.js version', 'pass', process.versions.node)
      : check(
          'node-version',
          'Node.js version',
          'fail',
          `${process.versions.node} is below 22.16.0`,
          {
            suggestion: 'Upgrade to Node >= 22.16.0.',
          },
        ),
  );

  const tmpDir = path.join(projectRoot, '.nexus', 'tmp');
  const tmpEntries = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  checks.push(
    tmpEntries.length === 0
      ? check('tmp-clean', '.nexus/tmp is empty', 'pass', 'no build leftovers')
      : check('tmp-clean', '.nexus/tmp is empty', 'warn', `${tmpEntries.length} leftover entries`, {
          suggestion: 'Rerun the build; startup and shutdown clear .nexus/tmp.',
        }),
  );

  if (!fs.existsSync(path.join(projectRoot, '.nexus'))) {
    checks.push(
      check('initialized', '.nexus directory', 'fail', '.nexus/ does not exist', {
        suggestion: 'Run `nex init --yes` then `nex build`.',
      }),
    );
    return finish(checks, [], null);
  }

  let loaded: LoadedConfig | null = null;
  try {
    loaded = await loadConfig({ projectRoot, trustConfig: options.trustConfig === true });
    if (loaded.config === null) {
      checks.push(
        check('config', 'configuration', 'fail', 'no configuration found', {
          suggestion: 'Run `nex init --yes`.',
        }),
      );
    } else {
      checks.push(
        check(
          'config',
          'configuration',
          'pass',
          `${loaded.sourceKind} configuration validated (${loaded.authorization})`,
          { evidence: { configVersion: loaded.config.configVersion } },
        ),
      );
      if (loaded.sourceKind === 'ts') {
        checks.push(
          check(
            'config-ts',
            'TypeScript configuration',
            'warn',
            'executable configuration was trusted',
            {
              suggestion: 'Prefer JSON configuration unless constants are required.',
            },
          ),
        );
      }
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'E17';
    checks.push(
      check(
        'config',
        'configuration',
        'fail',
        error instanceof Error ? error.message : String(error),
        {
          suggestion:
            code === 'E18'
              ? 'Trust the TS config with --trust-config or switch to JSON.'
              : 'Fix the reported configuration fields.',
          evidence: { code },
        },
      ),
    );
  }

  const workspaceFile = path.join(projectRoot, '.nexus', 'workspace.json');
  checks.push(
    fs.existsSync(workspaceFile)
      ? check('workspace-json', 'workspace.json', 'pass', 'derived workspace file present')
      : check(
          'workspace-json',
          'workspace.json',
          'warn',
          'workspace.json is missing; it is derived and rebuildable',
          {
            suggestion: 'Run `nex build` to regenerate it.',
          },
        ),
  );

  const status = await statusReport({
    projectRoot,
    self: {
      serverVersion: '',
      packageName: '',
      binaryPath: '',
      projectRoot: '.',
      nodeVersion: process.versions.node,
    },
  });
  const roots: Array<{ rootId: string; rootPath: string }> = [];

  for (const root of status.roots) {
    roots.push({ rootId: root.rootId, rootPath: root.rootPath });
    const manifestFile = manifestPath(projectRoot, root.rootId);
    const manifestRead = readManifest(manifestFile);
    if (manifestRead.manifest === null) {
      checks.push(
        check(
          `manifest:${root.rootId}`,
          `manifest (${root.rootId})`,
          'fail',
          manifestRead.error ?? 'unreadable',
          {
            suggestion: 'Rebuild the root.',
          },
        ),
      );
      continue;
    }
    const manifest = manifestRead.manifest;
    checks.push(
      check(
        `manifest:${root.rootId}`,
        `manifest (${root.rootId})`,
        'pass',
        manifest.buildFingerprint.slice(0, 12),
        {
          evidence: { buildId: manifest.buildId, filesHash: manifest.filesHash },
        },
      ),
    );

    const dbPath = databasePath(projectRoot, root.rootId);
    if (!fs.existsSync(dbPath)) {
      checks.push(
        check(`db:${root.rootId}`, `database (${root.rootId})`, 'fail', 'index.db is missing', {
          suggestion: 'Rebuild the root.',
        }),
      );
      continue;
    }
    let db: DatabaseSync;
    try {
      db = openDatabase(dbPath, { readOnly: true });
    } catch (error) {
      checks.push(
        check(
          `db:${root.rootId}`,
          `database (${root.rootId})`,
          'fail',
          error instanceof Error ? error.message : String(error),
          {
            suggestion:
              'Run `nex doctor` after deleting the corrupt index; data cannot be repaired.',
          },
        ),
      );
      continue;
    }
    try {
      const integrity = integrityCheck(db);
      checks.push(
        integrity.ok
          ? check(
              `integrity:${root.rootId}`,
              `integrity (${root.rootId})`,
              'pass',
              'PRAGMA integrity_check ok',
            )
          : check(
              `integrity:${root.rootId}`,
              `integrity (${root.rootId})`,
              'fail',
              integrity.errors.slice(0, 3).join('; '),
              {
                suggestion: 'Delete index.db and rebuild; do not attempt data rescue.',
              },
            ),
      );
      const version = readSchemaVersion(db);
      checks.push(
        version === SCHEMA_VERSION
          ? check(
              `schema:${root.rootId}`,
              `schema version (${root.rootId})`,
              'pass',
              String(version),
            )
          : check(
              `schema:${root.rootId}`,
              `schema version (${root.rootId})`,
              'fail',
              `expected ${SCHEMA_VERSION}, found ${String(version)}`,
              {
                suggestion: 'Delete the root index and rebuild; migrations are not provided.',
              },
            ),
      );
      const indexes = requiredIndexesPresent(db);
      checks.push(
        indexes.ok
          ? check(
              `indexes:${root.rootId}`,
              `required indexes (${root.rootId})`,
              'pass',
              'all present',
            )
          : check(
              `indexes:${root.rootId}`,
              `required indexes (${root.rootId})`,
              'fail',
              indexes.missing.join('; '),
              {
                suggestion: 'Rebuild with the current schema.',
              },
            ),
      );
      const committed = latestCommittedBuild(db);
      if (committed === null) {
        checks.push(
          check(
            `committed:${root.rootId}`,
            `committed build (${root.rootId})`,
            'fail',
            'no committed build_record',
            {
              suggestion: 'Run `nex build`.',
            },
          ),
        );
      } else if (
        committed.buildId !== manifest.buildId ||
        committed.fingerprint !== manifest.buildFingerprint
      ) {
        checks.push(
          check(
            `committed:${root.rootId}`,
            `manifest/database consistency (${root.rootId})`,
            'warn',
            'manifest and DB committed build differ; DB is authoritative and the manifest can be rewritten',
            { suggestion: 'Rebuild the root to regenerate the manifest.' },
          ),
        );
      } else {
        checks.push(
          check(
            `committed:${root.rootId}`,
            `manifest/database consistency (${root.rootId})`,
            'pass',
            committed.buildId,
          ),
        );
      }
    } finally {
      db.close();
    }

    const lockPath = `${rootDirectory(projectRoot, root.rootId)}.lock`;
    if (fs.existsSync(lockPath)) {
      checks.push(
        check(`lock:${root.rootId}`, `lock (${root.rootId})`, 'warn', 'a lock file is present', {
          suggestion:
            'Another process may be building; stale locks are reclaimed after 10 minutes.',
        }),
      );
    }

    if (loaded?.config !== null && loaded?.config !== undefined) {
      const effective = resolveRootConfig(
        loaded.config,
        root.rootId,
        loaded.config.roots[root.rootId],
      );
      checks.push(
        check(
          `ignore:${root.rootId}`,
          `ignore rules (${root.rootId})`,
          'pass',
          'effective rules resolved',
          {
            evidence: {
              builtinDirs: [...BUILTIN_IGNORE_DIRS],
              builtinFiles: [...BUILTIN_IGNORE_FILES],
              builtinGlobs: [...BUILTIN_IGNORE_GLOBS],
              configDirs: effective.ignore.dirs.filter(
                (entry) => !BUILTIN_IGNORE_DIRS.includes(entry),
              ),
              include: effective.ignore.include,
            },
          },
        ),
      );
    }
  }

  return finish(checks, roots, null);
}

function finish(
  checks: DoctorCheck[],
  roots: Array<{ rootId: string; rootPath: string }>,
  schema: Record<string, unknown> | null,
): DoctorReport {
  const summary = {
    pass: checks.filter((entry) => entry.status === 'pass').length,
    warn: checks.filter((entry) => entry.status === 'warn').length,
    fail: checks.filter((entry) => entry.status === 'fail').length,
  };
  const exitCode = summary.fail > 0 ? 1 : summary.warn > 0 ? 2 : 0;
  return { checks, summary, exitCode, schema, roots };
}

export function unsupportedDoctorFlag(flag: string): never {
  throw nexusError('E24', `${flag} is not provided in Phase 01`, {
    reason: 'this diagnostic capability belongs to a later phase',
    suggestion:
      flag === '--repair'
        ? 'Phase 01 doctor is read-only; delete and rebuild the root index manually.'
        : 'Phase 07 provides the full doctor surface.',
  });
}
