import fs from 'node:fs';
import path from 'node:path';

import {
  BUILTIN_IGNORE_DIRS,
  BUILTIN_IGNORE_FILES,
  BUILTIN_IGNORE_GLOBS,
} from '../config/builtin.js';
import { nexusError } from '../errors.js';
import { sha256Hex } from '../util/hash.js';
import { toPosix } from '../util/paths.js';
import { IgnoreMatcher } from './ignore.js';
import { readTsconfig, type TsconfigResult } from './tsconfig.js';

const MAX_WALK_DEPTH = 12;
const MAX_WALK_DIRS = 50_000;

export interface WorkspaceDeclaration {
  source: string;
  patterns: string[];
}

export interface RootCandidate {
  rootId: string;
  rootPath: string;
  absolutePath: string;
  packageName: string | null;
  tsconfigRelativePath: string | null;
  tsconfig: TsconfigResult | null;
  indexable: boolean;
  reasons: string[];
  sources: string[];
}

export interface DiscoveryResult {
  projectRoot: string;
  declarations: WorkspaceDeclaration[];
  candidates: RootCandidate[];
  roots: RootCandidate[];
  nonIndexable: RootCandidate[];
  limited: boolean;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parsePnpmWorkspace(projectRoot: string): string[] {
  const filePath = path.join(projectRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const patterns: string[] = [];
  const lines = text.split(/\r?\n/);
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!inPackages) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        const inline = line.slice(line.indexOf(':') + 1).trim();
        if (inline.startsWith('[')) {
          const flow = inline.replace(/^\[/, '').replace(/\]$/, '');
          for (const part of flow.split(',')) {
            const value = part.trim().replace(/^['"]|['"]$/g, '');
            if (value.length > 0) patterns.push(value);
          }
        }
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) break;
    if (line.startsWith('- ')) {
      const value = line
        .slice(2)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (value.length > 0) patterns.push(value);
    }
  }
  return patterns;
}

export function readWorkspaceDeclarations(projectRoot: string): WorkspaceDeclaration[] {
  const declarations: WorkspaceDeclaration[] = [];
  const packageJson = asRecord(readJsonFile(path.join(projectRoot, 'package.json')));
  if (packageJson) {
    const workspaces = packageJson.workspaces;
    if (Array.isArray(workspaces)) {
      declarations.push({ source: 'package.json#workspaces', patterns: stringArray(workspaces) });
    } else {
      const record = asRecord(workspaces);
      if (record) {
        declarations.push({
          source: 'package.json#workspaces.packages',
          patterns: stringArray(record.packages),
        });
      }
    }
  }

  const pnpmPatterns = parsePnpmWorkspace(projectRoot);
  if (pnpmPatterns.length > 0) {
    declarations.push({ source: 'pnpm-workspace.yaml', patterns: pnpmPatterns });
  }

  const lerna = asRecord(readJsonFile(path.join(projectRoot, 'lerna.json')));
  if (lerna) {
    declarations.push({ source: 'lerna.json', patterns: stringArray(lerna.packages) });
  }

  const rush = asRecord(readJsonFile(path.join(projectRoot, 'rush.json')));
  if (rush && Array.isArray(rush.projects)) {
    const patterns: string[] = [];
    for (const project of rush.projects) {
      const record = asRecord(project);
      if (record && typeof record.projectFolder === 'string') {
        patterns.push(record.projectFolder);
      }
    }
    if (patterns.length > 0) declarations.push({ source: 'rush.json', patterns });
  }

  for (const fileName of fs.readdirSync(projectRoot)) {
    if (!fileName.endsWith('.code-workspace')) continue;
    const workspace = asRecord(readJsonFile(path.join(projectRoot, fileName)));
    if (!workspace || !Array.isArray(workspace.folders)) continue;
    const patterns: string[] = [];
    for (const folder of workspace.folders) {
      const record = asRecord(folder);
      if (record && typeof record.path === 'string') patterns.push(record.path);
    }
    if (patterns.length > 0) declarations.push({ source: fileName, patterns });
  }

  for (const marker of ['nx.json', 'turbo.json']) {
    if (fs.existsSync(path.join(projectRoot, marker))) {
      declarations.push({ source: marker, patterns: [] });
    }
  }

  return declarations;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/, '');
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string;
    if (char === '*') {
      if (normalized[index + 1] === '*') {
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

function normalizeRootId(packageName: string | null, relativePath: string): string {
  const basis = packageName ?? relativePath;
  let normalized = basis
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (normalized === '') normalized = 'root';
  return normalized;
}

function buildIgnoreMatcher(): IgnoreMatcher {
  return new IgnoreMatcher({
    dirs: [...BUILTIN_IGNORE_DIRS],
    files: [...BUILTIN_IGNORE_FILES],
    globs: [...BUILTIN_IGNORE_GLOBS],
    include: [],
    modes: ['build', 'update', 'watch'],
    pruneWatcher: true,
  });
}

interface PackageDir {
  absolutePath: string;
  relativePath: string;
  packageName: string | null;
}

function enumeratePackageDirs(
  projectRoot: string,
  patterns: readonly string[],
  ignore: IgnoreMatcher,
): { dirs: PackageDir[]; limited: boolean } {
  const regexes = patterns.map((pattern) => globToRegExp(pattern));
  const seen = new Set<string>();
  const packageDirs: PackageDir[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: projectRoot, relative: '', depth: 0 },
  ];
  let visited = 0;
  let limited = false;

  while (stack.length > 0) {
    const current = stack.pop() as { absolute: string; relative: string; depth: number };
    visited += 1;
    if (visited > MAX_WALK_DIRS) {
      limited = true;
      break;
    }
    const packageJsonPath = path.join(current.absolute, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const isRoot = current.relative === '';
      const matches =
        isRoot || regexes.length === 0 || regexes.some((regex) => regex.test(current.relative));
      if (matches && !seen.has(current.relative)) {
        seen.add(current.relative);
        const pkg = asRecord(readJsonFile(packageJsonPath));
        packageDirs.push({
          absolutePath: current.absolute,
          relativePath: toPosix(current.relative),
          packageName: pkg && typeof pkg.name === 'string' ? pkg.name : null,
        });
      }
    }
    if (current.depth >= MAX_WALK_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as fs.Dirent;
      if (!entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) continue;
      const childRelative =
        current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      if (ignore.isDirectoryIgnored(childRelative) && !ignore.mayContainInclude(childRelative)) {
        continue;
      }
      stack.push({
        absolute: path.join(current.absolute, entry.name),
        relative: childRelative,
        depth: current.depth + 1,
      });
    }
  }

  return { dirs: packageDirs, limited };
}

function toCandidate(projectRoot: string, dir: PackageDir, sources: string[]): RootCandidate {
  const tsconfigPath = path.join(dir.absolutePath, 'tsconfig.json');
  const hasTsconfig = fs.existsSync(tsconfigPath);
  const tsconfig = hasTsconfig
    ? readTsconfig(dir.absolutePath, path.relative(projectRoot, tsconfigPath).replaceAll('\\', '/'))
    : null;
  const reasons: string[] = [];
  if (!hasTsconfig) reasons.push('no tsconfig.json');
  else if (!tsconfig?.ok) reasons.push(...(tsconfig?.errors ?? ['invalid tsconfig.json']));
  return {
    rootId: normalizeRootId(dir.packageName, dir.relativePath),
    rootPath: dir.relativePath === '' ? '.' : dir.relativePath,
    absolutePath: dir.absolutePath,
    packageName: dir.packageName,
    tsconfigRelativePath: hasTsconfig
      ? path.relative(projectRoot, tsconfigPath).replaceAll('\\', '/')
      : null,
    tsconfig,
    indexable: hasTsconfig && tsconfig?.ok === true,
    reasons: hasTsconfig && tsconfig?.ok ? [] : reasons,
    sources: [...sources],
  };
}

export interface DiscoverRootsOptions {
  projectRoot: string;
  /** Root ids explicitly selected in configuration (`workspaces.roots`). */
  selectedRootIds?: readonly string[];
  /** Extra source label, e.g. "configuration". */
  configSource?: string;
  /** For init: return every indexable candidate without demanding a selection. */
  allowAmbiguous?: boolean;
  /** `workspaces.exclude` patterns (project-relative). */
  exclude?: readonly string[];
}

/**
 * Enumerates workspace roots in the documented order (docs/05-data-model.md
 * 5.7). Ambiguity is surfaced, never resolved by silently taking the first
 * candidate.
 */
export function discoverRoots(options: DiscoverRootsOptions): DiscoveryResult {
  const projectRoot = path.resolve(options.projectRoot);
  const declarations = readWorkspaceDeclarations(projectRoot);
  if (options.configSource) {
    declarations.push({ source: options.configSource, patterns: [] });
  }
  const ignore = buildIgnoreMatcher();
  const patterns = declarations.flatMap((entry) => entry.patterns);
  const { dirs, limited } = enumeratePackageDirs(projectRoot, patterns, ignore);
  if (dirs.length === 0) {
    // A single-package repository still has one root when it has a tsconfig.
    dirs.push({ absolutePath: projectRoot, relativePath: '', packageName: null });
  }

  const excludeRegexes = (options.exclude ?? []).map((pattern) => globToRegExp(pattern));
  const candidates: RootCandidate[] = [];
  const usedIds = new Map<string, string>();
  for (const dir of dirs) {
    if (excludeRegexes.some((regex) => regex.test(dir.relativePath))) continue;
    const candidate = toCandidate(
      projectRoot,
      dir,
      declarations.map((entry) => entry.source),
    );
    const existing = usedIds.get(candidate.rootId);
    if (existing !== undefined && existing !== candidate.absolutePath) {
      candidate.rootId = `${candidate.rootId}-${sha256Hex(candidate.rootPath).slice(0, 6)}`;
    }
    usedIds.set(candidate.rootId, candidate.absolutePath);
    candidates.push(candidate);
  }
  candidates.sort((left, right) =>
    left.rootPath < right.rootPath ? -1 : left.rootPath > right.rootPath ? 1 : 0,
  );

  const selectedIds = options.selectedRootIds;
  let roots: RootCandidate[];
  if (selectedIds && selectedIds.length > 0) {
    const selectedSet = new Set(selectedIds);
    const unknown = selectedIds.filter(
      (id) => !candidates.some((candidate) => candidate.rootId === id),
    );
    if (unknown.length > 0) {
      throw nexusError('E15', 'unknown root id in configuration', {
        reason: `roots not found: ${unknown.join(', ')}`,
        suggestion:
          'Run `nex init` to list candidates, then set workspaces.roots to discovered ids.',
        evidence: { unknown, candidates: candidates.map((candidate) => candidate.rootId) },
      });
    }
    roots = candidates.filter((candidate) => selectedSet.has(candidate.rootId));
  } else if (options.allowAmbiguous === true) {
    roots = candidates.filter((candidate) => candidate.indexable);
  } else {
    roots = candidates.filter((candidate) => candidate.indexable);
    if (roots.length === 0) {
      throw nexusError('E15', 'no indexable root found', {
        reason: 'no candidate has a valid tsconfig.json',
        suggestion: 'Add a tsconfig.json or select roots explicitly after fixing configuration.',
        evidence: {
          candidates: candidates.map((candidate) => ({
            rootId: candidate.rootId,
            rootPath: candidate.rootPath,
            reasons: candidate.reasons,
          })),
        },
      });
    }
    if (roots.length > 1) {
      throw nexusError('E15', 'multiple roots require an explicit selection', {
        reason: 'workspaces.roots is empty and more than one indexable root was discovered',
        suggestion:
          'Pass --roots all or --roots <id,id>, or set workspaces.roots in .nexus/nexus.config.json.',
        evidence: {
          candidates: roots.map((candidate) => ({
            rootId: candidate.rootId,
            rootPath: candidate.rootPath,
          })),
        },
      });
    }
  }

  const nonIndexable = candidates.filter(
    (candidate) => !candidate.indexable && !roots.includes(candidate),
  );
  return { projectRoot, declarations, candidates, roots, nonIndexable, limited };
}
