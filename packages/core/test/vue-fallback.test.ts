import { describe, expect, it } from 'vitest';

import type { VueDeclaration } from '../src/vue/declarations.js';
import { computeLineStarts, type VueProjection } from '../src/vue/project.js';
import { collectTemplateFallbackEdges } from '../src/vue/template-fallback.js';

function declaration(
  source: string,
  overrides: Partial<VueDeclaration> & {
    name: string;
    startOffset: number;
    endOffset: number;
  },
): VueDeclaration {
  const startLine = source.slice(0, overrides.startOffset).split('\n').length;
  return {
    rootId: 'root',
    path: 'src/App.vue',
    name: overrides.name,
    nameChain: overrides.name,
    kind: 'var',
    startLine,
    startCol: 0,
    endLine: startLine,
    endCol: 0,
    nameLine: startLine,
    nameCol: 0,
    startOffset: overrides.startOffset,
    endOffset: overrides.endOffset,
    signature: '',
    structuralFingerprint: '',
    containerLocatorKey: '',
    overloadOrdinal: 0,
    isExported: false,
    isDefault: false,
    exportKind: 'none',
    visibility: 'module-local',
    isTypeOnly: false,
    isAnonymous: false,
    syntaxContextHash: '',
    sourceHash: '',
    generatedAnchor: null,
    isImport: false,
    syntheticComponent: false,
    componentMember: false,
    ...overrides,
  };
}

describe('Vue template fallback', () => {
  it('recovers missing prop and member-expression edges', () => {
    const source = `<script setup lang="ts">
interface CardProps { title: string; count?: number }
const formatter: Formatter = { save: (value: number) => String(value) };
</script>
<template>
  <p>{{ title }}</p>
  <p>{{ count }}</p>
  <p>{{ formatter.save(count) }}</p>
</template>
`;
    const templateStart = source.indexOf('<template>');
    const interpolation = (expression: string): { start: number; end: number } => {
      const start = source.indexOf(`{{ ${expression} }}`) + '{{ '.length;
      return { start, end: start + expression.length };
    };
    const titleRange = interpolation('title');
    const countRange = interpolation('count');
    const expressionRange = interpolation('formatter.save(count)');
    const projection = {
      path: 'src/App.vue',
      source,
      sourceLineStarts: computeLineStarts(source),
      templateRange: { start: templateStart, end: source.length },
      templateRanges: [
        { kind: 'interpolation', ...titleRange, directive: null },
        { kind: 'interpolation', ...countRange, directive: null },
        { kind: 'interpolation', ...expressionRange, directive: null },
      ],
    } as unknown as VueProjection;

    const formatterStart = source.indexOf('formatter:');
    const formatter = declaration(source, {
      name: 'formatter',
      startOffset: formatterStart,
      endOffset: source.indexOf(';', formatterStart),
    });

    const edges = collectTemplateFallbackEdges({
      projection,
      declarations: [formatter],
      declarationSymbolId: new Map([[formatter, 'sym-formatter']]),
      propMembers: new Map([
        ['title', 'sym-title'],
        ['count', 'sym-count'],
      ]),
      propRequired: new Map([
        ['title', true],
        ['count', false],
      ]),
      propTypes: new Map([
        ['title', 'string'],
        ['count', 'number'],
      ]),
      memberTargets: new Map([['Formatter.save', 'sym-save']]),
      coveredPositions: new Set(),
    });

    expect(
      edges.map((edge) => ({
        offset: edge.sourceOffset,
        target: edge.targetSymbolId,
        relationClass: edge.relationClass,
      })),
    ).toEqual([
      { offset: titleRange.start, target: 'sym-title', relationClass: 'certain' },
      { offset: countRange.start, target: 'sym-count', relationClass: 'heuristic' },
      { offset: expressionRange.start, target: 'sym-formatter', relationClass: 'certain' },
      {
        offset: source.indexOf('save(count)'),
        target: 'sym-save',
        relationClass: 'heuristic',
      },
      {
        offset: source.indexOf('save(count)') + 'save('.length,
        target: 'sym-count',
        relationClass: 'heuristic',
      },
    ]);
  });

  it('leaves positions already covered by SCIP untouched', () => {
    const source = '<template>{{ title }}</template>\n';
    const start = source.indexOf('title');
    const projection = {
      path: 'src/App.vue',
      source,
      sourceLineStarts: computeLineStarts(source),
      templateRange: { start: 0, end: source.length },
      templateRanges: [
        { kind: 'interpolation', start, end: start + 'title'.length, directive: null },
      ],
    } as unknown as VueProjection;

    const edges = collectTemplateFallbackEdges({
      projection,
      declarations: [],
      declarationSymbolId: new Map(),
      propMembers: new Map([['title', 'sym-title']]),
      propRequired: new Map([['title', true]]),
      propTypes: new Map([['title', 'string']]),
      memberTargets: new Map(),
      coveredPositions: new Set([`1:${start}`]),
    });

    expect(edges).toEqual([]);
  });
});
