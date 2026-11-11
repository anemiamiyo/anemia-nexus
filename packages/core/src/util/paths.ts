import path from 'node:path';

/** Project-relative paths always use POSIX separators (docs/05-data-model.md 5.4). */
export function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

export function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * True when `child` is the same as `parent` or inside it. Comparison is
 * case-insensitive on Windows, where the filesystem is case-insensitive.
 */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

export function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

export function relativePosix(parent: string, child: string): string {
  return toPosix(path.relative(parent, child));
}

/** Lexicographic byte-ish ordering of relative paths, locale independent. */
export function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortByPath<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => comparePaths(key(a), key(b)));
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]?.toUpperCase() + value.slice(1);
}
