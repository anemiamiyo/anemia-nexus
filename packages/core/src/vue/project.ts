import fs from 'node:fs';
import path from 'node:path';

import type { VirtualCode } from '@volar/language-core';
import type { VueVirtualCode } from '@vue/language-core';
import { createVueLanguagePlugin, getDefaultCompilerOptions } from '@vue/language-core';
import { parse as parseTemplate } from '@vue/compiler-dom';
import ts from 'typescript';

import { contentHash } from '../util/hash.js';
import { VUE_LANGUAGE_CORE_VERSION, VUE_PROJECTOR_VERSION } from '../index/analyzer.js';

/** One `generated offset ↔ source offset` segment from Volar's mappings. */
export interface MappingSegment {
  generated: number;
  generatedLength: number;
  source: number;
  sourceLength: number;
}

export interface TemplateRange {
  kind: 'tag' | 'binding' | 'interpolation' | 'dynamic-arg';
  start: number;
  end: number;
  directive: string | null;
}

export interface VueProjection {
  /** Project-relative POSIX path (`.vue`). */
  path: string;
  /** Root-relative POSIX path (used to mirror the shadow tree). */
  rootRelativePath: string;
  source: string;
  sourceHash: string;
  generated: string;
  generatedBytes: number;
  segments: MappingSegment[];
  sourceLineStarts: number[];
  generatedLineStarts: number[];
  templateRange: { start: number; end: number } | null;
  templateRanges: TemplateRange[];
  hasScript: boolean;
  hasScriptSetup: boolean;
  componentName: string;
  projectorVersion: string;
  languageCoreVersion: string;
}

export interface VueProjectionError {
  path: string;
  reason: string;
}

export type VueProjectionResult =
  { ok: true; projection: VueProjection } | { ok: false; error: VueProjectionError };

interface TemplateAstNode {
  type: number;
  tag?: string;
  loc: { start: { offset: number }; end: { offset: number } };
  props?: Array<{
    type: number;
    name: string;
    arg?: {
      isStatic?: boolean;
      content?: string;
      loc?: { start: { offset: number }; end: { offset: number } };
    };
    exp?: { content?: string; loc?: { start: { offset: number }; end: { offset: number } } };
  }>;
  children?: TemplateAstNode[];
  content?: { loc?: { start: { offset: number }; end: { offset: number } } };
}

const NODE_ELEMENT = 1;
const NODE_INTERPOLATION = 5;
const PROP_DIRECTIVE = 7;

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function offsetToPosition(
  lineStarts: readonly number[],
  offset: number,
): { line: number; col: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if ((lineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, col: offset - (lineStarts[low] as number) };
}

export function positionToOffset(lineStarts: readonly number[], line: number, col: number): number {
  const start = lineStarts[line - 1] ?? 0;
  return start + col;
}

/** Converts a UTF-8 byte column (SCIP) to a UTF-16 code-unit column. */
export function utf8ColumnToUtf16(lineText: string, byteColumn: number): number {
  if (byteColumn <= 0) return 0;
  let bytes = 0;
  let units = 0;
  for (const character of lineText) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > byteColumn) break;
    bytes += size;
    units += character.length;
    if (bytes === byteColumn) return units;
  }
  return units;
}

function findEmbeddedCode(code: VirtualCode, id: string): VirtualCode | null {
  const stack: VirtualCode[] = [code];
  while (stack.length > 0) {
    const current = stack.pop() as VirtualCode;
    if (current.id === id) return current;
    for (const child of current.embeddedCodes ?? []) stack.push(child);
  }
  return null;
}

function buildSegments(code: VirtualCode): MappingSegment[] {
  const segments: MappingSegment[] = [];
  for (const mapping of code.mappings) {
    const count = mapping.generatedOffsets.length;
    for (let index = 0; index < count; index += 1) {
      const generated = mapping.generatedOffsets[index];
      const source = mapping.sourceOffsets[index] ?? mapping.sourceOffsets[0];
      if (typeof generated !== 'number' || typeof source !== 'number') continue;
      const length = mapping.lengths[index] ?? 0;
      const generatedLength = mapping.generatedLengths?.[index] ?? length;
      const sourceLength = mapping.lengths[index] ?? length;
      if (generatedLength <= 0) continue;
      segments.push({
        generated,
        generatedLength,
        source,
        sourceLength: Math.max(sourceLength, 0),
      });
    }
  }
  segments.sort((left, right) => left.generated - right.generated);
  return segments;
}

