import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  buildWorkspace,
  loadConfig,
  queryReferences,
  statusReport,
  type ReferenceRecord,
} from 'anemia-core';

import { databasePath, readManifest } from '../src/store/manifest.js';
import { openReadStore, readComponent } from '../src/store/read.js';
import {
  generatedToSource,
  offsetToPosition,
  positionToOffset,
  projectVueFile,
  sourceToGenerated,
  type VueProjection,
} from '../src/vue/project.js';
import { cleanup, indexFixture, makeProject, initProject, REPO_ROOT } from './helpers.js';

const SELF = {
  serverVersion: '0.0.0',
  packageName: 'anemia-cli',
  binaryPath: 'main.js',
  projectRoot: '.',
  nodeVersion: process.versions.node,
};

interface GoldenSymbols {
  [file: string]: string[];
}

interface GoldenEdge {
  file: string;
  line: number;
  col: number;
  role: string;
  target: string;
  relationClass: string;
}

interface GoldenComponents {
  [file: string]: {
    props: Array<{ name: string; typeText: string; required: boolean; resolved: boolean }>;
    emits: string[];
    slots: string[];
    propsCoverage: { resolved: number; total: number; unresolved?: string[] };
  };
}

function readGolden<T>(directory: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(directory, 'expected', file), 'utf8')) as T;
}

interface VueSymbolRow {
  symbolId: string;
  path: string;
  kind: string;
  name: string;
  nameChain: string;
  startLine: number;
  startCol: number;
  nameLine: number;
  nameCol: number;
  mappingQuality: string;
}

function symbolRows(directory: string, rootId: string): VueSymbolRow[] {
  const store = openReadStore(databasePath(directory, rootId));
  if (store === null) throw new Error('no readable store');
  try {
    const rows = store.db
      .prepare(
        `select symbol_id, path, kind, name, name_chain, start_line, start_col, name_line, name_col, mapping_quality
         from symbols where build_id = ? and path like '%.vue' order by path, start_line, start_col`,
      )
      .all(store.build.buildId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      symbolId: String(row.symbol_id ?? ''),
      path: String(row.path ?? ''),
      kind: String(row.kind ?? ''),
      name: String(row.name ?? ''),
      nameChain: String(row.name_chain ?? ''),
      startLine: Number(row.start_line ?? 0),
      startCol: Number(row.start_col ?? 0),
      nameLine: Number(row.name_line ?? 0),
      nameCol: Number(row.name_col ?? 0),
      mappingQuality: String(row.mapping_quality ?? 'unmapped'),
    }));
  } finally {
    store.db.close();
  }
}

function vueReferenceRows(
  directory: string,
  rootId: string,
): Array<ReferenceRecord & { targetName: string | null }> {
  const store = openReadStore(databasePath(directory, rootId));
  if (store === null) throw new Error('no readable store');
  try {
    const rows = store.db
      .prepare(
        `select r.source_file, r.line, r.col, r.role, r.relation_class, r.confidence,
                r.target_symbol_id, r.source_symbol_id, r.analysis_engine, s.name_chain as target_name
         from "references" r
         left join symbols s on s.symbol_id = r.target_symbol_id and s.build_id = r.build_id
         where r.build_id = ? and r.role like 'template:%'
         order by r.source_file, r.line, r.col`,
      )
      .all(store.build.buildId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceFile: String(row.source_file ?? ''),
      line: Number(row.line ?? 0),
      col: Number(row.col ?? 0),
      role: String(row.role ?? ''),
      relationClass: String(row.relation_class ?? 'certain') as ReferenceRecord['relationClass'],
      confidence: String(row.confidence ?? 'typed') as ReferenceRecord['confidence'],
      targetSymbolId: typeof row.target_symbol_id === 'string' ? row.target_symbol_id : null,
      targetScipSymbol: null,
      sourceSymbolId: typeof row.source_symbol_id === 'string' ? row.source_symbol_id : null,
      kind: 'read',
      analysisEngine: String(row.analysis_engine ?? ''),
      unresolvedReason: null,
      buildId: store.build.buildId,
      sourceName: null,
      targetName: typeof row.target_name === 'string' ? row.target_name : null,
    }));
  } finally {
    store.db.close();
  }
}

