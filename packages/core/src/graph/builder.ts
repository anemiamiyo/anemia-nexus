import type {
  ArchitectureModuleRecord,
  ArchitectureViolationRecord,
  BlindSpot,
  CallRecord,
  DependencyRecord,
} from '../model.js';
import type { ArchitectureConfig } from '../config/schema.js';
import type { ScannedFile } from '../discovery/scan.js';
import { isStyleLanguage } from '../discovery/scan.js';
import type { IdentityAssignment } from '../index/mapping.js';
import { ArchitectureIndex } from './architecture.js';
import { buildBlindSpots } from './blindspots.js';
import { extractCalls, type CallExtractionResult } from './calls.js';
import { extractDependencies } from './dependencies.js';
import { extractStyleDependencies, type StyleExtractionResult } from './style.js';
import type { CrossRootResolver } from './cross-root.js';

export interface GraphBuildInput {
  projectRoot: string;
  rootAbs: string;
  rootId: string;
  rootPath: string;
  files: readonly ScannedFile[];
  program: import('typescript').Program;
  checker: import('typescript').TypeChecker;
  assignments: readonly IdentityAssignment[];
  crossRoot: CrossRootResolver | null;
  architecture: ArchitectureConfig;
  style: {
    aliases: Readonly<Record<string, string>>;
    extensions: readonly string[];
  };
  coverage: {
    filesIgnored: number;
    filesSkippedBySize: number;
    filesFailed: readonly string[];
    unmappedSymbols: number;
  };
}

export interface GraphBuildResult {
  dependencies: DependencyRecord[];
  calls: CallRecord[];
  architectureModules: ArchitectureModuleRecord[];
  architectureViolations: ArchitectureViolationRecord[];
  blindSpots: BlindSpot[];
  moduleByPath: Map<string, string>;
  stats: {
    dynamicImports: number;
    unresolvedDependencies: number;
    crossRootEdges: number;
    calls: CallExtractionResult['byResolution'];
    style: StyleExtractionResult;
  };
  warnings: string[];
}

/**
 * One Normalizer-owned graph build: the same dependency/call/style rows feed
 * `deps`, architecture rules and (later) impact. Commands must not re-classify
 * these edges independently (docs/08-relations.md 8.3).
 */
export function buildGraph(input: GraphBuildInput): GraphBuildResult {
  const styleFiles = input.files.filter((file) => isStyleLanguage(file.language));
  const vueFiles = input.files.filter((file) => file.language === 'vue');
  const scannedPaths = new Set(input.files.map((file) => file.path));
  const styleExtensions = new Set(input.style.extensions.map((entry) => entry.toLowerCase()));

  const tsDependencies = extractDependencies({
    program: input.program,
    projectRoot: input.projectRoot,
    rootAbs: input.rootAbs,
    rootId: input.rootId,
    compilerOptions: input.program.getCompilerOptions(),
    scannedPaths,
    styleExtensions,
    crossRoot: input.crossRoot,
  });
  const style = extractStyleDependencies({
    projectRoot: input.projectRoot,
    rootAbs: input.rootAbs,
    rootPath: input.rootPath,
    rootId: input.rootId,
    styleFiles,
    vueFiles,
    program: input.program,
    aliases: input.style.aliases,
    extensions: input.style.extensions,
  });
  const dependencies = [...tsDependencies.dependencies, ...style.dependencies].sort(
    (left, right) => {
      if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
      if (left.line !== right.line) return left.line - right.line;
      if (left.col !== right.col) return left.col - right.col;
      if (left.depType !== right.depType) return left.depType < right.depType ? -1 : 1;
      return (left.targetFile ?? '') < (right.targetFile ?? '') ? -1 : 1;
    },
  );

  const calls = extractCalls({
    program: input.program,
    checker: input.checker,
    projectRoot: input.projectRoot,
    rootAbs: input.rootAbs,
    assignments: input.assignments,
  });

  const symbolCountByPath = new Map<string, number>();
  for (const assignment of input.assignments) {
    symbolCountByPath.set(
      assignment.declaration.path,
      (symbolCountByPath.get(assignment.declaration.path) ?? 0) + 1,
    );
  }
  const architecture = new ArchitectureIndex(input.architecture);
  const assigned = architecture.assign(input.files, symbolCountByPath);
  for (const file of input.files) {
    file.ownerModule = assigned.moduleByPath.get(file.path) ?? null;
  }
  for (const dependency of dependencies) {
    dependency.sourceModule = assigned.moduleByPath.get(dependency.sourceFile) ?? null;
    dependency.targetModule =
      dependency.targetFile === null
        ? null
        : (assigned.moduleByPath.get(dependency.targetFile) ??
          architecture.moduleFor(dependency.targetFile));
  }
  const violations = architecture.evaluateViolations(dependencies, assigned.moduleByPath);

  const unmappedSymbols = input.coverage.unmappedSymbols;
  const blindSpots = buildBlindSpots({
    dependencies,
    calls: calls.calls,
    dynamicImports: tsDependencies.dynamicImports,
    styleFiles: style.files,
    styleUnresolvedReasons: style.unresolvedReasons,
    filesIgnored: input.coverage.filesIgnored,
    filesSkippedBySize: input.coverage.filesSkippedBySize,
    filesFailed: input.coverage.filesFailed,
    unmappedSymbols,
    symbolCountByPath,
  });

  return {
    dependencies,
    calls: calls.calls,
    architectureModules: assigned.modules,
    architectureViolations: violations,
    blindSpots,
    moduleByPath: assigned.moduleByPath,
    stats: {
      dynamicImports: tsDependencies.dynamicImports,
      unresolvedDependencies: tsDependencies.unresolved,
      crossRootEdges: tsDependencies.crossRootEdges,
      calls: calls.byResolution,
      style,
    },
    warnings: [...assigned.warnings].sort(),
  };
}
