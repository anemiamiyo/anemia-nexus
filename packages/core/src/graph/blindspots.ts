import type { BlindSpot, CallRecord, DependencyRecord } from '../model.js';

export interface BlindSpotInput {
  dependencies: readonly DependencyRecord[];
  calls: readonly CallRecord[];
  dynamicImports: number;
  styleFiles: number;
  styleUnresolvedReasons: Readonly<Record<string, number>>;
  filesIgnored: number;
  filesSkippedBySize: number;
  filesFailed: readonly string[];
  unmappedSymbols: number;
  symbolCountByPath: ReadonlyMap<string, number>;
}

function sumSymbols(
  files: ReadonlySet<string>,
  symbolCountByPath: ReadonlyMap<string, number>,
): number | null {
  if (files.size === 0) return 0;
  let total = 0;
  let known = false;
  for (const file of files) {
    const count = symbolCountByPath.get(file);
    if (count === undefined) continue;
    known = true;
    total += count;
  }
  return known ? total : null;
}

function sampleFiles(files: Iterable<string>, limit = 10): string[] {
  const output: string[] = [];
  for (const file of files) {
    if (output.includes(file)) continue;
    output.push(file);
    if (output.length >= limit) break;
  }
  return output.sort();
}

function make(input: Omit<BlindSpot, 'sample'> & { sample: Iterable<string> }): BlindSpot {
  return { ...input, sample: sampleFiles(input.sample) };
}

/**
 * Four-category blind-spot registry (docs/08-relations.md 8.2). Every record
 * carries affectedFiles / potentiallyAffectedSymbols / manualCheckHint; when
 * symbols cannot be counted it is null plus an explicit estimation method.
 */