function userSymbolNames(rows: VueSymbolRow[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind === 'component') continue;
    if (row.nameChain !== row.name) continue;
    if (row.name.startsWith('__VLS_')) continue;
    const list = output.get(row.path) ?? [];
    list.push(row.name);
    output.set(row.path, list);
  }
  for (const list of output.values()) list.sort();
  return output;
}

describe('Vue projection primitives', () => {
  it('maps generated offsets back to source and converts UTF-8 columns', () => {
    const absolute = path.join(REPO_ROOT, 'fixtures/F05-vue-sfc/src/components/ChildCard.vue');
    const result = projectVueFile({
      projectRoot: path.join(REPO_ROOT, 'fixtures/F05-vue-sfc'),
      rootAbsolutePath: path.join(REPO_ROOT, 'fixtures/F05-vue-sfc'),
      filePath: absolute,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projection = result.projection;
    expect(projection.segments.length).toBeGreaterThan(10);
    const source = projection.source;
    const titleOffset = source.indexOf('{{ title }}') + 3;
    const generated = sourceToGenerated(projection, titleOffset);
    expect(generated).not.toBeNull();
    if (generated !== null) expect(generatedToSource(projection, generated)).toBe(titleOffset);
    const position = offsetToPosition(projection.sourceLineStarts, titleOffset);
    expect(positionToOffset(projection.sourceLineStarts, position.line, position.col)).toBe(
      titleOffset,
    );
    expect(projection.templateRanges.some((range) => range.kind === 'interpolation')).toBe(true);
    expect(projection.templateRanges.some((range) => range.kind === 'dynamic-arg')).toBe(false);
  });

  it('projects non-ASCII identifiers without losing coordinates', () => {
    const directory = makeProject('F05-vue-sfc', 'vue-unicode');
    try {
      const file = path.join(directory, 'src/components/Unicode.vue');
      fs.writeFileSync(
        file,
        '<script setup lang="ts">\nconst 标题 = "值";\n</script>\n<template>\n  <p>{{ 标题 }}</p>\n</template>\n',
      );
      const result = projectVueFile({
        projectRoot: directory,
        rootAbsolutePath: directory,
        filePath: file,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const projection = result.projection;
      const offset = projection.source.indexOf('{{ 标题 }}') + 3;
      const generated = sourceToGenerated(projection, offset);
      expect(generated).not.toBeNull();
      if (generated !== null) expect(generatedToSource(projection, generated)).toBe(offset);
      const locale = projection.source.indexOf('标题');
      const position = offsetToPosition(projection.sourceLineStarts, locale);
      expect(position.col).toBe(6);
    } finally {
      cleanup(directory);
    }
  });
});

describe('F05 Vue fixture (V1-V4, V6)', () => {
  it(
    'indexes SFC symbols, components, template edges and mapping tables',
    { timeout: 180_000 },
    async () => {
      const fixture = await indexFixture('F05-vue-sfc', 'f05');
      try {
        expect(fixture.build.failedRoots).toEqual([]);
        const expectedSymbols = readGolden<GoldenSymbols>(fixture.directory, 'symbols.json');
        const expectedEdges = readGolden<GoldenEdge[]>(fixture.directory, 'template-edges.json');
        const expectedComponents = readGolden<GoldenComponents>(
          fixture.directory,
          'components.json',
        );
        const symbols = symbolRows(fixture.directory, fixture.rootId);
        const names = userSymbolNames(symbols);
        for (const [file, expected] of Object.entries(expectedSymbols)) {
          expect(names.get(file) ?? []).toEqual([...expected].sort());
        }
        for (const row of symbols) {
          expect(row.name.startsWith('__VLS_')).toBe(false);
          expect(row.nameChain.startsWith('__VLS_')).toBe(false);
        }

        // V4: component model + propsCoverage.
        for (const [file, expected] of Object.entries(expectedComponents)) {
          const componentSymbol = symbols.find(
            (row) => row.path === file && row.kind === 'component',
          );
          expect(componentSymbol).toBeDefined();
          const store = openReadStore(databasePath(fixture.directory, fixture.rootId));
          if (store === null) throw new Error('no store');
          try {
            const component = readComponent(store, componentSymbol?.symbolId ?? '');
            expect(component).not.toBeNull();
            if (component === null) continue;
            expect(component.props.map((prop) => prop.name)).toEqual(
              expected.props.map((prop) => prop.name),
            );
            for (const expectedProp of expected.props) {
              const actual = component.props.find((prop) => prop.name === expectedProp.name);
              expect(actual?.typeText).toBe(expectedProp.typeText);
              expect(actual?.required).toBe(expectedProp.required);
              expect(actual?.resolved).toBe(expectedProp.resolved);
            }
            expect(component.emits.map((emit) => emit.name)).toEqual(expected.emits);
            expect(component.slots.map((slot) => slot.name)).toEqual(expected.slots);
            expect(component.propsCoverage.resolved).toBe(expected.propsCoverage.resolved);
            expect(component.propsCoverage.total).toBe(expected.propsCoverage.total);
            for (const name of expected.propsCoverage.unresolved ?? []) {
              expect(component.propsCoverage.unresolved.some((entry) => entry.name === name)).toBe(
                true,
              );
            }
            if (file.endsWith('UnresolvedProps.vue')) {
              const neverSlot = component.slots.find((slot) => slot.name === 'neverSlot');
              expect(neverSlot?.resolved).toBe(false);
              expect(neverSlot?.reason).toBe('slot-never');
              const anyProp = component.props.find((prop) => prop.name === 'anything');
              expect(anyProp?.reason).toBe('type-any');
              const neverProp = component.props.find((prop) => prop.name === 'missing');
              expect(neverProp?.reason).toBe('type-never');
            }
          } finally {
            store.db.close();
          }
        }

        // V3: exact template edge set, including dynamic argument and heuristic member.
        const edges = vueReferenceRows(fixture.directory, fixture.rootId);
        const actualEdges = edges
          .map((edge) => ({
            file: edge.sourceFile,
            line: edge.line,
            col: edge.col,
            role: edge.role.replace('template:', ''),
            target: edge.targetName ?? '',
            relationClass: edge.relationClass,
          }))
          .sort((left, right) =>
            left.file !== right.file
              ? left.file < right.file
                ? -1
                : 1
              : left.line !== right.line
                ? left.line - right.line
                : left.col - right.col,
          );
        expect(actualEdges).toEqual(expectedEdges);
        expect(actualEdges.filter((edge) => edge.role === 'component-use')).toHaveLength(3);
        expect(actualEdges.filter((edge) => edge.role === 'dynamic-argument')).toHaveLength(1);
        expect(
          actualEdges.some(
            (edge) => edge.relationClass === 'heuristic' && edge.target === 'Formatter.save',
          ),
        ).toBe(true);
        expect(actualEdges.some((edge) => edge.role === 'interpolation' && edge.line === 30)).toBe(
          true,
        );

        // V1: every `.vue` symbol/reference coordinate points at the identifier and
        // round-trips through the Volar mapping.
        const projections = new Map<string, VueProjection>();
        for (const file of Object.keys(expectedSymbols)) {
          const result = projectVueFile({
            projectRoot: fixture.directory,
            rootAbsolutePath: fixture.directory,
            filePath: path.join(fixture.directory, file),
          });
          if (result.ok) projections.set(file, result.projection);
        }
        let checked = 0;
        for (const row of symbols) {
          if (row.kind === 'component') continue;
          const projection = projections.get(row.path);
          expect(projection).toBeDefined();
          if (projection === undefined) continue;
          const offset = positionToOffset(projection.sourceLineStarts, row.nameLine, row.nameCol);
          const generated = sourceToGenerated(projection, offset);
          expect(generated).not.toBeNull();
          if (generated !== null) expect(generatedToSource(projection, generated)).toBe(offset);
          const name = row.name;
          expect(projection.source.slice(offset).startsWith(name)).toBe(true);
          checked += 1;
        }
        for (const edge of edges) {
          if (edge.targetSymbolId === null) continue;
          const projection = projections.get(edge.sourceFile);
          if (projection === undefined) continue;
          const offset = positionToOffset(projection.sourceLineStarts, edge.line, edge.col);
          const generated = sourceToGenerated(projection, offset);
          expect(generated).not.toBeNull();
          if (generated !== null) expect(generatedToSource(projection, generated)).toBe(offset);
          const name = (edge.targetName ?? '').split('.').at(-1) ?? '';
          if (name !== '') expect(projection.source.slice(offset).startsWith(name)).toBe(true);
          checked += 1;
        }
        expect(checked).toBeGreaterThanOrEqual(59);

        // V6: symbol_map coverage and unmapped registration.
        const store = openReadStore(databasePath(fixture.directory, fixture.rootId));
        if (store === null) throw new Error('no store');
        try {
          const vueSymbolIds = symbols
            .filter((row) => row.kind !== 'component')
            .map((row) => row.symbolId);
          for (const symbolId of vueSymbolIds) {
            const rows = store.db
              .prepare(
                'select engine, match_quality from symbol_map where build_id = ? and symbol_id = ?',
              )
              .all(store.build.buildId, symbolId) as Array<Record<string, unknown>>;
            expect(rows.length).toBeGreaterThanOrEqual(2);
            expect(
              rows.some(
                (row) =>
                  row.engine !== 'scip' ||
                  (row.match_quality !== 'unmapped' && row.match_quality !== 'conflict'),
              ),
            ).toBe(true);
          }
          const conflict = store.db
            .prepare(
              "select count(*) as count from symbol_map where build_id = ? and match_quality = 'conflict'",
            )
            .get(store.build.buildId) as { count?: unknown };
          expect(Number(conflict.count ?? 0)).toBe(0);
        } finally {
          store.db.close();
        }

        const manifest = readManifest(
          path.join(fixture.directory, '.nexus', 'roots', fixture.rootId, 'manifest.json'),
        ).manifest;
        expect(manifest?.vue?.projected).toBe(5);
        expect(manifest?.vue?.components).toBe(5);
        expect(manifest?.vue?.templateEdges.total).toBe(23);
        expect(manifest?.vue?.propsCoverage.total).toBe(9);
        expect(manifest?.vue?.errors).toEqual([]);
        expect(manifest?.stats.falseMatchCount).toBe(0);
        expect(manifest?.coverage.filteredInternal).toBeGreaterThan(0);

        const status = await statusReport({
          projectRoot: fixture.directory,
          cwd: fixture.directory,
          self: SELF,
        });
        expect(status.capabilities.vue).toBe('sfc-semantic');
        expect(status.roots[0]?.vue?.components).toBe(5);

        // `--no-template` excludes only template roles and says so.
        const withoutTemplate = await queryReferences(
          { projectRoot: fixture.directory, cwd: fixture.directory },
          'handleSelect',
          true,
          false,
        );
        expect(
          withoutTemplate.envelope.items.every((item) => !item.role.startsWith('template:')),
        ).toBe(true);
        expect(withoutTemplate.envelope.notes.join(' ')).toContain('template edges');
        const withTemplate = await queryReferences(
          { projectRoot: fixture.directory, cwd: fixture.directory },
          'handleSelect',
          true,
          true,
        );
        expect(
          withTemplate.envelope.items.some((item) => item.role === 'template:template-binding'),
        ).toBe(true);
      } finally {
        cleanup(fixture.directory);
      }
    },
  );

  it(
    'removing a template handler removes only that template edge',
    { timeout: 180_000 },
    async () => {
      const directory = makeProject('F05-vue-sfc', 'f05-handler');
      try {
        await initProject(directory);
        const first = await buildWorkspace({
          projectRoot: directory,
          loadedConfig: await loadConfig({ projectRoot: directory }),
        });
        expect(first.failedRoots).toEqual([]);
        const loaded = await loadConfig({ projectRoot: directory });
        const rootId = loaded.config?.workspaces.roots[0] ?? '';
        const before = vueReferenceRows(directory, rootId);
        expect(before.some((edge) => edge.line === 26 && edge.col === 13)).toBe(true);

        const appPath = path.join(directory, 'src/App.vue');
        const source = fs.readFileSync(appPath, 'utf8');
        fs.writeFileSync(appPath, source.replace('    @select="handleSelect"\n', ''));
        const second = await buildWorkspace({
          projectRoot: directory,
          loadedConfig: await loadConfig({ projectRoot: directory }),
        });
        expect(second.failedRoots).toEqual([]);
        const after = vueReferenceRows(directory, rootId);
        expect(after.some((edge) => edge.line === 26 && edge.col === 13)).toBe(false);
        expect(after.length).toBe(before.length - 1);
      } finally {
        cleanup(directory);
      }
    },
  );

  it('reproduces Vue rows and clears .nexus/tmp on rebuild', { timeout: 180_000 }, async () => {
    const fixture = await indexFixture('F05-vue-sfc', 'f05-rebuild');
    try {
      const firstSymbols = symbolRows(fixture.directory, fixture.rootId).map((row) => ({
        id: row.symbolId,
        path: row.path,
        line: row.startLine,
        col: row.startCol,
        name: row.name,
        chain: row.nameChain,
      }));
      const firstEdges = vueReferenceRows(fixture.directory, fixture.rootId).map((edge) => ({
        file: edge.sourceFile,
        line: edge.line,
        col: edge.col,
        role: edge.role,
        target: edge.targetSymbolId,
      }));
      const rebuilt = await buildWorkspace({
        projectRoot: fixture.directory,
        loadedConfig: await loadConfig({ projectRoot: fixture.directory }),
      });
      expect(rebuilt.failedRoots).toEqual([]);
      const secondSymbols = symbolRows(fixture.directory, fixture.rootId).map((row) => ({
        id: row.symbolId,
        path: row.path,
        line: row.startLine,
        col: row.startCol,
        name: row.name,
        chain: row.nameChain,
      }));
      const secondEdges = vueReferenceRows(fixture.directory, fixture.rootId).map((edge) => ({
        file: edge.sourceFile,
        line: edge.line,
        col: edge.col,
        role: edge.role,
        target: edge.targetSymbolId,
      }));
      expect(secondSymbols).toEqual(firstSymbols);
      expect(secondEdges).toEqual(firstEdges);
      expect(fs.existsSync(path.join(fixture.directory, '.nexus', 'tmp'))).toBe(false);
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('semantic-map T09 (V2/V6)', () => {
  it(
    'maps every user SFC symbol and registers unmapped entries',
    { timeout: 180_000 },
    async () => {
      const fixture = await indexFixture('semantic-map', 'semantic-map-vue');
      try {
        expect(fixture.build.failedRoots).toEqual([]);
        const expected = readGolden<{ [file: string]: string[] }>(
          path.join(fixture.directory, 'vue'),
          'symbols.json',
        );
        const symbols = symbolRows(fixture.directory, fixture.rootId);
        const vueSymbols = symbols.filter(
          (row) => row.path.startsWith('vue/') && row.path.endsWith('.vue'),
        );
        const names = userSymbolNames(vueSymbols);
        for (const [file, expectedNames] of Object.entries(expected)) {
          const key = `vue/${file}`;
          expect(names.get(key) ?? []).toEqual([...expectedNames].sort());
        }
        const componentSymbols = vueSymbols.filter((row) => row.kind === 'component');
        expect(componentSymbols).toHaveLength(2);
        const store = openReadStore(databasePath(fixture.directory, fixture.rootId));
        if (store === null) throw new Error('no store');
        try {
          for (const row of vueSymbols) {
            const rows = store.db
              .prepare(
                'select engine, match_quality from symbol_map where build_id = ? and symbol_id = ?',
              )
              .all(store.build.buildId, row.symbolId) as Array<Record<string, unknown>>;
            expect(rows.length).toBeGreaterThanOrEqual(2);
            if (row.kind === 'component') {
              expect(
                rows.some((entry) => entry.engine === 'vue' && entry.match_quality === 'exact'),
              ).toBe(true);
              expect(
                rows.some((entry) => entry.engine === 'scip' && entry.match_quality === 'unmapped'),
              ).toBe(true);
            } else {
              expect(
                rows.some(
                  (entry) =>
                    entry.engine === 'scip' &&
                    entry.match_quality !== 'unmapped' &&
                    entry.match_quality !== 'conflict',
                ),
              ).toBe(true);
            }
          }
          const unmappedReasons = store.db
            .prepare(
              "select evidence_json from symbol_map where build_id = ? and match_quality = 'unmapped'",
            )
            .all(store.build.buildId) as Array<Record<string, unknown>>;
          expect(unmappedReasons.length).toBeGreaterThanOrEqual(2);
          const manifest = readManifest(
            path.join(fixture.directory, '.nexus', 'roots', fixture.rootId, 'manifest.json'),
          ).manifest;
          expect(manifest?.vue?.unmappedReasons['synthetic-component']).toBe(2);
        } finally {
          store.db.close();
        }
      } finally {
        cleanup(fixture.directory);
      }
    },
  );
});
