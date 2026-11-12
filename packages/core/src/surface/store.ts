import fs from 'node:fs';
import path from 'node:path';

import { rootDirectory, readManifest, type RootManifest } from '../store/manifest.js';
import type { SurfaceBaseline, SurfaceRootSnapshot } from './types.js';

export function surfacePath(projectRoot: string, rootId: string): string {
  return path.join(rootDirectory(projectRoot, rootId), 'surface.json');
}

export function baselinePath(projectRoot: string, relative: string): string {
  return path.resolve(projectRoot, relative);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, payload, 'utf8');
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

export function writeSurface(projectRoot: string, surface: SurfaceRootSnapshot): void {
  writeJsonAtomic(surfacePath(projectRoot, surface.rootId), surface);
}

export function writeBaseline(filePath: string, baseline: SurfaceBaseline): void {
  writeJsonAtomic(filePath, baseline);
}

export interface SurfaceReadResult {
  surface: SurfaceRootSnapshot | null;
  error: string | null;
  matchesManifest: boolean;
}

export function readSurface(projectRoot: string, rootId: string): SurfaceReadResult {
  const filePath = surfacePath(projectRoot, rootId);
  if (!fs.existsSync(filePath)) {
    return { surface: null, error: 'surface.json not found', matchesManifest: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    return {
      surface: null,
      error: error instanceof Error ? error.message : String(error),
      matchesManifest: false,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { surface: null, error: 'surface.json is not an object', matchesManifest: false };
  }
  const candidate = parsed as Partial<SurfaceRootSnapshot>;
  if (
    typeof candidate.rootId !== 'string' ||
    typeof candidate.surfaceHash !== 'string' ||
    !Array.isArray(candidate.entries) ||
    !Array.isArray(candidate.internal)
  ) {
    return {
      surface: null,
      error: 'surface.json is missing required fields',
      matchesManifest: false,
    };
  }
  const manifest = readManifest(
    path.join(rootDirectory(projectRoot, rootId), 'manifest.json'),
  ).manifest;
  const matchesManifest =
    manifest !== null &&
    manifest.buildId === candidate.buildId &&
    manifest.buildFingerprint === candidate.buildFingerprint;
  return { surface: candidate as SurfaceRootSnapshot, error: null, matchesManifest };
}

export function readSurfaceForManifest(
  projectRoot: string,
  manifest: RootManifest,
): { surface: SurfaceRootSnapshot | null; error: string | null } {
  const read = readSurface(projectRoot, manifest.rootId);
  if (read.surface === null) return { surface: null, error: read.error };
  if (!read.matchesManifest) {
    return {
      surface: null,
      error: 'surface.json buildId/fingerprint does not match manifest',
    };
  }
  return { surface: read.surface, error: null };
}

export function readBaseline(filePath: string): {
  baseline: SurfaceBaseline | null;
  error: string | null;
} {
  if (!fs.existsSync(filePath)) return { baseline: null, error: 'baseline file not found' };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { baseline: null, error: 'baseline is not an object' };
    }
    const candidate = parsed as Partial<SurfaceBaseline>;
    if (
      candidate.baselineVersion !== 1 ||
      typeof candidate.surfaceHash !== 'string' ||
      typeof candidate.roots !== 'object' ||
      candidate.roots === null
    ) {
      return { baseline: null, error: 'baseline is missing required fields' };
    }
    return { baseline: candidate as SurfaceBaseline, error: null };
  } catch (error) {
    return {
      baseline: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function baselineRelativePath(projectRoot: string, absolute: string): string {
  return path.relative(projectRoot, absolute).replaceAll('\\', '/');
}
