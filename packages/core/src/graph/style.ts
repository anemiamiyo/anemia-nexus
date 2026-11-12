import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parse as parseSfc } from '@vue/compiler-sfc';

import type { DependencyRecord, DependencyType } from '../model.js';
import type { ScannedFile } from '../discovery/scan.js';
import { isStyleLanguage } from '../discovery/scan.js';
import { isInside, toPosix } from '../util/paths.js';

const STYLE_ANALYZER_VERSION = 'style-lexer@1';

export interface StyleExtractionInput {
  projectRoot: string;
  rootAbs: string;
  rootPath: string;
  rootId: string;
  styleFiles: readonly ScannedFile[];
  vueFiles: readonly ScannedFile[];
  program: ts.Program;
  aliases: Readonly<Record<string, string>>;
  extensions: readonly string[];
}

export interface StyleExtractionResult {
  dependencies: DependencyRecord[];
  files: number;
  edges: number;
  resolved: number;
  unresolved: number;
  unresolvedReasons: Record<string, number>;
}

interface Resolution {
  targetFile: string | null;
  resolution: 'direct' | 'heuristic' | 'unresolved';
  reason: string | null;
}

function stripComments(text: string, lineComments: boolean): string {
  const output = text.split('');
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 2;
      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          output[index] = ' ';
          output[index + 1] = ' ';
          index += 2;
          break;
        }
        if (text[index] !== '\n') output[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (lineComments && char === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        output[index] = ' ';
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return output.join('');
}

function lineColOf(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, col: offset - lineStart };
}

