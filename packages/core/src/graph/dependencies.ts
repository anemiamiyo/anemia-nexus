import path from 'node:path';
import ts from 'typescript';

import type { DependencyRecord, DependencyType, RelationEvidence } from '../model.js';
import { ANALYZER_VERSION } from '../index/analyzer.js';
import { isInside, relativePosix, toPosix } from '../util/paths.js';
import type { CrossRootResolver } from './cross-root.js';

export const PACKAGE_BOUNDARY_ANALYZER_VERSION = 'package-boundary@1';

export interface DependencyExtractionInput {
  program: ts.Program;
  projectRoot: string;
  rootAbs: string;
  rootId: string;
  compilerOptions: ts.CompilerOptions;
  scannedPaths: ReadonlySet<string>;
  styleExtensions: ReadonlySet<string>;
  crossRoot: CrossRootResolver | null;
}

export interface DependencyExtractionResult {
  dependencies: DependencyRecord[];
  dynamicImports: number;
  unresolved: number;
  crossRootEdges: number;
}

interface RawSpecifier {
  specifier: string;
  depType: DependencyType;
  line: number;
  col: number;
  dynamic: boolean;
  typeOnly: boolean;
}

function positionOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; col: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, col: position.character };
}

function isStyleSpecifier(specifier: string, extensions: ReadonlySet<string>): boolean {
  const extension = path.extname(specifier.split('?')[0] ?? '').toLowerCase();
  return extensions.has(extension);
}

function rawSpecifiers(sourceFile: ts.SourceFile): RawSpecifier[] {
  const output: RawSpecifier[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const position = positionOf(sourceFile, statement.moduleSpecifier);
      output.push({
        specifier: statement.moduleSpecifier.text,
        depType: statement.importClause?.isTypeOnly === true ? 'import-type' : 'import',
        line: position.line,
        col: position.col,
        dynamic: false,
        typeOnly: statement.importClause?.isTypeOnly === true,
      });
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const position = positionOf(sourceFile, statement.moduleSpecifier);
      output.push({
        specifier: statement.moduleSpecifier.text,
        depType: 'export',
        line: position.line,
        col: position.col,
        dynamic: false,
        typeOnly: statement.isTypeOnly,
      });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      const position = positionOf(sourceFile, statement.moduleReference.expression);
      output.push({
        specifier: statement.moduleReference.expression.text,
        depType: 'require',
        line: position.line,
        col: position.col,
        dynamic: false,
        typeOnly: statement.isTypeOnly,
      });
    }
  }

  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0] as ts.Node;
      if (ts.isStringLiteral(argument)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isDynamicImport || isRequire) {
          const position = positionOf(sourceFile, argument);
          output.push({
            specifier: argument.text,
            depType: isDynamicImport ? 'dynamic-import' : 'require',
            line: position.line,
            col: position.col,
            dynamic: isDynamicImport,
            typeOnly: false,
          });
        }
      }
    }
    const children = node.getChildren(sourceFile);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as ts.Node);
    }
  }
  return output;
}

function evidence(missReason: string | null, constraints: string[]): RelationEvidence {
  return {
    sourceOfTruth: 'ts-ast',
    analysisVersion: ANALYZER_VERSION.typescript,
    constraints,
    missReason,
  };
}

/**
 * File-level dependency extraction for TS/TSX. Style specifiers are left to
 * the style chain (graph/style.ts) so one edge is never counted twice.
 */
