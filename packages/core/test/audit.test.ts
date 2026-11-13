import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  buildWorkspace,
  impactData,
  isNexusError,
  loadConfig,
  queryReferences,
  querySearch,
  runPostflight,
  runPreflight,
  runVerify,
  writeBaselineSnapshot,
} from 'anemia-core';

import { cleanup, indexFixture, initProject, makeProject } from './helpers.js';

function git(directory: string, args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function initGit(directory: string): void {
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'audit@example.test']);
  git(directory, ['config', 'user.name', 'Audit Test']);
  fs.writeFileSync(path.join(directory, '.gitignore'), '.nexus/\n', 'utf8');
}

describe('Phase 05 impact', () => {
  it('reaches every certain consumer of a file and reports risk evidence', async () => {
    const fixture = await indexFixture('F08-refactor', 'impact-file');
    try {
      const result = await analyzeImpact({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: 'src/core.ts',
        depth: 4,
      });
      const data = impactData(result);
      const items = [
        ...((data.direct as { items: Array<{ path: string }> }).items ?? []),
        ...((data.indirect as { items: Array<{ path: string }> }).items ?? []),
      ];
      const paths = new Set(items.map((item) => item.path));
      expect(paths.has('src/overlay.ts')).toBe(true);
      expect(paths.has('src/button.ts')).toBe(true);
      expect(paths.has('src/panel.ts')).toBe(true);
      expect(paths.has('src/app.ts')).toBe(true);
      expect(paths.has('src/button.test.ts')).toBe(true);
      const risk = data.risk as { level: string; reasons: Array<{ rule: string }> };
      expect(['Low', 'Medium', 'High', 'Critical']).toContain(risk.level);
      expect(risk.reasons.length).toBeGreaterThan(0);
      expect(risk.reasons.every((reason) => typeof reason.rule === 'string')).toBe(true);
      expect((data.counts as { certain: number }).certain).toBeGreaterThan(0);
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('reports symbol consumers, surface entries, components, types and test relations', async () => {
    const fixture = await indexFixture('F08-refactor', 'impact-symbol');
    try {
      const result = await analyzeImpact({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: '',
        symbol: 'useOverlay',
      });
      const data = impactData(result);
      const surface = data.surface as { affected: unknown[]; diffLevel: string };
      expect(surface.affected.length).toBeGreaterThan(0);
      expect(surface.diffLevel).not.toBe(undefined);
      const tests = (data.tests as { related: Array<{ testFile: string }> }).related;
      expect(tests.some((test) => test.testFile === 'src/button.test.ts')).toBe(true);
      const types = (data.types as { affected: Array<{ name: string }> }).affected;
      expect(types.some((type) => type.name.includes('OverlayProps'))).toBe(true);
      const risk = data.risk as { level: string };
      expect(['Medium', 'High', 'Critical']).toContain(risk.level);
      expect(data.impactFanout as number).toBeGreaterThan(0);
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('keeps style impact file-level and never Critical', async () => {
    const fixture = await indexFixture('F08-refactor', 'impact-style');
    try {
      const result = await analyzeImpact({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: 'src/styles/theme.scss',
      });
      const data = impactData(result);
      expect((data.styleDependents as unknown[]).length).toBeGreaterThan(0);
      expect((data.counts as { certain: number }).certain).toBeGreaterThan(0);
      expect(['Low', 'Medium', 'High']).toContain((data.risk as { level: string }).level);
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('marks impact and references as stale after a source edit', async () => {
    const fixture = await indexFixture('F12-dirty', 'dirty');
    try {
      const userPath = path.join(fixture.directory, 'src', 'user.ts');
      fs.writeFileSync(
        userPath,
        `${fs.readFileSync(userPath, 'utf8')}\nexport const revised = true;\n`,
        'utf8',
      );
      const references = await queryReferences(
        { projectRoot: fixture.directory, cwd: fixture.directory },
        'currentUser',
        true,
      );
      expect(references.envelope.staleness).not.toBe('fresh');
      expect(references.envelope.counts.partial).toBeGreaterThan(0);
      const impact = await analyzeImpact({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: 'src/user.ts',
      });
      expect(impactData(impact).staleness).not.toBe('fresh');
      expect(impactData(impact).completeness).toBe('partial');
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('Phase 05 preflight', () => {
  it('finds existing APIs, similar code, sources and a layered context packet', async () => {
    const fixture = await indexFixture('F08-refactor', 'preflight');
    try {
      const result = await runPreflight({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: 'src/overlay.ts',
        task: 'add a close method to the overlay controller',
      });
      expect(result.existingApis.length).toBeGreaterThan(0);
      expect(result.similar.rulesVersion).toBe('9.1.1');
      expect(Array.isArray(result.similar.candidates)).toBe(true);
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.context.layers.summary.length).toBeGreaterThanOrEqual(0);
      expect(result.context.budget.layer).toBe('summary');
      expect(result.impact).not.toBeNull();
      expect(result.risk.level).toBeTruthy();
    } finally {
      cleanup(fixture.directory);
    }
  });

  it('makes task-name extraction failure explicit instead of silently skipping', async () => {
    const fixture = await indexFixture('F08-refactor', 'preflight-task');
    try {
      const result = await runPreflight({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        target: '',
        task: 'zzzz qqqq xxxx',
      });
      expect(result.exitCode).toBe(2);
      expect(result.similar.extraction.failed).toBe(true);
      expect(result.notes.join('\n')).toContain('no target could be resolved');
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('Phase 05 postflight', () => {
  it('audits a real git change, flags breaking Surface and does not write files', async () => {
    const directory = makeProject('F08-refactor', 'postflight');
    try {
      initGit(directory);
      await initProject(directory);
      const loaded = await loadConfig({ projectRoot: directory });
      await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
      writeBaselineSnapshot({ projectRoot: directory, loadedConfig: loaded, yes: true });
      git(directory, ['add', '-A']);
      git(directory, ['commit', '-m', 'baseline']);

      const overlayPath = path.join(directory, 'src', 'overlay.ts');
      const overlay = fs.readFileSync(overlayPath, 'utf8');
      fs.writeFileSync(
        overlayPath,
        overlay.replace(
          /export function useOverlay[\s\S]*$/,
          'export function useOverlayController(title: string): OverlayController {\n  return new OverlayController(title);\n}\n',
        ),
        'utf8',
      );
      const buttonPath = path.join(directory, 'src', 'button.ts');
      fs.writeFileSync(
        buttonPath,
        "import { useOverlayController } from './overlay';\nimport './styles/theme.scss';\n\nexport function Button(label: string): string {\n  return useOverlayController(label).label();\n}\n",
        'utf8',
      );
      await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
      const statusBefore = git(directory, ['status', '--porcelain']);
      const result = await runPostflight({
        projectRoot: directory,
        cwd: directory,
        base: 'HEAD',
        failOn: 'breaking',
      });
      const statusAfter = git(directory, ['status', '--porcelain']);
      expect(statusAfter).toBe(statusBefore);
      expect(result.changed.files.length).toBeGreaterThan(0);
      expect(result.changed.symbols.length).toBeGreaterThan(0);
      expect(result.findings.some((finding) => finding.code === 'surface-breaking')).toBe(true);
      expect(result.exit.code).toBe(1);
    } finally {
      cleanup(directory);
    }
  });

  it('does not block on heuristic-only warnings under --fail-on warning', async () => {
    const fixture = await indexFixture('F08-refactor', 'postflight-warning');
    try {
      initGit(fixture.directory);
      git(fixture.directory, ['add', '-A']);
      git(fixture.directory, ['commit', '-m', 'fixture']);
      const userPath = path.join(fixture.directory, 'src', 'core.ts');
      fs.writeFileSync(
        userPath,
        fs
          .readFileSync(userPath, 'utf8')
          .replace('return value.toUpperCase();', 'return value.toLowerCase();'),
        'utf8',
      );
      await buildWorkspace({ projectRoot: fixture.directory, loadedConfig: fixture.loaded });
      const result = await runPostflight({
        projectRoot: fixture.directory,
        cwd: fixture.directory,
        base: 'HEAD',
        failOn: 'warning',
      });
      expect(result.findings.some((finding) => finding.code === 'test-coverage-missing')).toBe(
        true,
      );
      const blocking = result.findings.filter((finding) => finding.blockable);
      expect(blocking.every((finding) => finding.blockable)).toBe(true);
      expect(result.exit.code).toBe(2);
    } finally {
      cleanup(fixture.directory);
    }
  });
});

describe('Phase 05 verify and routing', () => {
  it('requires authorization, records trust and executes a whitelisted command', async () => {
    const directory = makeProject('F08-refactor', 'verify');
    try {
      await new Promise<void>((resolve) => resolve());
      fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'scripts', 'verify.cjs'),
        'require("fs").writeFileSync("verify-marker.txt", "ok");\n',
        'utf8',
      );
      const marker = path.join(directory, 'verify-marker.txt');
      fs.writeFileSync(
        path.join(directory, '.nexus', 'nexus.config.json'),
        JSON.stringify(
          {
            configVersion: 1,
            commands: {
              allow: [
                {
                  id: 'mark',
                  cmd: 'node',
                  args: ['scripts/verify.cjs'],
                  cwd: '.',
                  timeoutMs: 30000,
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      const loaded = await loadConfig({ projectRoot: directory });
      await expect(
        runVerify({ projectRoot: directory, config: loaded.config!, explicit: true }),
      ).rejects.toSatisfy((error: unknown) => isNexusError(error) && error.code === 'E12');
      const result = await runVerify({
        projectRoot: directory,
        config: loaded.config!,
        yes: true,
        explicit: true,
      });
      expect(result.commands[0]?.status).toBe('passed');
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(path.join(directory, '.nexus', 'trust.json'))).toBe(true);
    } finally {
      cleanup(directory);
    }
  });

  it('rejects a dangerous whitelist entry at config load', async () => {
    const directory = makeProject('F08-refactor', 'verify-danger');
    try {
      fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, '.nexus', 'nexus.config.json'),
        JSON.stringify({
          configVersion: 1,
          commands: { allow: [{ id: 'bad', cmd: 'rm', args: ['-rf', '.'], cwd: '.' }] },
        }),
        'utf8',
      );
      await expect(loadConfig({ projectRoot: directory })).rejects.toSatisfy(
        (error: unknown) => isNexusError(error) && error.code === 'E17',
      );
    } finally {
      cleanup(directory);
    }
  });

  it('groups multi-root search by root and reports E16 at the workspace root', async () => {
    const fixture = await indexFixture('F14-multi-root', 'routing');
    try {
      const grouped = await querySearch(
        { projectRoot: fixture.directory, cwd: fixture.directory, roots: 'all' },
        '',
        {},
      );
      expect(grouped.envelope.scope).toBe('all');
      expect((grouped.envelope.byRoot ?? []).length).toBeGreaterThan(1);
      expect(grouped.envelope.completeness).toBe('complete');
      for (const group of grouped.envelope.byRoot ?? []) {
        expect(group.items.every((item) => item.rootId === group.rootId)).toBe(true);
      }
      await expect(
        querySearch({ projectRoot: fixture.directory, cwd: fixture.directory }, '', {}),
      ).rejects.toSatisfy((error: unknown) => isNexusError(error) && error.code === 'E16');
      await expect(
        querySearch(
          { projectRoot: fixture.directory, cwd: fixture.directory, rootId: 'x', roots: 'all' },
          '',
          {},
        ),
      ).rejects.toSatisfy((error: unknown) => isNexusError(error) && error.code === 'E00');
    } finally {
      cleanup(fixture.directory);
    }
  });
});
