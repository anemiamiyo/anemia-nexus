import fs from 'node:fs';
import path from 'node:path';

import type { EffectiveRootConfig } from '../config/merge.js';
import type { RootCandidate } from '../discovery/roots.js';
import type { RootManifest } from './manifest.js';

/**
 * `.nexus/workspace.json` is **derived data + cache**, never the authority
 * (docs/05-data-model.md 5.10.5). It can be deleted and rebuilt from the
 * configuration plus each root's manifest.
 */
export interface WorkspaceRootEntry {
  rootId: string;
  rootPath: string;
  packageName: string | null;
  tsconfig: string | null;
  configHash: string;
  buildFingerprint?: string | null;
  state?: 'ready' | 'stale' | 'failed';
  updatedAt?: string;
}

export interface WorkspaceSnapshot {
  version: 1;
  rootSetHash: string;
  roots: WorkspaceRootEntry[];
  updatedAt?: string;
}

export interface WorkspaceReadResult {
  workspace: WorkspaceSnapshot | null;
  error: string | null;
}

export function workspacePath(projectRoot: string): string {
  return path.join(projectRoot, '.nexus', 'workspace.json');
}

export function writeWorkspaceAtomic(projectRoot: string, snapshot: WorkspaceSnapshot): void {
  const filePath = workspacePath(projectRoot);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.workspace.json.${process.pid}.tmp`);
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(temporary, filePath);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // best effort cleanup
      }
      throw error;
    }
  }
}

export function readWorkspace(projectRoot: string): WorkspaceReadResult {
  const filePath = workspacePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { workspace: null, error: 'workspace.json not found' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WorkspaceSnapshot>;
    if (
      parsed.version !== 1 ||
      typeof parsed.rootSetHash !== 'string' ||
      !Array.isArray(parsed.roots)
    ) {
      return { workspace: null, error: 'workspace.json is missing required fields' };
    }
    return { workspace: parsed as WorkspaceSnapshot, error: null };
  } catch (error) {
    return {
      workspace: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildWorkspaceSnapshot(input: {
  roots: readonly RootCandidate[];
  effective: readonly EffectiveRootConfig[];
  rootSetHash: string;
  manifests: ReadonlyMap<string, RootManifest | null>;
}): WorkspaceSnapshot {
  const entries: WorkspaceRootEntry[] = input.roots.map((root, index) => {
    const effective = input.effective[index];
    const manifest = input.manifests.get(root.rootId) ?? null;
    return {
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      tsconfig: root.tsconfigRelativePath,
      configHash: effective?.configHash ?? '',
      buildFingerprint: manifest?.buildFingerprint ?? null,
      state: manifest?.state ?? 'stale',
      updatedAt: manifest?.lastSuccessAt ?? undefined,
    };
  });
  entries.sort((left, right) =>
    left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0,
  );
  return { version: 1, rootSetHash: input.rootSetHash, roots: entries };
}

export interface WorkspaceCheck {
  ok: boolean;
  repaired: boolean;
  reasons: string[];
}

/**
 * Validate `rootSetHash` against the authoritative sources; rebuild when they
 * disagree (docs/05-data-model.md 5.10.5). Returns whether a rebuild happened.
 */
export function reconcileWorkspace(input: {
  projectRoot: string;
  roots: readonly RootCandidate[];
  effective: readonly EffectiveRootConfig[];
  rootSetHash: string;
  manifests: ReadonlyMap<string, RootManifest | null>;
}): WorkspaceCheck {
  const reasons: string[] = [];
  const existing = readWorkspace(input.projectRoot).workspace;
  if (existing === null) reasons.push('workspace-missing');
  else if (existing.rootSetHash !== input.rootSetHash) reasons.push('root-set-changed');
  else if (existing.roots.length !== input.roots.length) reasons.push('root-count-changed');
  const expected = buildWorkspaceSnapshot(input);
  if (reasons.length === 0 && existing !== null) {
    const expectedIds = expected.roots.map((root) => root.rootId).join(',');
    const actualIds = existing.roots
      .map((root) => root.rootId)
      .sort()
      .join(',');
    if (expectedIds !== actualIds) reasons.push('root-ids-changed');
  }
  if (reasons.length === 0) return { ok: true, repaired: false, reasons: [] };
  writeWorkspaceAtomic(input.projectRoot, { ...expected, updatedAt: new Date().toISOString() });
  return { ok: true, repaired: true, reasons };
}
