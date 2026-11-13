import path from 'node:path';
import ts from 'typescript';

import type { BlindSpot, Coverage, Counts, SymbolRecord } from '../model.js';
import type { SurfaceDiffItem } from '../surface/types.js';
import { nexusError } from '../errors.js';
import { prepareContext, selectScope, type QueryOptions } from '../query/service.js';
import { databasePath, manifestPath, readManifest } from '../store/manifest.js';
import {
  openReadStore,
  readArchitectureViolations,
  readDependencies,
  readReferencesTo,
  readSymbolsForFile,
  readTestsForSymbol,
} from '../store/read.js';
import { diffCurrentSurface } from '../surface/service.js';
import { sha256Base32 } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';
import {
  assertGitWorkTree,
  diffLineRanges,
  diffNameStatus,
  readWorkingFile,
  resolveBase,
  showFileAtRef,
  type GitChange,
  type LineRange,
} from './git.js';
import { runVerify, type VerifyCommandResult } from './verify.js';

export type FailOn = 'breaking' | 'additive' | 'ambiguous' | 'warning' | 'none';

export interface PostflightOptions extends QueryOptions {
  base?: string | null;
  failOn?: FailOn;
  yes?: boolean;
  only?: readonly string[] | null;
  explicitVerify?: boolean;
}

export interface ChangedSymbol {
  rootId: string;
  symbolId: string | null;
  name: string;
  nameChain: string | null;
  kind: string;
  path: string;
  line: number;
  col: number;
  change: 'added' | 'modified' | 'removed' | 'unidentified';
  relationClass: string;
  confidence: string;
}

export interface Finding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  category: 'surface' | 'architecture' | 'style' | 'test' | 'verify' | 'index' | 'dependency';
  file: string;
  line: number;
  symbolId: string | null;
  evidence: unknown;
  suggestion: string;
  origin: 'introduced' | 'pre-existing';
  blockable: boolean;
}

export interface PostflightData {
  command: 'postflight';
  base: string;
  scope: string;
  buildFingerprint: string | null;
  staleness: string;
  mode: string;
  confidence: 'high' | 'medium' | 'low';
  findings: Finding[];
  surfaceDiff: {
    breaking: SurfaceDiffItem[];
    additive: SurfaceDiffItem[];
    internal: SurfaceDiffItem[];
    ambiguous: SurfaceDiffItem[];
  };
  coverage: Coverage | null;
  blindSpots: BlindSpot[];
  verification: {
    commands: VerifyCommandResult[];
    skipped: Array<{ id: string; reason: string }>;
  };
  changed: {
    files: Array<{
      rootId: string;
      path: string;
      oldPath: string | null;
      status: string;
      lines: LineRange[];
      symbols: number;
    }>;
    symbols: ChangedSymbol[];
    unidentified: Array<{ rootId: string; path: string; reason: string }>;
  };
  dependencyChanges: Array<{
    rootId: string;
    file: string;
    oldPath: string | null;
    added: string[];
    removed: string[];
    note: string;
  }>;
  counts: Counts;
  risk: { level: 'Low' | 'Medium' | 'High' | 'Critical'; reasons: string[] };
  exit: { failOn: FailOn; blocking: boolean; warnings: number; code: number };
  warnings: Array<{ code: string; message: string; severity: 'warning' | 'error' }>;
  notes: string[];
  scopeRoots: string[];
  staleRoots: string[];
  failedRoots: string[];
  completeness: 'complete' | 'partial';
}

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less']);
const FAIL_ON_ORDER: readonly FailOn[] = ['breaking', 'additive', 'ambiguous', 'warning', 'none'];

function findingId(code: string, file: string, line: number, symbolId: string | null): string {
  return `f_${sha256Base32(stableStringify({ code, file, line, symbolId }), 12)}`;
}

function makeFinding(input: Omit<Finding, 'id'>): Finding {
  return {
    ...input,
    id: findingId(input.code, input.file, input.line, input.symbolId),
  };
}

