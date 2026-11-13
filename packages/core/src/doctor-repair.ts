import fs from 'node:fs';
import path from 'node:path';

import { discoverRoots, type RootCandidate } from './discovery/roots.js';
import { loadConfig } from './config/load.js';
import { resolveRootConfig } from './config/merge.js';
import { computeRootSetHash } from './index/fingerprint.js';
import { recoverWorkspace, type WorkspaceRecoveryResult } from './store/recovery.js';
import { manifestPath, readManifest } from './store/manifest.js';
import { reconcileWorkspace } from './store/workspace.js';
import { runDoctor, type DoctorReport } from './doctor.js';

export interface RepairAction {
  id: string;
  status: 'repaired' | 'skipped' | 'failed';
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface RepairReport {
  actions: RepairAction[];
  recovery: WorkspaceRecoveryResult;
  workspace: { repaired: boolean; reasons: string[] };
  removedOrphans: string[];
  doctor: DoctorReport;
  exitCode: 0 | 1 | 2;
}

export interface DoctorRepairOptions {
  projectRoot: string;
  trustConfig?: boolean;
}

function clearTmp(projectRoot: string): RepairAction {
  const tmpDir = path.join(projectRoot, '.nexus', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    return { id: 'tmp-clean', status: 'skipped', detail: '.nexus/tmp does not exist' };
  }
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
    }
    return {
      id: 'tmp-clean',
      status: 'repaired',
      detail: `removed ${entries.length} leftover entry(ies)`,
      evidence: { removed: entries },
    };
  } catch (error) {
    return {
      id: 'tmp-clean',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function removeOrphanRoots(
  projectRoot: string,
  expected: ReadonlySet<string>,
): { actions: RepairAction[]; removed: string[] } {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(rootsDir) || expected.size === 0) {
    return { actions: [], removed: [] };
  }
  const actions: RepairAction[] = [];
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootsDir, { withFileTypes: true });
  } catch (error) {
    return {
      actions: [
        {
          id: 'orphan-roots',
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      removed: [],
    };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.lock')) continue;
    if (expected.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(rootsDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
      actions.push({
        id: `orphan:${entry.name}`,
        status: 'repaired',
        detail: 'removed a root directory that is no longer part of the workspace',
      });
    } catch (error) {
      actions.push({
        id: `orphan:${entry.name}`,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { actions, removed };
}

/**
 * `doctor --repair` (11.3 / 12.3.3 / 12.4). Only Nexus-owned derived data is
 * touched: recovery, manifest rewrite from the authoritative DB, pending/tmp
 * cleanup, workspace.json rebuild and orphan root directories. Source files,
 * configuration and nexus.baseline.json are never modified, and a corrupt
 * committed DB is reported instead of being deleted.
 */
export async function runDoctorRepair(options: DoctorRepairOptions): Promise<RepairReport> {
  const projectRoot = path.resolve(options.projectRoot);
  const actions: RepairAction[] = [];
  const tmp = clearTmp(projectRoot);
  if (tmp.status !== 'skipped') actions.push(tmp);

  // 1. Resolve the configured roots first so orphan directories can be removed
  //    before recovery opens their (possibly corrupt) index databases.
  let expected: RootCandidate[] = [];
  let loadedConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    loadedConfig = await loadConfig({
      projectRoot,
      trustConfig: options.trustConfig === true,
    });
    if (loadedConfig.config === null) {
      actions.push({
        id: 'config',
        status: 'skipped',
        detail: 'configuration is missing; configured roots cannot be resolved',
      });
    } else {
      const discovery = discoverRoots({ projectRoot });
      const selected = new Set(loadedConfig.config.workspaces.roots);
      expected = discovery.candidates.filter(
        (candidate) => selected.size === 0 || selected.has(candidate.rootId),
      );
    }
  } catch (error) {
    actions.push({
      id: 'config',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const orphanResult = removeOrphanRoots(projectRoot, new Set(expected.map((root) => root.rootId)));
  actions.push(...orphanResult.actions);
  if (orphanResult.actions.length === 0) {
    actions.push({ id: 'orphan-roots', status: 'skipped', detail: 'no orphan root directory' });
  }

  // 2. Recovery: DB is authoritative; manifest/pending/surface/indexing marker
  //    are repaired from the committed build record.
  const recovery = recoverWorkspace(projectRoot, { repair: true, integrityCheck: true });
  actions.push({
    id: 'recovery',
    status: recovery.repaired.length > 0 ? 'repaired' : 'skipped',
    detail:
      recovery.repaired.length === 0 && recovery.invalid.length === 0
        ? 'nothing to recover'
        : `repaired: ${recovery.repaired.join(', ') || '-'}; invalid: ${recovery.invalid.join(', ') || '-'}`,
    evidence: { repaired: recovery.repaired, invalid: recovery.invalid },
  });

  // 3. workspace.json is derived from the configuration and the (now repaired)
  //    manifests.
  let workspace: RepairReport['workspace'] = { repaired: false, reasons: [] };
  if (loadedConfig === null || loadedConfig.config === null) {
    actions.push({
      id: 'workspace',
      status: 'skipped',
      detail: 'configuration is missing; workspace.json cannot be rebuilt',
    });
  } else {
    try {
      const config = loadedConfig.config;
      const effective = expected.map((root) =>
        resolveRootConfig(config, root.rootId, config.roots[root.rootId]),
      );
      const rootSetHash = computeRootSetHash(
        expected.map((root, index) => ({
          rootId: root.rootId,
          rootPath: root.rootPath,
          packageName: root.packageName,
          configHash: effective[index]?.configHash ?? '',
        })),
      );
      const manifests = new Map(
        expected.map((root) => [
          root.rootId,
          readManifest(manifestPath(projectRoot, root.rootId)).manifest,
        ]),
      );
      const check = reconcileWorkspace({
        projectRoot,
        roots: expected,
        effective,
        rootSetHash,
        manifests,
      });
      workspace = { repaired: check.repaired, reasons: check.reasons };
      actions.push({
        id: 'workspace',
        status: check.repaired ? 'repaired' : 'skipped',
        detail: check.repaired
          ? `rebuilt workspace.json (${check.reasons.join(', ')})`
          : 'workspace.json already matches the configuration',
        evidence: { reasons: check.reasons },
      });
    } catch (error) {
      actions.push({
        id: 'workspace',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (recovery.invalid.length > 0) {
    actions.push({
      id: 'invalid-roots',
      status: 'failed',
      detail: `invalid roots are kept for inspection: ${recovery.invalid.join(', ')}; delete and rebuild them explicitly`,
      evidence: { invalid: recovery.invalid },
    });
  }

  const doctor = await runDoctor({
    projectRoot,
    trustConfig: options.trustConfig === true,
  });
  const failed = actions.some((action) => action.status === 'failed');
  return {
    actions,
    recovery,
    workspace,
    removedOrphans: orphanResult.removed,
    doctor,
    exitCode: failed || doctor.exitCode === 1 ? 1 : doctor.exitCode === 2 ? 2 : 0,
  };
}