export function extractDependencies(input: DependencyExtractionInput): DependencyExtractionResult {
  const dependencies: DependencyRecord[] = [];
  let dynamicImports = 0;
  let unresolved = 0;
  let crossRootEdges = 0;
  const sourceFiles = input.program
    .getSourceFiles()
    .filter(
      (sourceFile) => !sourceFile.isDeclarationFile && isInside(input.rootAbs, sourceFile.fileName),
    )
    .sort((left, right) => (left.fileName < right.fileName ? -1 : 1));

  for (const sourceFile of sourceFiles) {
    const sourceRelative = relativePosix(input.projectRoot, sourceFile.fileName);
    for (const raw of rawSpecifiers(sourceFile)) {
      if (isStyleSpecifier(raw.specifier, input.styleExtensions)) continue;
      if (raw.dynamic) dynamicImports += 1;
      const resolved = ts.resolveModuleName(
        raw.specifier,
        sourceFile.fileName,
        input.compilerOptions,
        ts.sys,
      ).resolvedModule;
      const resolvedFile = resolved === undefined ? null : path.resolve(resolved.resolvedFileName);

      if (resolvedFile !== null && isInside(input.rootAbs, resolvedFile)) {
        const targetRelative = relativePosix(input.projectRoot, resolvedFile);
        if (input.scannedPaths.has(targetRelative)) {
          const relationClass = raw.dynamic ? 'dynamic-unresolved' : 'certain';
          const confidence = raw.dynamic ? 'unresolved' : 'typed';
          const missReason = raw.dynamic ? 'dynamic-import' : null;
          if (raw.dynamic) unresolved += 1;
          dependencies.push({
            sourceFile: sourceRelative,
            targetFile: targetRelative,
            sourceRootId: input.rootId,
            targetRootId: input.rootId,
            isCrossRoot: false,
            depType: raw.depType,
            specifier: raw.specifier,
            relationClass,
            confidence,
            analysisEngine: 'ts-ast',
            line: raw.line,
            col: raw.col,
            unresolvedReason: missReason,
            evidence: evidence(missReason, ['types-resolved']),
          });
          continue;
        }
        unresolved += 1;
        dependencies.push({
          sourceFile: sourceRelative,
          targetFile: null,
          sourceRootId: input.rootId,
          targetRootId: null,
          isCrossRoot: false,
          depType: raw.depType,
          specifier: raw.specifier,
          relationClass: 'dynamic-unresolved',
          confidence: 'unresolved',
          analysisEngine: 'ts-ast',
          line: raw.line,
          col: raw.col,
          unresolvedReason: 'target-not-covered',
          evidence: evidence('ignored', ['types-resolved', 'target-not-scanned']),
        });
        continue;
      }

      const crossRoot = input.crossRoot?.resolve(raw.specifier) ?? null;
      if (resolvedFile !== null && crossRoot === null) {
        const externalLibrary = resolved?.isExternalLibraryImport === true;
        const insideProject = isInside(input.projectRoot, resolvedFile);
        if (insideProject && isInside(path.join(input.projectRoot, 'node_modules'), resolvedFile)) {
          // A real dependency: external to the project graph.
          continue;
        }
        if (!insideProject && externalLibrary) continue;
        if (insideProject || !externalLibrary) {
          unresolved += 1;
          dependencies.push({
            sourceFile: sourceRelative,
            targetFile: null,
            sourceRootId: input.rootId,
            targetRootId: null,
            isCrossRoot: false,
            depType: raw.depType,
            specifier: raw.specifier,
            relationClass: 'dynamic-unresolved',
            confidence: 'unresolved',
            analysisEngine: 'ts-ast',
            line: raw.line,
            col: raw.col,
            unresolvedReason: 'outside-root',
            evidence: evidence('out-of-scope', ['module-resolution-outside-root']),
          });
          continue;
        }
      }
      if (crossRoot !== null) {
        if (crossRoot.relationClass === 'certain') crossRootEdges += 1;
        else unresolved += 1;
        dependencies.push({
          sourceFile: sourceRelative,
          targetFile: crossRoot.targetFile,
          sourceRootId: input.rootId,
          targetRootId: crossRoot.targetRootId,
          isCrossRoot: true,
          depType: 'cross-package',
          specifier: raw.specifier,
          relationClass: crossRoot.relationClass,
          confidence: crossRoot.confidence,
          analysisEngine: crossRoot.analysisEngine,
          line: raw.line,
          col: raw.col,
          unresolvedReason: crossRoot.unresolvedReason,
          evidence: {
            sourceOfTruth: 'package-boundary',
            analysisVersion: PACKAGE_BOUNDARY_ANALYZER_VERSION,
            constraints: ['declared-dependency', 'exports-resolved'],
            missReason: crossRoot.unresolvedReason,
          },
        });
        continue;
      }

      if (raw.specifier.startsWith('.') || raw.specifier.startsWith('/')) {
        unresolved += 1;
        dependencies.push({
          sourceFile: sourceRelative,
          targetFile: null,
          sourceRootId: input.rootId,
          targetRootId: null,
          isCrossRoot: false,
          depType: raw.depType,
          specifier: raw.specifier,
          relationClass: 'dynamic-unresolved',
          confidence: 'unresolved',
          analysisEngine: 'ts-ast',
          line: raw.line,
          col: raw.col,
          unresolvedReason: 'not-found',
          evidence: evidence('not-found', ['module-resolution-failed']),
        });
      }
      // Bare external packages are out of the project graph; no edge, no noise.
    }
  }

  dependencies.sort((left, right) => {
    if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.col !== right.col) return left.col - right.col;
    if (left.specifier !== right.specifier) return left.specifier < right.specifier ? -1 : 1;
    return (left.targetFile ?? '') < (right.targetFile ?? '') ? -1 : 1;
  });
  return { dependencies, dynamicImports, unresolved, crossRootEdges };
}

/** Project-relative POSIX path of a resolved file, or null when outside. */
export function projectRelative(input: {
  projectRoot: string;
  absolutePath: string;
}): string | null {
  if (!isInside(input.projectRoot, input.absolutePath)) return null;
  return toPosix(path.relative(input.projectRoot, input.absolutePath));
}
