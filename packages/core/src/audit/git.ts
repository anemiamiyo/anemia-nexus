import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';

/**
 * Read-only Git access for postflight (docs/13-audit-and-ci.md 13.2/13.4).
 * Fixed argument lists, no shell, no destructive commands. A user-supplied
 * `--base` is validated as a git ref before it reaches git.
 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export type GitChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface GitChange {
  status: GitChangeStatus;
  file: string;
  oldPath: string | null;
}

export function assertGitWorkTree(projectRoot: string): void {
  try {
    const value = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    }).trim();
    if (value !== 'true') throw new Error('not a work tree');
  } catch {
    throw nexusError('E00', 'postflight requires a Git work tree', {
      reason: 'git rev-parse --is-inside-work-tree failed',
      suggestion:
        'Run postflight inside a Git repository, or pass a project that is tracked by Git.',
    });
  }
}

function isGitRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(value) && !value.includes('..');
}

export function resolveBase(projectRoot: string, base: string | null | undefined): string {
  const candidate = base === undefined || base === null || base === '' ? 'HEAD' : base;
  if (!isGitRef(candidate)) {
    throw nexusError('E00', 'invalid postflight base ref', {
      reason: `--base ${JSON.stringify(candidate)} is not a plain git ref`,
      suggestion: 'Use a commit, branch or tag, e.g. HEAD, HEAD~1, origin/main.',
    });
  }
  try {
    execFileSync('git', ['-C', projectRoot, 'rev-parse', '--verify', `${candidate}^{commit}`], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
  } catch {
    throw nexusError('E00', 'postflight base ref does not exist', {
      reason: `git rev-parse --verify ${candidate}^{commit} failed`,
      suggestion: 'Check the ref name or fetch the branch before running postflight.',
      evidence: { base: candidate },
    });
  }
  return candidate;
}

export function diffNameStatus(projectRoot: string, base: string): GitChange[] {
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      [
        '-C',
        projectRoot,
        'diff',
        '--name-status',
        '-M',
        '--no-ext-diff',
        '--no-textconv',
        base,
        '--',
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
    );
  } catch (error) {
    throw nexusError('E00', 'postflight could not read the Git diff', {
      reason: error instanceof Error ? error.message : String(error),
      suggestion: 'Check that the base ref is valid and the repository is readable.',
    });
  }
  const changes: GitChange[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R')) {
      const oldPath = parts[1];
      const file = parts[2];
      if (oldPath !== undefined && file !== undefined) {
        changes.push({ status: 'R', file, oldPath });
      }
      continue;
    }
    const code = status.charAt(0);
    if (code !== 'A' && code !== 'M' && code !== 'D') continue;
    const file = parts[1];
    if (file === undefined) continue;
    changes.push({ status: code, file, oldPath: code === 'D' ? file : null });
  }
  return changes.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.oldPath ?? '').localeCompare(right.oldPath ?? '') ||
      left.status.localeCompare(right.status),
  );
}

export interface LineRange {
  start: number;
  end: number;
}

/** New-side changed line ranges from `git diff -U0` (docs/13-audit-and-ci.md 13.2 #3). */
export function diffLineRanges(projectRoot: string, base: string, file: string): LineRange[] {
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      [
        '-C',
        projectRoot,
        'diff',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        base,
        '--',
        file,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
    );
  } catch {
    return [];
  }
  const ranges: LineRange[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const start = Number.parseInt(match[1] ?? '0', 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

export function showFileAtRef(projectRoot: string, base: string, file: string): string | null {
  try {
    return execFileSync('git', ['-C', projectRoot, 'show', `${base}:${file}`], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

export function readWorkingFile(projectRoot: string, file: string): string | null {
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}