export function buildBlindSpots(input: BlindSpotInput): BlindSpot[] {
  const output: BlindSpot[] = [];

  const dynamicFiles = new Set(
    input.dependencies
      .filter((dependency) => dependency.depType === 'dynamic-import')
      .map((dependency) => dependency.sourceFile),
  );
  output.push(
    make({
      category: 'code',
      missReason: 'dynamic-import',
      affectedFiles: dynamicFiles.size,
      potentiallyAffectedSymbols: sumSymbols(dynamicFiles, input.symbolCountByPath),
      estimateMethod:
        'sum of indexed declarations in files that contain a dynamic import; the import target itself is not resolved as certain',
      manualCheckHint: 'nex deps <file> --explain  # inspect dynamic-import rows',
      sample: dynamicFiles,
      sourceQuery: 'nex deps --type file <file>',
    }),
  );

  const unresolvedDeps = input.dependencies.filter(
    (dependency) =>
      dependency.relationClass !== 'certain' &&
      dependency.depType !== 'dynamic-import' &&
      !dependency.depType.startsWith('style-') &&
      !dependency.isCrossRoot,
  );
  const unresolvedDepFiles = new Set(unresolvedDeps.map((dependency) => dependency.sourceFile));
  output.push(
    make({
      category: 'code',
      missReason: 'unresolved-dependency',
      affectedFiles: unresolvedDepFiles.size,
      potentiallyAffectedSymbols: sumSymbols(unresolvedDepFiles, input.symbolCountByPath),
      estimateMethod:
        'sum of indexed declarations in files with an unresolved import; the missing target is not counted',
      manualCheckHint: 'nex deps <file> --explain  # read unresolvedReason and specifier',
      sample: unresolvedDepFiles,
      sourceQuery: 'nex deps --type file <file>',
    }),
  );

  const unresolvedCalls = input.calls.filter((call) => call.resolution === 'unresolved');
  const callFiles = new Set(unresolvedCalls.map((call) => call.callerFile));
  output.push(
    make({
      category: 'code',
      missReason: 'unresolved-call',
      affectedFiles: callFiles.size,
      potentiallyAffectedSymbols: sumSymbols(callFiles, input.symbolCountByPath),
      estimateMethod:
        'sum of indexed declarations in caller files; callee symbol set cannot be bounded without runtime information',
      manualCheckHint: 'nex deps --type call <symbol> --explain  # inspect dynamic callees',
      sample: callFiles,
      sourceQuery: 'nex deps --type call <symbol>',
    }),
  );

  const styleUnresolved = input.dependencies.filter(
    (dependency) =>
      dependency.depType.startsWith('style-') && dependency.relationClass === 'dynamic-unresolved',
  );
  const styleReasons = Object.keys(input.styleUnresolvedReasons).sort();
  if (styleReasons.length === 0) {
    output.push(
      make({
        category: 'style',
        missReason: 'style-unresolved',
        affectedFiles: 0,
        potentiallyAffectedSymbols: 0,
        estimateMethod: 'no style file produced a dynamic/unresolved edge in this build',
        manualCheckHint: `nex deps --type style <file> --reverse  # ${input.styleFiles} style files scanned`,
        sample: [],
        sourceQuery: 'nex deps --type style <file> --reverse',
      }),
    );
  } else {
    for (const reason of styleReasons) {
      const subset = styleUnresolved.filter((dependency) => dependency.unresolvedReason === reason);
      const files = new Set(subset.map((dependency) => dependency.sourceFile));
      output.push(
        make({
          category: 'style',
          missReason: reason,
          affectedFiles: files.size,
          potentiallyAffectedSymbols: null,
          estimateMethod:
            'style files do not own symbols; use affectedFiles and the reverse style query',
          manualCheckHint:
            'nex deps --type style <file> --reverse  # inspect the unresolved at-rule',
          sample: files,
          sourceQuery: 'nex deps --type style <file> --reverse',
        }),
      );
    }
  }

  const multiRoot = input.dependencies.filter(
    (dependency) => dependency.isCrossRoot && dependency.relationClass !== 'certain',
  );
  const multiReasons = [
    ...new Set(multiRoot.map((dependency) => dependency.unresolvedReason ?? 'unknown')),
  ].sort();
  if (multiReasons.length === 0) {
    output.push(
      make({
        category: 'multi-root',
        missReason: 'package-boundary',
        affectedFiles: 0,
        potentiallyAffectedSymbols: 0,
        estimateMethod: 'no cross-root edge was attempted in this build',
        manualCheckHint: 'nex deps <file> --explain  # crossRootEdges section',
        sample: [],
        sourceQuery: 'nex deps <file>',
      }),
    );
  } else {
    for (const reason of multiReasons) {
      const subset = multiRoot.filter(
        (dependency) => (dependency.unresolvedReason ?? 'unknown') === reason,
      );
      const files = new Set(subset.map((dependency) => dependency.sourceFile));
      output.push(
        make({
          category: 'multi-root',
          missReason: reason,
          affectedFiles: files.size,
          potentiallyAffectedSymbols: null,
          estimateMethod:
            'target root is not expanded by design (5.7); symbol impact requires the target root index',
          manualCheckHint:
            'nex status --roots all  # verify the target root is indexed, then rebuild',
          sample: files,
          sourceQuery: 'nex deps <file> --explain',
        }),
      );
    }
  }

  if (input.filesIgnored > 0) {
    output.push(
      make({
        category: 'coverage',
        missReason: 'ignored',
        affectedFiles: input.filesIgnored,
        potentiallyAffectedSymbols: null,
        estimateMethod:
          'ignored files are never opened; no symbol upper bound is computed in Phase 04',
        manualCheckHint: 'nex doctor  # print the effective ignore baseline and include rules',
        sample: [],
        sourceQuery: 'nex status',
      }),
    );
  }
  if (input.filesSkippedBySize > 0) {
    output.push(
      make({
        category: 'coverage',
        missReason: 'skipped-size',
        affectedFiles: input.filesSkippedBySize,
        potentiallyAffectedSymbols: null,
        estimateMethod: 'files above the size limit are not parsed; declarations are unknown',
        manualCheckHint: 'nex doctor  # files-over-size are reported from the manifest',
        sample: [],
        sourceQuery: 'nex status',
      }),
    );
  }
  if (input.filesFailed.length > 0) {
    output.push(
      make({
        category: 'coverage',
        missReason: 'analysis-failed',
        affectedFiles: input.filesFailed.length,
        potentiallyAffectedSymbols: null,
        estimateMethod:
          'failed files have no parsed declarations; the count is the affected-file count',
        manualCheckHint:
          'nex doctor  # inspect filesFailed and rebuild after fixing the read error',
        sample: input.filesFailed,
        sourceQuery: 'nex status',
      }),
    );
  }
  if (input.unmappedSymbols > 0) {
    output.push(
      make({
        category: 'coverage',
        missReason: 'mapping',
        affectedFiles: 0,
        potentiallyAffectedSymbols: input.unmappedSymbols,
        estimateMethod: 'symbols whose engine mapping did not reach exact/structural quality',
        manualCheckHint: 'nex symbol <symbolId>  # check mappingQuality and identity evidence',
        sample: [],
        sourceQuery: 'nex symbol <symbolId>',
      }),
    );
  }

  output.sort((left, right) => {
    if (left.category !== right.category) return left.category < right.category ? -1 : 1;
    if (left.missReason !== right.missReason) return left.missReason < right.missReason ? -1 : 1;
    return 0;
  });
  return output;
}