function buildTemplateRanges(
  source: string,
  content: string,
  base: number,
): { ranges: TemplateRange[]; templateRange: { start: number; end: number } } {
  const ast = parseTemplate(content) as unknown as TemplateAstNode;
  const ranges: TemplateRange[] = [];
  const visit = (node: TemplateAstNode): void => {
    if (node.type === NODE_ELEMENT) {
      const nodeStart = base + node.loc.start.offset;
      if (typeof node.tag === 'string' && node.tag !== '') {
        ranges.push({
          kind: 'tag',
          start: nodeStart + 1,
          end: nodeStart + 1 + node.tag.length,
          directive: null,
        });
      }
      for (const prop of node.props ?? []) {
        if (prop.type !== PROP_DIRECTIVE) continue;
        if (prop.exp?.loc !== undefined) {
          const expressionStart = base + prop.exp.loc.start.offset;
          const expressionEnd = base + prop.exp.loc.end.offset;
          if (expressionEnd > expressionStart) {
            ranges.push({
              kind: 'binding',
              start: expressionStart,
              end: expressionEnd,
              directive: prop.name,
            });
          }
        }
        if (prop.arg?.isStatic === false && prop.arg.loc !== undefined) {
          const argumentStart = base + prop.arg.loc.start.offset;
          const argumentEnd = base + prop.arg.loc.end.offset;
          if (argumentEnd > argumentStart) {
            ranges.push({
              kind: 'dynamic-arg',
              start: argumentStart,
              end: argumentEnd,
              directive: prop.name,
            });
          }
        }
      }
    } else if (node.type === NODE_INTERPOLATION && node.content?.loc !== undefined) {
      const start = base + node.content.loc.start.offset;
      const end = base + node.content.loc.end.offset;
      if (end > start) ranges.push({ kind: 'interpolation', start, end, directive: null });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(ast);
  ranges.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.end !== right.end) return left.end - right.end;
    return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
  });
  void source;
  return { ranges, templateRange: { start: base, end: base + content.length } };
}

function templateContent(
  descriptor: { template?: { content?: string; loc?: { start?: { offset?: number } } } } | null,
): { content: string; base: number } | null {
  const template = descriptor?.template;
  if (template === null || template === undefined) return null;
  const content = template.content ?? '';
  if (content === '') return null;
  return { content, base: template.loc?.start?.offset ?? 0 };
}

export interface ProjectVueOptions {
  projectRoot: string;
  rootAbsolutePath: string;
  filePath: string;
  /** Real tsconfig options; language-core uses them for macro code generation. */
  compilerOptions?: ts.CompilerOptions;
}

/**
 * Projects one SFC to its virtual TS code and keeps the offset mapping in
 * memory (docs/04-architecture.md 4.1.1). No shadow file is written here.
 */