function stringInAtRule(rest: string): string | null {
  const quoted = /(["'])((?:\\.|(?!\1).)*)\1/.exec(rest);
  if (quoted !== null) return quoted[2] ?? null;
  const url = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/i.exec(rest);
  return url === null ? null : (url[2] ?? null);
}

interface RawStyleSpecifier {
  specifier: string;
  depType: DependencyType;
  line: number;
  col: number;
}

function styleAtRules(source: string, language: 'css' | 'scss' | 'less'): RawStyleSpecifier[] {
  const cleaned = stripComments(source, language !== 'css');
  const output: RawStyleSpecifier[] = [];
  const pattern = /(^|[;{}])\s*(@import|@use|@forward)\b([^;]*);?/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const keyword = (match[2] ?? '').toLowerCase();
    const rest = match[3] ?? '';
    const specifier = stringInAtRule(rest);
    if (specifier === null || specifier === '') continue;
    const at = (match.index ?? 0) + (match[1]?.length ?? 0) + match[2]!.length;
    let offset = at;
    while (offset < cleaned.length && /\s/.test(cleaned[offset] as string)) offset += 1;
    const position = lineColOf(cleaned, offset);
    output.push({
      specifier,
      depType:
        keyword === '@use'
          ? 'style-use'
          : keyword === '@forward'
            ? 'style-forward'
            : 'style-import',
      line: position.line,
      col: position.col,
    });
  }
  return output;
}

function candidateSpecifiers(specifier: string, extensions: readonly string[]): string[] {
  const output = [specifier];
  if (path.extname(specifier) === '') {
    const directory = path.posix.dirname(specifier);
    const base = path.posix.basename(specifier);
    const prefix = directory === '.' ? '' : `${directory}/`;
    for (const extension of extensions) {
      output.push(`${specifier}${extension}`);
      output.push(`${prefix}_${base}${extension}`);
    }
  } else {
    const directory = path.posix.dirname(specifier);
    const base = path.posix.basename(specifier);
    if (!base.startsWith('_')) {
      const prefix = directory === '.' ? '' : `${directory}/`;
      output.push(`${prefix}_${base}`);
    }
  }
  return output;
}

function resolveTarget(input: {
  specifier: string;
  fromPath: string;
  aliases: Readonly<Record<string, string>>;
  extensions: readonly string[];
  stylesByPath: ReadonlyMap<string, ScannedFile>;
  projectRoot: string;
  rootAbs: string;
}): Resolution {
  const specifier = input.specifier.trim();
  if (specifier === '') return { targetFile: null, resolution: 'unresolved', reason: 'empty' };
  if (/^[a-z]+:/i.test(specifier) && !specifier.startsWith('sass:')) {
    return { targetFile: null, resolution: 'unresolved', reason: 'external-url' };
  }
  if (specifier.startsWith('//')) {
    return { targetFile: null, resolution: 'unresolved', reason: 'external-url' };
  }
  if (specifier.startsWith('sass:')) {
    return { targetFile: null, resolution: 'unresolved', reason: 'sass-builtin' };
  }
  if (specifier.includes('#{') || specifier.includes('$')) {
    return { targetFile: null, resolution: 'unresolved', reason: 'dynamic-path' };
  }
  if (specifier.startsWith('~')) {
    return { targetFile: null, resolution: 'unresolved', reason: 'external-package' };
  }

  let bases: Array<{ base: string; heuristic: boolean; reason: string | null }> = [];
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const sourceDir = path.posix.dirname(input.fromPath);
    bases = [
      {
        base: path.posix.normalize(path.posix.join(sourceDir, specifier)),
        heuristic: false,
        reason: null,
      },
    ];
  } else {
    const aliasKeys = Object.keys(input.aliases).sort((left, right) => right.length - left.length);
    let matched = false;
    for (const alias of aliasKeys) {
      if (specifier !== alias && !specifier.startsWith(`${alias}/`)) continue;
      const replacement = input.aliases[alias] as string;
      const rest = specifier === alias ? '' : specifier.slice(alias.length + 1);
      bases = [
        {
          base: path.posix.normalize(path.posix.join(replacement, rest)),
          heuristic: true,
          reason: null,
        },
      ];
      matched = true;
      break;
    }
    if (!matched) {
      if (specifier.startsWith('@') && !specifier.includes('/')) {
        return { targetFile: null, resolution: 'unresolved', reason: 'alias-unresolved' };
      }
      return { targetFile: null, resolution: 'unresolved', reason: 'external-package' };
    }
  }

  for (const base of bases) {
    for (const candidate of candidateSpecifiers(base.base, input.extensions)) {
      const normalized = candidate.replace(/^\.\//, '');
      if (
        normalized.startsWith('../') ||
        normalized === '..' ||
        path.posix.isAbsolute(normalized)
      ) {
        return { targetFile: null, resolution: 'unresolved', reason: 'outside-root' };
      }
      const found = input.stylesByPath.get(normalized);
      if (found !== undefined) {
        return {
          targetFile: found.path,
          resolution: base.heuristic ? 'heuristic' : 'direct',
          reason: null,
        };
      }
      const absolute = path.resolve(input.projectRoot, normalized);
      if (!isInside(input.projectRoot, absolute) || !isInside(input.rootAbs, absolute)) {
        return { targetFile: null, resolution: 'unresolved', reason: 'outside-root' };
      }
      if (fs.existsSync(absolute)) {
        // The file exists but is not part of the scanned set (ignore / size).
        return { targetFile: null, resolution: 'unresolved', reason: 'ignored' };
      }
    }
  }
  return { targetFile: null, resolution: 'unresolved', reason: 'not-found' };
}

function toDependency(input: {
  sourceFile: string;
  targetFile: string | null;
  resolution: 'direct' | 'heuristic' | 'unresolved';
  reason: string | null;
  depType: DependencyType;
  specifier: string;
  line: number;
  col: number;
  rootId: string;
  analysisEngine: string;
}): DependencyRecord {
  return {
    sourceFile: input.sourceFile,
    targetFile: input.targetFile,
    sourceRootId: input.rootId,
    targetRootId: input.resolution === 'unresolved' ? null : input.rootId,
    isCrossRoot: false,
    depType: input.depType,
    specifier: input.specifier,
    relationClass:
      input.resolution === 'unresolved'
        ? 'dynamic-unresolved'
        : input.resolution === 'heuristic'
          ? 'heuristic'
          : 'certain',
    confidence:
      input.resolution === 'unresolved'
        ? 'unresolved'
        : input.resolution === 'heuristic'
          ? 'heuristic'
          : 'direct',
    analysisEngine: input.analysisEngine,
    line: input.line,
    col: input.col,
    unresolvedReason: input.reason,
    evidence: {
      sourceOfTruth: input.analysisEngine,
      analysisVersion: STYLE_ANALYZER_VERSION,
      constraints: ['syntax-only', 'no-sass-compilation'],
      missReason: input.reason,
    },
  };
}

/**
 * S1 file-level style chain (docs/04-architecture.md 4.2). Style files never
 * produce symbols or references; only Dependency rows.
 */
export function extractStyleDependencies(input: StyleExtractionInput): StyleExtractionResult {
  const stylesByPath = new Map<string, ScannedFile>();
  for (const file of input.styleFiles) stylesByPath.set(file.path, file);
  const dependencies: DependencyRecord[] = [];
  const unresolvedReasons: Record<string, number> = {};
  const push = (dependency: DependencyRecord): void => {
    dependencies.push(dependency);
    if (dependency.unresolvedReason !== null) {
      unresolvedReasons[dependency.unresolvedReason] =
        (unresolvedReasons[dependency.unresolvedReason] ?? 0) + 1;
    }
  };

  for (const file of input.styleFiles) {
    if (!isStyleLanguage(file.language)) continue;
    let source: string;
    try {
      source = fs.readFileSync(file.absolutePath, 'utf8');
    } catch {
      continue;
    }
    for (const raw of styleAtRules(source, file.language)) {
      const resolution = resolveTarget({
        specifier: raw.specifier,
        fromPath: file.path,
        aliases: input.aliases,
        extensions: input.extensions,
        stylesByPath,
        projectRoot: input.projectRoot,
        rootAbs: input.rootAbs,
      });
      push(
        toDependency({
          sourceFile: file.path,
          targetFile: resolution.targetFile,
          resolution: resolution.resolution,
          reason: resolution.reason,
          depType: raw.depType,
          specifier: raw.specifier,
          line: raw.line,
          col: raw.col,
          rootId: input.rootId,
          analysisEngine: 'style-lexer',
        }),
      );
    }
  }

  // TS/JS side: `import "./x.css"` (4.2, analysisEngine script-side).
  for (const sourceFile of input.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isInside(input.rootAbs, sourceFile.fileName)) continue;
    const sourceRelative = toPosix(path.relative(input.projectRoot, sourceFile.fileName));
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const extension = path.extname(specifier).toLowerCase();
      if (!input.extensions.includes(extension)) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(
        statement.moduleSpecifier.getStart(sourceFile),
      );
      const resolution = resolveTarget({
        specifier,
        fromPath: sourceRelative,
        aliases: input.aliases,
        extensions: input.extensions,
        stylesByPath,
        projectRoot: input.projectRoot,
        rootAbs: input.rootAbs,
      });
      push(
        toDependency({
          sourceFile: sourceRelative,
          targetFile: resolution.targetFile,
          resolution: resolution.resolution,
          reason: resolution.reason,
          depType: 'style-import',
          specifier,
          line: position.line + 1,
          col: position.character,
          rootId: input.rootId,
          analysisEngine: 'script-side',
        }),
      );
    }
  }

  // Vue `<style src="...">` (4.2).
  for (const file of input.vueFiles) {
    let source: string;
    try {
      source = fs.readFileSync(file.absolutePath, 'utf8');
    } catch {
      continue;
    }
    let styles: ReadonlyArray<{ src?: string; loc?: { start: { line: number; column: number } } }>;
    try {
      const parsed = parseSfc(source, { filename: file.absolutePath });
      styles = parsed.descriptor.styles;
    } catch {
      continue;
    }
    for (const style of styles) {
      if (typeof style.src !== 'string' || style.src === '') continue;
      const resolution = resolveTarget({
        specifier: style.src,
        fromPath: file.path,
        aliases: input.aliases,
        extensions: input.extensions,
        stylesByPath,
        projectRoot: input.projectRoot,
        rootAbs: input.rootAbs,
      });
      push(
        toDependency({
          sourceFile: file.path,
          targetFile: resolution.targetFile,
          resolution: resolution.resolution,
          reason: resolution.reason,
          depType: 'style-src',
          specifier: style.src,
          line: style.loc?.start.line ?? 1,
          col: style.loc?.start.column ?? 0,
          rootId: input.rootId,
          analysisEngine: 'vue-sfc',
        }),
      );
    }
  }

  dependencies.sort((left, right) => {
    if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.col !== right.col) return left.col - right.col;
    if (left.depType !== right.depType) return left.depType < right.depType ? -1 : 1;
    return (left.targetFile ?? '') < (right.targetFile ?? '') ? -1 : 1;
  });
  const unique: DependencyRecord[] = [];
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.sourceFile}:${dependency.line}:${dependency.col}:${dependency.depType}:${dependency.targetFile ?? dependency.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dependency);
  }
  const resolved = unique.filter((entry) => entry.relationClass !== 'dynamic-unresolved').length;
  return {
    dependencies: unique,
    files: input.styleFiles.length,
    edges: unique.length,
    resolved,
    unresolved: unique.length - resolved,
    unresolvedReasons,
  };
}
