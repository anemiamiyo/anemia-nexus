import fs from 'node:fs';
import path from 'node:path';

import { isSensitiveFile } from '../config/builtin.js';
import type { IgnoreMatcher } from './ignore.js';
import { isInside, toPosix } from '../util/paths.js';
import { contentHash } from '../util/hash.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const VUE_EXTENSION = '.vue';

export type FileLanguage = 'ts' | 'tsx' | 'vue' | 'css' | 'scss' | 'less';

export interface ScannedFile {
  /** Project-relative POSIX path. */
  path: string;
  absolutePath: string;
  sourceHash: string;
  size: number;
  /** Modification time used only for the cheap query-time freshness probe. */
  mtimeMs?: number;
  language: FileLanguage;
  /** Architecture module from explicit config; null when unassigned. */
  ownerModule?: string | null;
}

export interface ScanProblem {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: ScannedFile[];
  filesIgnored: number;
  ignoredDirs: number;
  filesSkippedBySize: number;
  filesFailed: ScanProblem[];
  outsideRoot: ScanProblem[];
}

export interface ScanOptions {
  projectRoot: string;
  rootPath: string;
  absoluteRoot: string;
  ignore: IgnoreMatcher;
  /** Absolute file names from a valid tsconfig; when absent a directory walk is used. */
  tsconfigFileNames?: readonly string[];
  /** Phase 02: discover `.vue` files (default true; false keeps TS-only scans). */
  scanVue?: boolean;
  /** Phase 04: discover `.css` / `.scss` / `.less` (default true). */
  scanStyles?: boolean;
  styleExtensions?: readonly string[];
  /**
   * Query-time freshness probe: stat only, never read file contents and never
   * compute `sourceHash`. The full scan remains the authority for builds.
   */
  statOnly?: boolean;
}

export function fileLanguage(fileName: string): FileLanguage | null {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.ts') return 'ts';
  if (extension === '.tsx') return 'tsx';
  if (extension === VUE_EXTENSION) return 'vue';
  if (extension === '.css') return 'css';
  if (extension === '.scss') return 'scss';
  if (extension === '.less') return 'less';
  return null;
}

export function isStyleLanguage(language: FileLanguage): language is 'css' | 'scss' | 'less' {
  return language === 'css' || language === 'scss' || language === 'less';
}

function realpathInside(projectRoot: string, rootPath: string, filePath: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return false;
  }
  return isInside(projectRoot, real) && isInside(rootPath, real);
}

function readScannedFile(
  projectRoot: string,
  rootPath: string,
  absolutePath: string,
  result: ScanResult,
  seen: Set<string>,
  statOnly = false,
): void {
  const relativeToProject = toPosix(path.relative(projectRoot, absolutePath));
  if (!realpathInside(projectRoot, rootPath, absolutePath)) {
    result.outsideRoot.push({ path: relativeToProject, reason: 'outside project/root boundary' });
    return;
  }
  const language = fileLanguage(absolutePath);
  if (language === null) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    result.filesFailed.push({ path: relativeToProject, reason: 'cannot stat file' });
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) {
    result.filesSkippedBySize += 1;
    return;
  }
  try {
    const text = statOnly ? '' : fs.readFileSync(absolutePath, 'utf8');
    result.files.push({
      path: relativeToProject,
      absolutePath,
      sourceHash: statOnly ? '' : contentHash(text),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
    });
  } catch {
    result.filesFailed.push({ path: relativeToProject, reason: 'cannot read file' });
  }
  void seen;
}

function shouldSkipFile(
  fileName: string,
  projectRoot: string,
  ignore: IgnoreMatcher,
): { skip: boolean; ignored: boolean } {
  const relative = toPosix(path.relative(projectRoot, path.resolve(fileName)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { skip: true, ignored: false };
  }
  if (isSensitiveFile(path.basename(fileName))) return { skip: true, ignored: true };
  if (ignore.isFileIgnored(relative)) return { skip: true, ignored: true };
  return { skip: false, ignored: false };
}

/**
 * Deterministic discovery of `.vue` / style files. `tsconfig.fileNames` never
 * contains them, so they are always discovered by walking the root; the same
 * ignore / sensitive-file / symlink / size rules apply.
 */
function scanAuxFiles(
  options: ScanOptions,
  projectRootAbs: string,
  result: ScanResult,
  seen: Set<string>,
): void {
  const scanVue = options.scanVue !== false;
  const scanStyles = options.scanStyles !== false;
  const styleExtensions = new Set(
    (options.styleExtensions ?? ['.css', '.scss', '.less']).map((entry) => entry.toLowerCase()),
  );
  const wanted = (language: FileLanguage): boolean => {
    if (language === 'vue') return scanVue;
    if (isStyleLanguage(language)) {
      return scanStyles && styleExtensions.has(`.${language}`);
    }
    return false;
  };
  const stack: Array<{ absolute: string; relative: string }> = [
    { absolute: options.absoluteRoot, relative: '' },
  ];
  while (stack.length > 0) {
    const current = stack.pop() as { absolute: string; relative: string };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      result.filesFailed.push({ path: current.relative || '.', reason: 'cannot read directory' });
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as fs.Dirent;
      const childAbsolute = path.join(current.absolute, entry.name);
      const childRelative =
        current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          options.ignore.isDirectoryIgnored(childRelative) &&
          !options.ignore.mayContainInclude(childRelative)
        ) {
          result.ignoredDirs += 1;
          continue;
        }
        stack.push({ absolute: childAbsolute, relative: childRelative });
        continue;
      }
      if (!entry.isFile()) continue;
      const language = fileLanguage(entry.name);
      if (language === null || !wanted(language)) continue;
      if (isSensitiveFile(entry.name) || options.ignore.isFileIgnored(childRelative)) {
        result.filesIgnored += 1;
        continue;
      }
      if (seen.has(childRelative)) continue;
      seen.add(childRelative);
      readScannedFile(
        projectRootAbs,
        options.absoluteRoot,
        childAbsolute,
        result,
        seen,
        options.statOnly === true,
      );
    }
  }
}