function isStyle(file: string): boolean {
  return STYLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function overlaps(symbol: SymbolRecord, ranges: readonly LineRange[]): boolean {
  const start = symbol.declarationLocator.startLine;
  const end = symbol.declarationLocator.endLine;
  return ranges.some((range) => start <= range.end && end >= range.start);
}

function specifiersOf(text: string, fileName: string): string[] | null {
  const extension = path.extname(fileName).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(extension)) {
    return null;
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        found.add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteral(expression)) found.add(expression.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length > 0) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteral(first)) found.add(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

function selectRootForFile(
  roots: Array<{ rootId: string; rootPath: string }>,
  file: string,
): { rootId: string; rootPath: string } | null {
  const matches = roots.filter(
    (root) =>
      root.rootPath === '.' ||
      root.rootPath === '' ||
      file === root.rootPath ||
      file.startsWith(`${root.rootPath.replaceAll('\\', '/')}/`),
  );
  if (matches.length === 0) return null;
  return matches.sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
}

function coverageAggregate(values: Array<Coverage | null>): Coverage | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const output: Coverage = {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
  };
  for (const value of values) {
    if (value === null) continue;
    output.filesCovered += value.filesCovered;
    output.filesSkipped += value.filesSkipped;
    output.filesIgnored += value.filesIgnored;
    output.filesFailed += value.filesFailed;
    output.resolved += value.resolved;
    output.unresolved += value.unresolved;
    output.unmapped += value.unmapped;
    output.filteredInternal += value.filteredInternal;
  }
  return output;
}

function classifyDiffItem(item: SurfaceDiffItem): Finding | null {
  const symbolId = item.evidence.symbolId;
  if (item.severity === 'internal') return null;
  if (item.severity === 'breaking') {
    return makeFinding({
      severity: 'error',
      code: 'surface-breaking',
      category: 'surface',
      file: item.entryPath ?? '',
      line: 0,
      symbolId,
      evidence: item,
      suggestion: 'A public contract is breaking; approve it explicitly and update the baseline.',
      origin: 'introduced',
      blockable: true,
    });
  }
  if (item.severity === 'additive') {
    return makeFinding({
      severity: 'warning',
      code: 'surface-additive',
      category: 'surface',
      file: item.entryPath ?? '',
      line: 0,
      symbolId,
      evidence: item,
      suggestion: 'Additive Surface change; verify that the baseline and docs are updated.',
      origin: 'introduced',
      blockable: true,
    });
  }
  if (item.severity === 'ambiguous') {
    return makeFinding({
      severity: 'warning',
      code: 'surface-ambiguous',
      category: 'surface',
      file: item.entryPath ?? '',
      line: 0,
      symbolId,
      evidence: item,
      suggestion: 'Ambiguous Surface change; a human must decide before merging.',
      origin: 'introduced',
      blockable: true,
    });
  }
  return null;
}

function securityExit(input: { failOn: FailOn; findings: readonly Finding[] }): {
  blocking: boolean;
  warnings: number;
  code: number;
} {
  const warnings = input.findings.filter(
    (finding) =>
      finding.severity === 'warning' &&
      finding.code !== 'verify-skipped-unauthorized' &&
      finding.code !== 'index-stale',
  ).length;
  if (input.failOn === 'none') return { blocking: false, warnings, code: 0 };
  const threshold = FAIL_ON_ORDER.indexOf(input.failOn);
  const blocks = (finding: Finding): boolean => {
    if (!finding.blockable) return false;
    if (finding.code === 'surface-breaking') return true;
    if (finding.code === 'architecture-violation') return true;
    if (finding.code === 'verify-failed') return true;
    if (finding.code === 'surface-additive') return threshold >= 1;
    if (finding.code === 'surface-ambiguous') return threshold >= 2;
    if (finding.severity === 'warning') return threshold >= 3;
    return false;
  };
  const blocking = input.findings.some(blocks);
  if (blocking) return { blocking: true, warnings, code: 1 };
  return { blocking: false, warnings, code: warnings > 0 ? 2 : 0 };
}

