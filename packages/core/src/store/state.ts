import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';
import type { StalenessState } from '../model.js';
import { rootDirectory, type RootManifest } from './manifest.js';

/**
 * Index state machine (docs/12-indexing.md 12.4).
 *
 * Durable states live in `manifest.staleness` (`fresh`/`stale`/`failed`).
 * `dirty` is derived at query time from the current content hash.
 * `indexing` is the only ephemeral state; it is persisted in
 * `.nexus/roots/<rootId>/indexing.json` so another process can see an
 * in-flight build and crash leftovers can be detected.
 */
export type IndexState = StalenessState;

export const STATE_NAMES: readonly IndexState[] = [
  'fresh',
  'dirty',
  'indexing',
  'stale',
  'failed',
] as const;

/**
 * The only allowed transitions (docs/12-indexing.md 12.4.2). Anything outside
 * this table is an implementation defect and `doctor` must report it.
 * `任意 -> failed` is allowed for integrity/manifest failures.
 */
export const STATE_TRANSITIONS: Readonly<Record<IndexState, readonly IndexState[]>> = {
  fresh: ['dirty', 'indexing', 'failed'],
  dirty: ['indexing', 'fresh', 'failed'],
  indexing: ['fresh', 'stale', 'failed'],
  stale: ['indexing', 'fresh', 'failed'],
  failed: ['indexing', 'failed'],
};

export function isTransitionAllowed(from: IndexState, to: IndexState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IndexState, to: IndexState): void {
  if (!isTransitionAllowed(from, to)) {
    throw nexusError('E23', 'illegal index state transition', {
      reason: `${from} -> ${to} is not in docs/12-indexing.md 12.4.2`,
      suggestion: 'Fix the state derivation; do not add transitions without a spec revision.',
      evidence: { from, to },
    });
  }
}

export interface IndexingMarker {
  rootId: string;
  pid: number;
  startedAt: string;
  phase: string;
}

export function indexingMarkerPath(projectRoot: string, rootId: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'indexing.json');
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

export function readIndexingMarker(projectRoot: string, rootId: string): IndexingMarker | null {
  const filePath = indexingMarkerPath(projectRoot, rootId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<IndexingMarker>;
    if (
      typeof parsed.rootId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      rootId: parsed.rootId,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      phase: typeof parsed.phase === 'string' ? parsed.phase : 'unknown',
    };
  } catch {
    return null;
  }
}

export function beginIndexing(
  projectRoot: string,
  rootId: string,
  phase = 'starting',
): IndexingMarker {
  const marker: IndexingMarker = {
    rootId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    phase,
  };
  writeAtomicJson(indexingMarkerPath(projectRoot, rootId), marker);
  return marker;
}

export function updateIndexingPhase(projectRoot: string, rootId: string, phase: string): void {
  const existing = readIndexingMarker(projectRoot, rootId);
  writeAtomicJson(indexingMarkerPath(projectRoot, rootId), {
    rootId,
    pid: existing?.pid ?? process.pid,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    phase,
  });
}

export function endIndexing(projectRoot: string, rootId: string): void {
  try {
    fs.rmSync(indexingMarkerPath(projectRoot, rootId), { force: true });
  } catch {
    // The marker is advisory; a leftover is cleaned by recovery.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    // EPERM means the process exists but we cannot signal it.
    return code === 'EPERM';
  }
}

/**
 * Crash leftovers: a marker whose process is gone, or one older than the
 * stale threshold, is removed. Returns the removed marker (for diagnosis).
 */
export function clearStaleIndexingMarker(
  projectRoot: string,
  rootId: string,
  staleAfterMs = 30 * 60 * 1000,
): IndexingMarker | null {
  const marker = readIndexingMarker(projectRoot, rootId);
  if (marker === null) return null;
  const age = Date.now() - Date.parse(marker.startedAt);
  const alive = isProcessAlive(marker.pid);
  if (alive && Number.isFinite(age) && age < staleAfterMs) return null;
  endIndexing(projectRoot, rootId);
  return marker;
}

export interface StateDerivationInput {
  manifest: RootManifest | null;
  manifestExists: boolean;
  /** Current content hash of the root (null when it cannot be computed). */
  currentFilesHash: string | null;
  currentConfigHash: string | null;
  currentTsconfigHash: string | null;
  currentAnalyzerVersion: unknown;
  marker: IndexingMarker | null;
  surfaceMatchesManifest: boolean | null;
}

export interface StateDerivation {
  state: IndexState;
  reasons: string[];
}

/**
 * Single source of truth for `staleness` (docs/12-indexing.md 12.4.3 rule 3).
 * Query, status, impact and audit commands must call this instead of inferring
 * their own value.
 */
export function deriveRootState(input: StateDerivationInput): StateDerivation {
  const reasons: string[] = [];
  const marker = input.marker;
  if (marker !== null && isProcessAlive(marker.pid)) {
    return { state: 'indexing', reasons: [`indexing:${marker.phase}`] };
  }
  if (!input.manifestExists || input.manifest === null) {
    return { state: 'failed', reasons: ['manifest-missing'] };
  }
  const manifest = input.manifest;
  if (manifest.state === 'failed' || manifest.staleness === 'failed') {
    return { state: 'failed', reasons: ['build-failed'] };
  }
  if (marker !== null) reasons.push('stale-indexing-marker');
  if (manifest.recovered === true) reasons.push('recovered-manifest');
  if (manifest.lastFailureAt !== null && manifest.lastFailureAt !== undefined) {
    if (manifest.lastFailureAt > (manifest.lastSuccessAt ?? '')) {
      reasons.push(`last-failure:${manifest.lastFailureCode ?? manifest.lastFailureAt}`);
    }
  }
  if (manifest.schemaVersion !== undefined) {
    // Schema mismatch is reported by ensureSchema; the state view only marks it.
  }
  if (input.currentAnalyzerVersion !== undefined) {
    const expected = JSON.stringify(input.currentAnalyzerVersion);
    const actual = JSON.stringify(manifest.analyzerVersion ?? null);
    if (expected !== actual) reasons.push('analyzer-changed');
  }
  if (
    input.currentConfigHash !== null &&
    manifest.configHash !== '' &&
    input.currentConfigHash !== manifest.configHash
  ) {
    reasons.push('config-changed');
  }
  if (
    input.currentTsconfigHash !== null &&
    manifest.tsconfigHash !== undefined &&
    manifest.tsconfigHash !== '' &&
    input.currentTsconfigHash !== manifest.tsconfigHash
  ) {
    reasons.push('tsconfig-changed');
  }
  if (input.surfaceMatchesManifest === false) reasons.push('surface-mismatch');
  if (
    input.currentFilesHash !== null &&
    manifest.filesHash !== '' &&
    input.currentFilesHash !== manifest.filesHash
  ) {
    reasons.push('files-changed');
  }
  const hard = reasons.filter(
    (reason) =>
      reason === 'build-failed' ||
      reason === 'manifest-missing' ||
      reason === 'surface-mismatch' ||
      reason === 'recovered-manifest' ||
      reason === 'analyzer-changed' ||
      reason === 'config-changed' ||
      reason === 'tsconfig-changed' ||
      reason.startsWith('last-failure') ||
      reason === 'stale-indexing-marker',
  );
  if (hard.length > 0) return { state: 'stale', reasons };
  if (reasons.includes('files-changed')) return { state: 'dirty', reasons };
  return { state: 'fresh', reasons };
}
