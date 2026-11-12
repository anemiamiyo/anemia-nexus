import fs from 'node:fs';
import path from 'node:path';

import type { Confidence, RelationClass } from '../model.js';
import { isInside, toPosix } from '../util/paths.js';

export interface WorkspaceRootInfo {
  rootId: string;
  rootPath: string;
  packageName: string | null;
  /** package.json dependency maps, already limited to declared package names. */
  dependencies: Set<string>;
}

export interface CrossRootResolution {
  targetRootId: string | null;
  targetFile: string | null;
  relationClass: RelationClass;
  confidence: Confidence;
  unresolvedReason: string | null;
  analysisEngine: string;
}

interface PackageJson {
  name?: unknown;
  exports?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
}

function readPackageJson(filePath: string): PackageJson | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PackageJson;
  } catch {
    return null;
  }
}

function declaredDependencies(packageJson: PackageJson | null): Set<string> {
  const names = new Set<string>();
  if (packageJson === null) return names;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const map = packageJson[key];
    if (typeof map !== 'object' || map === null) continue;
    for (const name of Object.keys(map)) names.add(name);
  }
  return names;
}

/** Split `@scope/name/sub` into package name and `./sub` subpath. */
export function splitSpecifier(specifier: string): { packageName: string; subpath: string } | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (segments.length < 2) return null;
    const packageName = `${segments[0]}/${segments[1]}`;
    const rest = segments.slice(2).join('/');
    return { packageName, subpath: rest === '' ? '.' : `./${rest}` };
  }
  const packageName = segments[0] as string;
  const rest = segments.slice(1).join('/');
  return { packageName, subpath: rest === '' ? '.' : `./${rest}` };
}

function pickCondition(value: unknown): string | null {
  // Iterative condition resolution: strings win; arrays are fallbacks; objects
  // are searched in Node's precedence order.
  const order = ['import', 'types', 'node', 'require', 'default'];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') return current;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    const record = current as Record<string, unknown>;
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const key = order[index] as string;
      if (key in record) stack.push(record[key]);
    }
  }
  return null;
}

function exportsTarget(exportsValue: unknown, subpath: string): string | null {
  if (typeof exportsValue === 'string') return subpath === '.' ? exportsValue : null;
  if (Array.isArray(exportsValue)) {
    return subpath === '.' ? pickCondition(exportsValue) : null;
  }
  if (typeof exportsValue !== 'object' || exportsValue === null) return null;
  const record = exportsValue as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasSubpaths = keys.some((key) => key.startsWith('.'));
  if (!hasSubpaths) {
    return subpath === '.' ? pickCondition(record) : null;
  }
  if (subpath in record) return pickCondition(record[subpath]);
  let best: { key: string; target: unknown; prefix: string } | null = null;
  for (const key of keys) {
    if (!key.startsWith('.') || !key.includes('*')) continue;
    const star = key.indexOf('*');
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (best === null || prefix.length > best.prefix.length) {
      best = { key, target: record[key], prefix };
    }
  }
  if (best === null) return null;
  const target = pickCondition(best.target);
  if (target === null) return null;
  const star = best.key.indexOf('*');
  const prefix = best.key.slice(0, star);
  const suffix = best.key.slice(star + 1);
  const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
  return target.replaceAll('*', middle);
}

function safeTarget(rootPath: string, target: string): string | null {
  const normalized = target.replaceAll('\\', '/');
  if (!normalized.startsWith('./')) return null;
  if (normalized.split('/').includes('..')) return null;
  const joined = path.posix.normalize(path.posix.join(rootPath, normalized));
  if (joined.startsWith('../') || joined === '..') return null;
  return joined;
}

/**
 * Resolves a bare specifier to another selected root only when the caller
 * declares the package and the target root's `exports` maps the subpath to a
 * real file (docs/05-data-model.md 5.7). Never expands the target root.
 */
export class CrossRootResolver {
  private readonly projectRoot: string;
  private readonly caller: WorkspaceRootInfo;
  private readonly rootsByPackage = new Map<string, WorkspaceRootInfo>();
  private readonly packageJsonByRoot = new Map<string, PackageJson | null>();

  constructor(input: {
    projectRoot: string;
    caller: WorkspaceRootInfo;
    roots: readonly WorkspaceRootInfo[];
  }) {
    this.projectRoot = path.resolve(input.projectRoot);
    this.caller = input.caller;
    for (const root of input.roots) {
      if (root.packageName !== null && !this.rootsByPackage.has(root.packageName)) {
        this.rootsByPackage.set(root.packageName, root);
      }
      this.packageJsonByRoot.set(
        root.rootId,
        readPackageJson(path.join(this.projectRoot, root.rootPath, 'package.json')),
      );
    }
  }

  resolve(specifier: string): CrossRootResolution | null {
    const split = splitSpecifier(specifier);
    if (split === null) return null;
    const targetRoot = this.rootsByPackage.get(split.packageName);
    if (targetRoot === undefined) {
      if (this.caller.dependencies.has(split.packageName)) {
        return this.failure('root-not-indexed');
      }
      return null;
    }
    if (!this.caller.dependencies.has(split.packageName)) {
      return this.failure('undeclared-dependency', targetRoot.rootId);
    }
    const packageJson = this.packageJsonByRoot.get(targetRoot.rootId) ?? null;
    const target = exportsTarget(packageJson?.exports, split.subpath);
    if (target === null) {
      return this.failure('exports-mismatch', targetRoot.rootId);
    }
    const relative = safeTarget(targetRoot.rootPath, target);
    if (relative === null) {
      return this.failure('outside-root', targetRoot.rootId);
    }
    const absolute = path.resolve(this.projectRoot, relative);
    const rootAbsolute = path.resolve(this.projectRoot, targetRoot.rootPath);
    if (!isInside(this.projectRoot, absolute) || !isInside(rootAbsolute, absolute)) {
      return this.failure('outside-root', targetRoot.rootId);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return this.failure('not-found', targetRoot.rootId);
    }
    if (!stat.isFile()) return this.failure('not-found', targetRoot.rootId);
    return {
      targetRootId: targetRoot.rootId,
      targetFile: toPosix(path.relative(this.projectRoot, absolute)),
      relationClass: 'certain',
      confidence: 'typed',
      unresolvedReason: null,
      analysisEngine: 'package-boundary',
    };
  }

  private failure(reason: string, targetRootId: string | null = null): CrossRootResolution {
    return {
      targetRootId,
      targetFile: null,
      relationClass: 'dynamic-unresolved',
      confidence: 'unresolved',
      unresolvedReason: `package-boundary:${reason}`,
      analysisEngine: 'package-boundary',
    };
  }
}

export function readWorkspaceRootInfo(input: {
  rootId: string;
  rootPath: string;
  packageName: string | null;
}): WorkspaceRootInfo {
  return {
    rootId: input.rootId,
    rootPath: input.rootPath,
    packageName: input.packageName,
    dependencies: new Set<string>(),
  };
}

export function loadWorkspaceRootInfo(input: {
  projectRoot: string;
  rootId: string;
  rootPath: string;
  packageName: string | null;
}): WorkspaceRootInfo {
  const packageJson = readPackageJson(path.join(input.projectRoot, input.rootPath, 'package.json'));
  return {
    rootId: input.rootId,
    rootPath: input.rootPath,
    packageName: input.packageName,
    dependencies: declaredDependencies(packageJson),
  };
}
