import fs from 'node:fs';
import path from 'node:path';

import { isSensitiveFile } from '../config/builtin.js';
import type { IgnoreMatcher } from './ignore.js';
import { isInside, toPosix } from '../util/paths.js';
import { contentHash } from '../util/hash.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

export interface ScannedFile {
  /** Project-relative POSIX path. */
  path: string;
  absolutePath: string;
  sourceHash: string;
  size: number;
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
}

function isTsFile(fileName: string): boolean {
  return TS_EXTENSIONS.has(path.extname(fileName).toLowerCase());
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
): void {
  const relativeToProject = toPosix(path.relative(projectRoot, absolutePath));
  const relativeToRoot = toPosix(path.relative(rootPath, absolutePath));
  if (!realpathInside(projectRoot, rootPath, absolutePath)) {
    result.outsideRoot.push({ path: relativeToProject, reason: 'outside project/root boundary' });
    return;
  }
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
    const text = fs.readFileSync(absolutePath, 'utf8');
    result.files.push({
      path: relativeToProject,
      absolutePath,
      sourceHash: contentHash(text),
      size: stat.size,
    });
  } catch {
    result.filesFailed.push({ path: relativeToProject, reason: 'cannot read file' });
  }
  void relativeToRoot;
}

/**
 * Deterministic file discovery. Symlinks/junctions are never followed; paths
 * outside the project root are refused; sensitive files are never opened.
 */
export function scanFiles(options: ScanOptions): ScanResult {
  const { projectRoot, absoluteRoot, ignore, tsconfigFileNames } = options;
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
      if (!isTsFile(fileName)) continue;
      const absolutePath = path.resolve(fileName);
      const relative = toPosix(path.relative(projectRootAbs, absolutePath));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        result.outsideRoot.push({
          path: toPosix(fileName),
          reason: 'tsconfig includes file outside project root',
        });
        continue;
      }
      if (isSensitiveFile(path.basename(absolutePath))) {
        result.filesIgnored += 1;
        continue;
      }
      if (ignore.isFileIgnored(relative)) {
        result.filesIgnored += 1;
        continue;
      }
      if (seen.has(relative)) continue;
      seen.add(relative);
      readScannedFile(projectRootAbs, absoluteRoot, absolutePath, result);
    }
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
        if (!isTsFile(entry.name)) continue;
        if (isSensitiveFile(entry.name) || ignore.isFileIgnored(childRelative)) {
          result.filesIgnored += 1;
          continue;
        }
        if (seen.has(childRelative)) continue;
        seen.add(childRelative);
        readScannedFile(projectRootAbs, absoluteRoot, childAbsolute, result);
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
