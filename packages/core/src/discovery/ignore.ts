import path from 'node:path';

import type { IgnoreConfig } from '../config/schema.js';
import { toPosix } from '../util/paths.js';

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.+|()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += '$';
  return new RegExp(source);
}

interface CompiledPattern {
  raw: string;
  regex: RegExp;
  hasSlash: boolean;
}

function compile(patterns: readonly string[]): CompiledPattern[] {
  return patterns.map((raw) => ({
    raw,
    regex: globToRegExp(raw.replaceAll('\\', '/')),
    hasSlash: raw.includes('/'),
  }));
}

/**
 * Unified ignore rules for build/update/watch (docs/12-indexing.md 12.5).
 * `include` explicitly re-includes a path even if it matches the baseline.
 * No recursion: callers drive the directory walk.
 */
export class IgnoreMatcher {
  private readonly dirs: CompiledPattern[];
  private readonly files: CompiledPattern[];
  private readonly globs: CompiledPattern[];
  private readonly includes: CompiledPattern[];

  constructor(config: IgnoreConfig) {
    this.dirs = compile(config.dirs);
    this.files = compile(config.files);
    this.globs = compile(config.globs);
    this.includes = compile(config.include);
  }

  matchesInclude(relativePath: string): boolean {
    const normalized = relativePath.replaceAll('\\', '/');
    for (const pattern of this.includes) {
      if (
        pattern.hasSlash
          ? pattern.regex.test(normalized)
          : pattern.regex.test(path.posix.basename(normalized))
      ) {
        return true;
      }
    }
    return false;
  }

  /** True when a directory may not be descended into. */
  isDirectoryIgnored(relativeDir: string): boolean {
    const normalized = toPosix(relativeDir);
    if (normalized === '' || normalized === '.') return false;
    if (this.matchesInclude(normalized)) return false;
    const base = path.posix.basename(normalized);
    for (const pattern of this.dirs) {
      if (pattern.hasSlash ? pattern.regex.test(normalized) : pattern.raw === base) return true;
    }
    for (const pattern of this.globs) {
      if (pattern.regex.test(normalized)) return true;
    }
    return false;
  }

  isFileIgnored(relativeFile: string): boolean {
    const normalized = toPosix(relativeFile);
    if (this.matchesInclude(normalized)) return false;
    const base = path.posix.basename(normalized);
    for (const pattern of this.files) {
      if (pattern.hasSlash ? pattern.regex.test(normalized) : pattern.regex.test(base)) return true;
    }
    for (const pattern of this.globs) {
      if (pattern.regex.test(normalized)) return true;
    }
    // A file inside an ignored directory is ignored too; tsconfig file lists
    // bypass the directory walk, so this check cannot rely on pruning.
    const segments = normalized.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      if (this.isDirectoryIgnored(prefix)) return true;
    }
    return false;
  }

  /** Whether an include rule could match below an ignored directory. */
  mayContainInclude(relativeDir: string): boolean {
    const normalized = toPosix(relativeDir);
    for (const pattern of this.includes) {
      const wildcardIndex = pattern.raw.search(/[*?]/);
      const literal = wildcardIndex === -1 ? pattern.raw : pattern.raw.slice(0, wildcardIndex);
      const prefix = literal.replace(/\/+$/, '');
      if (prefix === '' || prefix.startsWith(normalized) || normalized.startsWith(prefix))
        return true;
    }
    return false;
  }
}
