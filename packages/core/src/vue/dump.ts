import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';
import { readTsconfig } from '../discovery/tsconfig.js';
import { VUE_LANGUAGE_CORE_VERSION, VUE_PROJECTOR_VERSION } from '../index/analyzer.js';
import { projectVueFile } from './project.js';

export interface DumpVueMapOptions {
  projectRoot: string;
  file: string;
}

interface ManifestRootSummary {
  rootId: string;
  rootPath: string;
}

function listRoots(projectRoot: string): ManifestRootSummary[] {
  const rootsDir = path.join(projectRoot, '.nexus', 'roots');
  if (!fs.existsSync(rootsDir)) return [];
  const output: ManifestRootSummary[] = [];
  for (const entry of fs.readdirSync(rootsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(rootsDir, entry.name, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      output.push({
        rootId: entry.name,
        rootPath: typeof manifest.rootPath === 'string' ? manifest.rootPath : entry.name,
      });
    } catch {
      output.push({ rootId: entry.name, rootPath: entry.name });
    }
  }
  output.sort((left, right) =>
    left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0,
  );
  return output;
}

function selectRootForFile(projectRoot: string, absoluteFile: string): ManifestRootSummary | null {
  let best: ManifestRootSummary | null = null;
  for (const root of listRoots(projectRoot)) {
    const rootAbsolute = path.resolve(projectRoot, root.rootPath);
    const fileRelativeToRoot = path.relative(rootAbsolute, absoluteFile).split(path.sep).join('/');
    if (fileRelativeToRoot.startsWith('..') || path.isAbsolute(fileRelativeToRoot)) continue;
    if (best === null || path.resolve(projectRoot, best.rootPath).length < rootAbsolute.length) {
      best = root;
    }
  }
  return best;
}

/**
 * `doctor --dump-vue-map`: re-projects the SFC in memory and prints the Volar
 * mapping segments. Nothing is written to disk (docs/04-architecture.md 4.1.1).
 */
export function dumpVueMap(options: DumpVueMapOptions): Record<string, unknown> {
  const projectRoot = path.resolve(options.projectRoot);
  const absolute = path.resolve(projectRoot, options.file);
  if (!fs.existsSync(absolute)) {
    throw nexusError('E05', 'Vue file does not exist', {
      reason: `no file at ${options.file}`,
      suggestion: 'Pass a project-relative .vue path that exists.',
    });
  }
  if (!absolute.toLowerCase().endsWith('.vue')) {
    throw nexusError('E00', '--dump-vue-map expects a .vue file', {
      reason: options.file,
      suggestion: 'Pass a .vue file inside an indexed root.',
    });
  }
  const root = selectRootForFile(projectRoot, absolute);
  if (root === null) {
    throw nexusError('E16', 'file does not belong to an indexed root', {
      reason: options.file,
      suggestion: 'Pass --root after checking `nex status`, or rebuild the index.',
      evidence: { candidates: listRoots(projectRoot).map((entry) => entry.rootId) },
    });
  }
  const rootAbsolute = path.resolve(projectRoot, root.rootPath);
  const tsconfig = readTsconfig(rootAbsolute, `${root.rootPath}/tsconfig.json`);
  const result = projectVueFile({
    projectRoot,
    rootAbsolutePath: rootAbsolute,
    filePath: absolute,
    compilerOptions: tsconfig.ok ? (tsconfig.options ?? undefined) : undefined,
  });
  if (!result.ok) {
    throw nexusError('E11', 'Vue projection failed', {
      reason: result.error.reason,
      file: result.error.path,
      suggestion: 'Fix the SFC syntax and rebuild.',
    });
  }
  const projection = result.projection;
  const generatedLimit = 200_000;
  const generated =
    projection.generated.length <= generatedLimit
      ? projection.generated
      : projection.generated.slice(0, generatedLimit);
  return {
    file: projection.path,
    rootId: root.rootId,
    sourceHash: projection.sourceHash,
    projectorVersion: VUE_PROJECTOR_VERSION,
    languageCoreVersion: VUE_LANGUAGE_CORE_VERSION,
    generatedBytes: projection.generatedBytes,
    generatedTruncated: projection.generated.length > generatedLimit,
    segmentCount: projection.segments.length,
    segments: projection.segments.map((segment) => ({
      generated: segment.generated,
      generatedLength: segment.generatedLength,
      source: segment.source,
      sourceLength: segment.sourceLength,
    })),
    templateRange: projection.templateRange,
    templateRanges: projection.templateRanges,
    generatedText: generated,
  };
}