/**
 * Deterministic file discovery. Symlinks/junctions are never followed; paths
 * outside the project root are refused; sensitive files are never opened.
 */
export function scanFiles(options: ScanOptions): ScanResult {
  const { projectRoot, absoluteRoot, ignore, tsconfigFileNames } = options;
  const scanVue = options.scanVue !== false;
  const scanStyles = options.scanStyles !== false;
  const result: ScanResult = {
    files: [],
    filesIgnored: 0,
    ignoredDirs: 0,
    filesSkippedBySize: 0,
    filesFailed: [],
    outsideRoot: [],
  };
  const seen = new Set<string>();
  const projectRootAbs = path.resolve(projectRoot);

  if (tsconfigFileNames && tsconfigFileNames.length > 0) {
    const sorted = [...tsconfigFileNames].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const fileName of sorted) {
      const language = fileLanguage(fileName);
      if (language === null || language === 'vue' || isStyleLanguage(language)) continue;
      const absolutePath = path.resolve(fileName);
      const relative = toPosix(path.relative(projectRootAbs, absolutePath));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        result.outsideRoot.push({
          path: toPosix(fileName),
          reason: 'tsconfig includes file outside project root',
        });
        continue;
      }
      const skip = shouldSkipFile(absolutePath, projectRootAbs, ignore);
      if (skip.skip) {
        if (skip.ignored) result.filesIgnored += 1;
        continue;
      }
      if (seen.has(relative)) continue;
      seen.add(relative);
      readScannedFile(
        projectRootAbs,
        absoluteRoot,
        absolutePath,
        result,
        seen,
        options.statOnly === true,
      );
    }
    if (scanVue || scanStyles) scanAuxFiles(options, projectRootAbs, result, seen);
  } else {
    const stack: Array<{ absolute: string; relative: string }> = [
      { absolute: absoluteRoot, relative: '' },
    ];
    while (stack.length > 0) {
      const current = stack.pop() as { absolute: string; relative: string };
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.absolute, { withFileTypes: true });
      } catch {
        result.filesFailed.push({ path: current.relative || '.', reason: 'cannot read directory' });
        continue;
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as fs.Dirent;
        const childAbsolute = path.join(current.absolute, entry.name);
        const childRelative =
          current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (
            ignore.isDirectoryIgnored(childRelative) &&
            !ignore.mayContainInclude(childRelative)
          ) {
            result.ignoredDirs += 1;
            continue;
          }
          stack.push({ absolute: childAbsolute, relative: childRelative });
          continue;
        }
        if (!entry.isFile()) continue;
        const language = fileLanguage(entry.name);
        if (language === null) continue;
        if (language === 'vue' && !scanVue) continue;
        if (isStyleLanguage(language) && !scanStyles) continue;
        if (isSensitiveFile(entry.name) || ignore.isFileIgnored(childRelative)) {
          result.filesIgnored += 1;
          continue;
        }
        if (seen.has(childRelative)) continue;
        seen.add(childRelative);
        readScannedFile(
          projectRootAbs,
          absoluteRoot,
          childAbsolute,
          result,
          seen,
          options.statOnly === true,
        );
      }
    }
  }

  result.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return result;
}

export function filesHash(files: readonly ScannedFile[]): string {
  // Sorted (relative path, sourceHash) pairs (docs/05-data-model.md 5.11).
  const canonical = files.map((file) => [file.path, file.sourceHash] as const);
  return contentHash(JSON.stringify(canonical));
}

/**
 * Cheap query-time freshness probe: `(path,size,mtimeMs)`. It is not a
 * substitute for `filesHash`; a mismatch triggers the full content scan.
 */
export function statHash(files: readonly ScannedFile[]): string {
  const canonical = files.map(
    (file) => [file.path, file.size, Math.round(file.mtimeMs ?? 0)] as const,
  );
  return contentHash(JSON.stringify(canonical));
}
