import fs from 'node:fs';
import path from 'node:path';

import { isInside } from '../util/paths.js';

export interface PackageExportTarget {
  /** Package subpath, e.g. "." or "./utils". */
  subpath: string;
  /** Root-relative POSIX target file that exists in the scan. */
  file: string;
  /** Condition path, e.g. null, "import", "types", "import.types". */
  condition: string | null;
}

export interface PackageExportsParse {
  targets: PackageExportTarget[];
  warnings: string[];
  packageName: string | null;
  packageVersion: string | null;
  hasExports: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTarget(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function hasWildcard(value: string): boolean {
  return value.includes('*');
}

/**
 * Resolve one `exports` target against the scanned file set. Runtime targets
 * often point at build output (*.js); we only accept a target that is already
 * in the index, plus the conventional `.js` -> `.ts`/`.tsx` fallback. Anything
 * else is reported as a warning instead of being guessed.
 */
function resolveTargetFile(
  rootAbs: string,
  target: string,
  files: ReadonlySet<string>,
): string | null {
  const candidates = [target];
  if (target.endsWith('.js')) {
    candidates.push(`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`);
  } else if (target.endsWith('.mjs') || target.endsWith('.cjs')) {
    const base = target.slice(0, target.lastIndexOf('.'));
    candidates.push(`${base}.ts`, `${base}.tsx`);
  }
  for (const candidate of candidates) {
    const absolute = path.resolve(rootAbs, candidate);
    if (!isInside(rootAbs, absolute)) continue;
    const relative = path.relative(rootAbs, absolute).replaceAll('\\', '/');
    if (files.has(relative)) return relative;
  }
  return null;
}

interface RawTarget {
  condition: string | null;
  target: string;
}

function flattenTarget(value: unknown, conditionPath: string, output: RawTarget[]): void {
  if (typeof value === 'string') {
    output.push({ condition: conditionPath === '' ? null : conditionPath, target: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const next = conditionPath === '' ? `[${index}]` : `${conditionPath}[${index}]`;
      flattenTarget(entry, next, output);
    });
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  for (const key of Object.keys(record).sort()) {
    const next = conditionPath === '' ? key : `${conditionPath}.${key}`;
    flattenTarget(record[key], next, output);
  }
}

export function parsePackageExports(
  rootAbs: string,
  rootRelativeFiles: readonly string[],
): PackageExportsParse {
  const warnings: string[] = [];
  const files = new Set(rootRelativeFiles);
  const packageFile = path.join(rootAbs, 'package.json');
  if (!fs.existsSync(packageFile)) {
    return {
      targets: [],
      warnings: [],
      packageName: null,
      packageVersion: null,
      hasExports: false,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as unknown;
  } catch (error) {
    return {
      targets: [],
      warnings: [
        `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      packageName: null,
      packageVersion: null,
      hasExports: false,
    };
  }
  const record = asRecord(raw);
  if (record === null) {
    return {
      targets: [],
      warnings: ['package.json is not an object'],
      packageName: null,
      packageVersion: null,
      hasExports: false,
    };
  }
  const packageName = typeof record.name === 'string' ? record.name : null;
  const packageVersion = typeof record.version === 'string' ? record.version : null;
  const exportsValue = record.exports;
  if (exportsValue === undefined || exportsValue === null) {
    return { targets: [], warnings, packageName, packageVersion, hasExports: false };
  }

  const subpaths: Array<{ subpath: string; value: unknown }> = [];
  const exportsRecord = asRecord(exportsValue);
  if (exportsRecord === null || Array.isArray(exportsValue)) {
    subpaths.push({ subpath: '.', value: exportsValue });
  } else {
    const keys = Object.keys(exportsRecord);
    const isSubpathMap = keys.some((key) => key.startsWith('.'));
    if (isSubpathMap) {
      for (const key of keys.sort()) {
        if (!key.startsWith('.')) {
          warnings.push(`exports mixes subpath and condition keys: ${key}`);
          continue;
        }
        subpaths.push({ subpath: key, value: exportsRecord[key] });
      }
    } else {
      subpaths.push({ subpath: '.', value: exportsRecord });
    }
  }

  const targets: PackageExportTarget[] = [];
  const seen = new Set<string>();
  for (const { subpath, value } of subpaths) {
    const rawTargets: RawTarget[] = [];
    flattenTarget(value, '', rawTargets);
    for (const rawTarget of rawTargets) {
      const normalized = normalizeTarget(rawTarget.target);
      if (hasWildcard(normalized) || hasWildcard(subpath)) {
        const pattern = normalized;
        const starIndex = pattern.indexOf('*');
        const prefix = starIndex === -1 ? pattern : pattern.slice(0, starIndex);
        const suffix = starIndex === -1 ? '' : pattern.slice(starIndex + 1);
        for (const file of files) {
          if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
          const end = suffix === '' ? file.length : file.length - suffix.length;
          const star = file.slice(prefix.length, end);
          if (star === '') continue;
          const concreteSubpath = subpath.replace('*', star);
          const key = `${concreteSubpath}\u0000${rawTarget.condition ?? ''}\u0000${file}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({
            subpath: concreteSubpath,
            file,
            condition: rawTarget.condition,
          });
        }
        continue;
      }
      const file = resolveTargetFile(rootAbs, normalized, files);
      if (file === null) {
        warnings.push(`exports target is not indexed: ${subpath} -> ${rawTarget.target}`);
        continue;
      }
      const key = `${subpath}\u0000${rawTarget.condition ?? ''}\u0000${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ subpath, file, condition: rawTarget.condition });
    }
  }
  return { targets, warnings, packageName, packageVersion, hasExports: true };
}