export async function runPostflight(options: PostflightOptions): Promise<PostflightData> {
  const failOn = options.failOn ?? 'breaking';
  if (!FAIL_ON_ORDER.includes(failOn)) {
    throw nexusError('E00', 'invalid --fail-on value', {
      reason: `expected ${FAIL_ON_ORDER.join('|')}, received ${JSON.stringify(failOn)}`,
      suggestion: 'Use --fail-on breaking|additive|ambiguous|warning|none.',
    });
  }
  const projectRoot = options.projectRoot;
  assertGitWorkTree(projectRoot);
  const base = resolveBase(projectRoot, options.base);
  const context = await prepareContext(options);
  const selection = selectScope(context, options);
  const changes = diffNameStatus(projectRoot, base);
  const notes: string[] = [];
  const findings: Finding[] = [];
  const changedSymbols: ChangedSymbol[] = [];
  const unidentified: Array<{ rootId: string; path: string; reason: string }> = [];
  const changedFiles: PostflightData['changed']['files'] = [];
  const dependencyChanges: PostflightData['dependencyChanges'] = [];
  const surfaceDiff = {
    breaking: [] as SurfaceDiffItem[],
    additive: [] as SurfaceDiffItem[],
    internal: [] as SurfaceDiffItem[],
    ambiguous: [] as SurfaceDiffItem[],
  };
  const blindSpots: BlindSpot[] = [];
  const verificationCommands: VerifyCommandResult[] = [];
  const verificationSkipped: Array<{ id: string; reason: string }> = [];
  const rootsById = new Map(selection.roots.map((root) => [root.rootId, root]));
  const stale = selection.staleRoots.length > 0;
  let indexUnavailable = false;

  const changedByRoot = new Map<string, GitChange[]>();
  for (const change of changes) {
    const root = selectRootForFile(selection.roots, change.file);
    if (root === null) continue;
    const list = changedByRoot.get(root.rootId) ?? [];
    list.push(change);
    changedByRoot.set(root.rootId, list);
  }

  for (const [rootId, rootChanges] of changedByRoot) {
    const root = rootsById.get(rootId);
    if (root === undefined) continue;
    const store = openReadStore(databasePath(projectRoot, rootId));
    if (store === null) {
      indexUnavailable = true;
      notes.push(`root ${rootId}: index unavailable; changed symbols cannot be resolved`);
      for (const change of rootChanges) {
        unidentified.push({ rootId, path: change.file, reason: 'index-unavailable' });
      }
      continue;
    }
    try {
      const manifest = readManifest(manifestPath(projectRoot, rootId));
      if (Array.isArray(manifest.manifest?.blindSpots)) {
        blindSpots.push(...manifest.manifest.blindSpots);
      }
      const touchedFiles = new Set<string>();
      for (const change of rootChanges) {
        const file = change.file;
        touchedFiles.add(file);
        if (change.oldPath !== null) touchedFiles.add(change.oldPath);
        const ranges = change.status === 'D' ? [] : diffLineRanges(projectRoot, base, file);
        const currentSymbols = change.status === 'D' ? [] : readSymbolsForFile(store, file);
        const oldSymbols =
          change.status === 'A' ? [] : readSymbolsForFile(store, change.oldPath ?? file);
        const symbols: ChangedSymbol[] = [];
        if (change.status === 'A') {
          for (const symbol of currentSymbols) {
            symbols.push({
              rootId,
              symbolId: symbol.symbolId,
              name: symbol.name,
              nameChain: symbol.nameChain,
              kind: symbol.kind,
              path: symbol.path,
              line: symbol.declarationLocator.startLine,
              col: symbol.declarationLocator.startCol,
              change: 'added',
              relationClass: 'certain',
              confidence: 'direct',
            });
          }
        } else if (change.status === 'D') {
          for (const symbol of oldSymbols) {
            symbols.push({
              rootId,
              symbolId: symbol.symbolId,
              name: symbol.name,
              nameChain: symbol.nameChain,
              kind: symbol.kind,
              path: change.oldPath ?? symbol.path,
              line: symbol.declarationLocator.startLine,
              col: symbol.declarationLocator.startCol,
              change: 'removed',
              relationClass: 'certain',
              confidence: 'direct',
            });
          }
          if (oldSymbols.length === 0) {
            unidentified.push({
              rootId,
              path: change.oldPath ?? file,
              reason: 'no-indexed-symbols',
            });
          }
        } else {
          for (const symbol of currentSymbols) {
            if (ranges.length === 0 || overlaps(symbol, ranges)) {
              symbols.push({
                rootId,
                symbolId: symbol.symbolId,
                name: symbol.name,
                nameChain: symbol.nameChain,
                kind: symbol.kind,
                path: symbol.path,
                line: symbol.declarationLocator.startLine,
                col: symbol.declarationLocator.startCol,
                change: change.status === 'R' ? 'added' : 'modified',
                relationClass: 'certain',
                confidence: 'direct',
              });
            }
          }
          if (currentSymbols.length === 0) {
            unidentified.push({ rootId, path: file, reason: 'no-indexed-symbols' });
          } else if (symbols.length === 0 && ranges.length > 0) {
            unidentified.push({ rootId, path: file, reason: 'line-range-not-mapped' });
          }
          if (change.status === 'R' && change.oldPath !== null) {
            for (const symbol of oldSymbols) {
              symbols.push({
                rootId,
                symbolId: symbol.symbolId,
                name: symbol.name,
                nameChain: symbol.nameChain,
                kind: symbol.kind,
                path: change.oldPath,
                line: symbol.declarationLocator.startLine,
                col: symbol.declarationLocator.startCol,
                change: 'removed',
                relationClass: 'certain',
                confidence: 'direct',
              });
            }
          }
        }
        changedSymbols.push(...symbols);
        changedFiles.push({
          rootId,
          path: file,
          oldPath: change.oldPath,
          status: change.status,
          lines: ranges,
          symbols: symbols.length,
        });

        // Dependency delta is syntax-level; Vue SFC and non-TS files are not claimed.
        const oldPath = change.oldPath ?? file;
        const oldText = change.status === 'A' ? null : showFileAtRef(projectRoot, base, oldPath);
        const newText = change.status === 'D' ? null : readWorkingFile(projectRoot, file);
        const oldSpecifiers = oldText === null ? null : specifiersOf(oldText, oldPath);
        const newSpecifiers = newText === null ? null : specifiersOf(newText, file);
        if (oldSpecifiers !== null || newSpecifiers !== null) {
          const oldSet = new Set(oldSpecifiers ?? []);
          const newSet = new Set(newSpecifiers ?? []);
          const added = [...newSet].filter((entry) => !oldSet.has(entry)).sort();
          const removed = [...oldSet].filter((entry) => !newSet.has(entry)).sort();
          if (added.length > 0 || removed.length > 0) {
            dependencyChanges.push({
              rootId,
              file,
              oldPath: change.oldPath,
              added,
              removed,
              note: 'ts-ast-syntax; literal specifiers only, no checker resolution',
            });
          }
        } else if (change.status !== 'D') {
          notes.push(`dependency delta not computed for ${file} (unsupported syntax)`);
        }

        // Style deletion/rename with static consumers.
        if ((change.status === 'D' || change.status === 'R') && isStyle(oldPath)) {
          const all = readDependencies(store, { limit: 20000 });
          const consumers = all.filter(
            (dependency) =>
              dependency.targetFile === oldPath ||
              (dependency.depType.startsWith('style-') &&
                dependency.unresolvedReason === 'not-found' &&
                dependency.specifier.includes(path.posix.basename(oldPath))),
          );
          if (consumers.length > 0) {
            findings.push(
              makeFinding({
                severity: 'warning',
                code: 'style-removed-with-consumers',
                category: 'style',
                file: oldPath,
                line: 0,
                symbolId: null,
                evidence: {
                  consumers: consumers.slice(0, 20).map((dependency) => ({
                    sourceFile: dependency.sourceFile,
                    line: dependency.line,
                    depType: dependency.depType,
                    confidence: dependency.confidence,
                  })),
                  count: consumers.length,
                  note: 'style capability is file-level; selectors are not analyzed',
                },
                suggestion: `Update or remove ${consumers.length} static consumer(s), or pass --fail-on warning to make this blocking.`,
                origin: 'introduced',
                blockable: true,
              }),
            );
          }
        }
      }

      // Surface diff at the requested base.
      try {
        const diff = diffCurrentSurface({
          projectRoot,
          loadedConfig: context.loadedConfig,
          rootId,
          base,
        });
        for (const item of diff.diff.items) {
          surfaceDiff[item.severity].push(item);
          const finding = classifyDiffItem(item);
          if (finding !== null) findings.push(finding);
        }
      } catch (error) {
        findings.push(
          makeFinding({
            severity: 'warning',
            code: 'surface-diff-unavailable',
            category: 'surface',
            file: '',
            line: 0,
            symbolId: null,
            evidence: { reason: error instanceof Error ? error.message : String(error) },
            suggestion: 'Commit or regenerate the baseline, then rerun postflight.',
            origin: 'pre-existing',
            blockable: false,
          }),
        );
      }

      // Architecture violations introduced vs pre-existing by changed line ranges.
      const violations = readArchitectureViolations(store);
      const linesByFile = new Map(
        changedFiles
          .filter((entry) => entry.rootId === rootId)
          .map((entry) => [entry.path, entry.lines]),
      );
      for (const violation of violations) {
        if (!touchedFiles.has(violation.sourceFile) && !touchedFiles.has(violation.targetFile))
          continue;
        const ranges = linesByFile.get(violation.sourceFile) ?? [];
        const introduced = ranges.some(
          (range) => violation.line >= range.start && violation.line <= range.end,
        );
        findings.push(
          makeFinding({
            severity: 'error',
            code: 'architecture-violation',
            category: 'architecture',
            file: violation.sourceFile,
            line: violation.line,
            symbolId: null,
            evidence: violation,
            suggestion: `Remove the ${violation.fromModule} -> ${violation.toModule} dependency or approve the rule change.`,
            origin: introduced ? 'introduced' : 'pre-existing',
            blockable: true,
          }),
        );
      }

      // Test coverage for changed (non-removed) symbols.
      const coveredSymbols = new Set<string>();
      for (const symbol of changedSymbols.filter((entry) => entry.rootId === rootId)) {
        if (symbol.symbolId === null || symbol.change === 'removed') continue;
        const tests = readTestsForSymbol(store, symbol.symbolId);
        if (tests.length > 0) {
          coveredSymbols.add(symbol.symbolId);
          continue;
        }
        findings.push(
          makeFinding({
            severity: 'warning',
            code: 'test-coverage-missing',
            category: 'test',
            file: symbol.path,
            line: symbol.line,
            symbolId: symbol.symbolId,
            evidence: { name: symbol.name, change: symbol.change },
            suggestion:
              'Add or update a test that references this symbol; no relation was found in the index.',
            origin: 'introduced',
            blockable: false,
          }),
        );
      }
      void coveredSymbols;
      // 13.2 #11: a heuristic consumer caps confidence at medium and must never
      // trigger an automatic --fail-on block.
      for (const symbol of changedSymbols.filter(
        (entry) => entry.rootId === rootId && entry.symbolId !== null && entry.change !== 'removed',
      )) {
        const heuristic = readReferencesTo(store, symbol.symbolId as string).filter(
          (reference) => reference.relationClass === 'heuristic',
        );
        if (heuristic.length === 0) continue;
        findings.push(
          makeFinding({
            severity: 'warning',
            code: 'heuristic-consumer',
            category: 'index',
            file: symbol.path,
            line: symbol.line,
            symbolId: symbol.symbolId,
            evidence: {
              count: heuristic.length,
              samples: heuristic.slice(0, 5).map((reference) => ({
                path: reference.sourceFile,
                line: reference.line,
                confidence: reference.confidence,
              })),
            },
            suggestion:
              'Heuristic consumers are capped at medium confidence; confirm them manually before blocking a change.',
            origin: 'pre-existing',
            blockable: false,
          }),
        );
      }
    } finally {
      store.db.close();
    }
  }

  // The report is only as fresh as the index it reads.
  if (stale) {
    findings.push(
      makeFinding({
        severity: 'warning',
        code: 'index-stale',
        category: 'index',
        file: '',
        line: 0,
        symbolId: null,
        evidence: { staleRoots: selection.staleRoots, failedRoots: selection.failedRoots },
        suggestion: 'Run `nex build` (or `nex update` in Phase 06) before relying on the audit.',
        origin: 'pre-existing',
        blockable: false,
      }),
    );
  }

  // Authorized static checks (13.2 #8); run once for the workspace, not once
  // per root, and never block on an unauthorized command.
  if (
    context.loadedConfig !== null &&
    context.loadedConfig.config !== null &&
    context.loadedConfig.config.commands.allow.length > 0
  ) {
    const result = await runVerify({
      projectRoot,
      config: context.loadedConfig.config,
      only: options.only,
      yes: options.yes,
      explicit: options.explicitVerify === true,
      purpose: 'postflight',
      onEcho: (line) => notes.push(line),
    });
    verificationCommands.push(...result.commands);
    verificationSkipped.push(...result.skipped);
    for (const command of result.commands) {
      if (command.status === 'failed' || command.status === 'timedOut') {
        findings.push(
          makeFinding({
            severity: 'error',
            code: 'verify-failed',
            category: 'verify',
            file: command.cwd,
            line: 0,
            symbolId: null,
            evidence: command,
            suggestion: `Fix the failing command or remove it from commands.allow: ${command.cmd} ${command.args.join(' ')}`,
            origin: 'introduced',
            blockable: true,
          }),
        );
      }
    }
    for (const skipped of result.skipped) {
      findings.push(
        makeFinding({
          severity: 'warning',
          code: 'verify-skipped-unauthorized',
          category: 'verify',
          file: '',
          line: 0,
          symbolId: null,
          evidence: skipped,
          suggestion: 'Authorize with `nex verify --yes` when you intend to run this command.',
          origin: 'pre-existing',
          blockable: false,
        }),
      );
    }
  }

  if (changes.length === 0) {
    notes.push(`no tracked changes against ${base}; postflight has nothing to audit`);
  }
  const missingRoots = changes.filter(
    (change) => selectRootForFile(selection.roots, change.file) === null,
  );
  if (missingRoots.length > 0) {
    notes.push(`${missingRoots.length} changed file(s) are outside every selected root`);
  }

  const coverage = coverageAggregate(selection.roots.map((root) => root.coverage));
  const severities = new Set(findings.map((finding) => finding.severity));
  const verificationFailed = findings.some((finding) => finding.code === 'verify-failed');
  const confidence =
    stale || indexUnavailable || unidentified.length > 0 || verificationFailed
      ? 'low'
      : findings.some(
            (finding) =>
              finding.code === 'surface-ambiguous' ||
              finding.code === 'surface-diff-unavailable' ||
              finding.code === 'heuristic-consumer' ||
              finding.code === 'test-coverage-missing',
          )
        ? 'medium'
        : 'high';
  const exit = securityExit({ failOn, findings });
  const counts: Counts = {
    total: changedSymbols.length,
    returned: changedSymbols.length,
    certain: changedSymbols.filter((symbol) => symbol.change !== 'removed').length,
    heuristic: 0,
    dynamicUnresolved: 0,
    partial: stale || indexUnavailable ? changedSymbols.length : 0,
  };
  const riskLevel: PostflightData['risk']['level'] = exit.blocking
    ? findings.some((finding) => finding.code === 'surface-breaking')
      ? 'Critical'
      : 'High'
    : severities.has('warning')
      ? 'Medium'
      : 'Low';
  return {
    command: 'postflight',
    base,
    scope: selection.scope,
    buildFingerprint:
      selection.roots.length === 1 ? (selection.roots[0]?.buildFingerprint ?? null) : null,
    staleness: stale
      ? 'stale'
      : selection.roots.some((root) => root.staleness !== 'fresh')
        ? 'stale'
        : 'fresh',
    mode: selection.roots.some((root) => root.degraded.includes('syntax-only'))
      ? 'syntax-only'
      : 'normal',
    confidence,
    findings: findings.sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        left.code.localeCompare(right.code) ||
        left.file.localeCompare(right.file) ||
        left.line - right.line,
    ),
    surfaceDiff,
    coverage,
    blindSpots,
    verification: { commands: verificationCommands, skipped: verificationSkipped },
    changed: { files: changedFiles, symbols: changedSymbols, unidentified },
    dependencyChanges,
    counts,
    risk: {
      level: riskLevel,
      reasons: [
        `${findings.filter((finding) => finding.origin === 'introduced').length} introduced finding(s)`,
        `${findings.filter((finding) => finding.origin === 'pre-existing').length} pre-existing finding(s)`,
        `${unidentified.length} unidentified file(s)`,
      ],
    },
    exit: { failOn, ...exit },
    warnings: [
      ...findings
        .filter((finding) => finding.severity === 'warning')
        .map((finding) => ({
          code: finding.code,
          message: `${finding.file === '' ? '' : `${finding.file}: `}${finding.suggestion}`,
          severity: 'warning' as const,
        })),
      ...context.warnings,
    ],
    notes,
    scopeRoots: selection.roots.map((root) => root.rootId),
    staleRoots: selection.staleRoots,
    failedRoots: selection.failedRoots,
    completeness:
      selection.staleRoots.length === 0 && selection.failedRoots.length === 0
        ? 'complete'
        : 'partial',
  };
}