export function projectVueFile(options: ProjectVueOptions): VueProjectionResult {
  const absolute = path.resolve(options.filePath);
  const relative = path.relative(options.projectRoot, absolute).split(path.sep).join('/');
  const rootRelative = path.relative(options.rootAbsolutePath, absolute).split(path.sep).join('/');
  try {
    const source = fs.readFileSync(absolute, 'utf8');
    const plugin = createVueLanguagePlugin(
      ts,
      options.compilerOptions ?? {},
      getDefaultCompilerOptions(),
      (id: string) => id,
    );
    if (plugin.createVirtualCode === undefined) {
      return {
        ok: false,
        error: { path: relative, reason: 'language-core plugin has no createVirtualCode hook' },
      };
    }
    const virtualCode = plugin.createVirtualCode(
      absolute,
      'vue',
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    ) as VueVirtualCode | undefined;
    if (virtualCode === undefined) {
      return {
        ok: false,
        error: { path: relative, reason: 'language-core returned no virtual code' },
      };
    }
    const scriptCode = findEmbeddedCode(virtualCode, 'script_ts');
    if (scriptCode === null) {
      return { ok: false, error: { path: relative, reason: 'projection has no script_ts code' } };
    }
    const generated = scriptCode.snapshot.getText(0, scriptCode.snapshot.getLength());
    const descriptor = virtualCode.vueSfc?.descriptor ?? null;
    const template = templateContent(
      descriptor as {
        template?: { content?: string; loc?: { start?: { offset?: number } } };
      } | null,
    );
    const templateRanges =
      template === null
        ? { ranges: [], templateRange: null }
        : {
            ranges: buildTemplateRanges(source, template.content, template.base).ranges,
            templateRange: { start: template.base, end: template.base + template.content.length },
          };
    return {
      ok: true,
      projection: {
        path: relative,
        rootRelativePath: rootRelative,
        source,
        sourceHash: contentHash(source),
        generated,
        generatedBytes: Buffer.byteLength(generated, 'utf8'),
        segments: buildSegments(scriptCode),
        sourceLineStarts: computeLineStarts(source),
        generatedLineStarts: computeLineStarts(generated),
        templateRange: templateRanges.templateRange,
        templateRanges: templateRanges.ranges,
        hasScript: descriptor?.script !== null && descriptor?.script !== undefined,
        hasScriptSetup: descriptor?.scriptSetup !== null && descriptor?.scriptSetup !== undefined,
        componentName: path.basename(absolute, '.vue'),
        projectorVersion: VUE_PROJECTOR_VERSION,
        languageCoreVersion: VUE_LANGUAGE_CORE_VERSION,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: { path: relative, reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

function findSegment(segments: readonly MappingSegment[], offset: number): MappingSegment | null {
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((segments[mid] as MappingSegment).generated <= offset) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return null;
  for (let index = candidate; index >= 0; index -= 1) {
    const segment = segments[index] as MappingSegment;
    if (offset < segment.generated) continue;
    if (offset < segment.generated + segment.generatedLength) return segment;
    // Sorted by generated; earlier segments cannot cover a later offset unless
    // they overlap, so one extra probe is enough in practice.
    if (segment.generated + segment.generatedLength <= offset) break;
  }
  return null;
}

/** Generated UTF-16 offset -> source UTF-16 offset, or null when generated-only. */
export function generatedToSource(
  projection: VueProjection,
  generatedOffset: number,
): number | null {
  const segment = findSegment(projection.segments, generatedOffset);
  if (segment === null) return null;
  return segment.source + (generatedOffset - segment.generated);
}

/** Source UTF-16 offset -> generated UTF-16 offset, or null when not projected. */
export function sourceToGenerated(projection: VueProjection, sourceOffset: number): number | null {
  const segments = [...projection.segments].sort((left, right) => left.source - right.source);
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((segments[mid] as MappingSegment).source <= sourceOffset) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  for (let index = candidate; index >= 0; index -= 1) {
    const segment = segments[index] as MappingSegment;
    const length = Math.max(segment.sourceLength, 1);
    if (sourceOffset >= segment.source && sourceOffset < segment.source + length) {
      return segment.generated + (sourceOffset - segment.source);
    }
  }
  return null;
}

export interface MappedGeneratedPosition {
  sourceOffset: number;
  sourceLine: number;
  sourceCol: number;
}

/** Converts an SCIP generated position (line 0-based, UTF-8 byte column) to source. */
export function mapScipPosition(
  projection: VueProjection,
  generatedLine: number,
  generatedByteColumn: number,
): MappedGeneratedPosition | null {
  const lineStart = projection.generatedLineStarts[generatedLine];
  if (lineStart === undefined) return null;
  const lineEnd = projection.generatedLineStarts[generatedLine + 1] ?? projection.generated.length;
  const lineText = projection.generated.slice(lineStart, lineEnd);
  const utf16Column = utf8ColumnToUtf16(lineText, generatedByteColumn);
  const generatedOffset = lineStart + utf16Column;
  const sourceOffset = generatedToSource(projection, generatedOffset);
  if (sourceOffset === null) return null;
  const position = offsetToPosition(projection.sourceLineStarts, sourceOffset);
  return { sourceOffset, sourceLine: position.line, sourceCol: position.col };
}

export function templateRangeAt(
  projection: VueProjection,
  sourceOffset: number,
): TemplateRange | null {
  let best: TemplateRange | null = null;
  for (const range of projection.templateRanges) {
    if (sourceOffset < range.start || sourceOffset >= range.end) continue;
    if (best === null || range.end - range.start < best.end - best.start) best = range;
    else if (
      best !== null &&
      range.end - range.start === best.end - best.start &&
      range.kind === 'dynamic-arg' &&
      best.kind !== 'dynamic-arg'
    ) {
      best = range;
    }
  }
  return best;
}

export function isInsideTemplate(projection: VueProjection, sourceOffset: number): boolean {
  const range = projection.templateRange;
  return range !== null && sourceOffset >= range.start && sourceOffset < range.end;
}
