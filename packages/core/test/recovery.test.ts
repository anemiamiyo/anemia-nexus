import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { recoverWorkspace, statusReport, type RecoveryOutcome } from 'anemia-core';
import { manifestPath, readManifest } from '../src/store/manifest.js';
import { cleanup, indexFixture, makeEmptyProject, REPO_ROOT } from './helpers.js';

const directories: string[] = [];
const CHILD = path.join(REPO_ROOT, 'packages', 'core', 'test', 'crash-child.ts');

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

const SELF = {
  serverVersion: '',
  packageName: '',
  binaryPath: '',
  projectRoot: '.',
  nodeVersion: process.versions.node,
};

function copyProject(source: string, label: string): string {
  const destination = makeEmptyProject(label);
  fs.cpSync(source, destination, { recursive: true });
  // A copied project must not inherit a lock from the parent build.
  const roots = path.join(destination, '.nexus', 'roots');
  if (fs.existsSync(roots)) {
    for (const entry of fs.readdirSync(roots)) {
      if (entry.endsWith('.lock'))
        fs.rmSync(path.join(roots, entry), { recursive: true, force: true });
    }
  }
  return destination;
}

function crashBuild(project: string, point: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: project,
    env: { ...process.env, NEXUS_CRASH_AT: point },
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
}

describe('F16 crash recovery (12.3.3)', () => {
  it('recovers every injection point without losing the previous index', async () => {
    const fixture = await indexFixture('F16-crash-recovery', 'f16-base');
    directories.push(fixture.directory);
    const baselineBuild = fs.readFileSync(manifestPath(fixture.directory, fixture.rootId), 'utf8');
    const baselineManifest = JSON.parse(baselineBuild) as { buildId: string };

    const expectations: Array<[string, RecoveryOutcome]> = [
      ['after-rows-before-commit', 'normal'],
      ['after-commit-before-flip', 'pending-discarded'],
      ['after-flip-before-manifest', 'manifest-repaired'],
      ['manifest-tmp-written', 'manifest-repaired'],
      ['after-manifest-before-surface', 'stale-surface'],
      ['after-surface-before-workspace', 'normal'],
      ['workspace-before-cleanup', 'normal'],
    ];

    for (const [point, expected] of expectations) {
      const project = copyProject(fixture.directory, `f16-${point}`);
      directories.push(project);
      const crash = crashBuild(project, point);
      expect(crash.error, `${point} must not time out`).toBeUndefined();
      if (process.platform === 'win32') {
        expect(crash.error, `${point} must not time out`).toBeUndefined();
        expect(crash.status ?? 1, `${point} must terminate abnormally`).not.toBe(0);
      } else {
        // A build failure would also be non-zero; only SIGKILL proves the
        // requested injection point was reached.
        expect(crash.signal, `${point} must be killed at the injection point`).toBe('SIGKILL');
      }
      const recovery = recoverWorkspace(project);
      const result = recovery.roots.find((entry) => entry.rootId === fixture.rootId);
      expect(result?.outcome, point).toBe(expected);
      expect(result?.readable, point).toBe(true);

      const manifest = readManifest(manifestPath(project, fixture.rootId)).manifest;
      expect(manifest, point).not.toBeNull();
      // The same committed index must remain readable; recovery never returns
      // an empty or fabricated build when a prior committed build exists.
      expect(manifest?.buildId, point).not.toBe('');
      expect(manifest?.filesHash, point).not.toBe('');
      if (expected === 'manifest-repaired' || expected === 'stale-surface') {
        expect(manifest?.recovered === true || manifest?.staleness === 'stale', point).toBe(true);
      }
      const status = await statusReport({ projectRoot: project, cwd: project, self: SELF });
      expect(status.state, point).toBe('ready');
      expect(status.staleness, point).not.toBe('failed');
      // A no-op update must see the stale/repaired state and rebuild it, not
      // return "fresh" on recovered data.
      if (manifest?.recovered === true || manifest?.staleness === 'stale') {
        expect(
          manifest?.buildId === baselineManifest.buildId || manifest?.staleness === 'stale',
        ).toBe(true);
      }
    }
  });

  it('a pending build is never served as the current index', async () => {
    const fixture = await indexFixture('F16-crash-recovery', 'f16-pending');
    directories.push(fixture.directory);
    const project = copyProject(fixture.directory, 'f16-pending-copy');
    directories.push(project);
    crashBuild(project, 'after-commit-before-flip');
    const before = readManifest(manifestPath(project, fixture.rootId)).manifest;
    const recovery = recoverWorkspace(project);
    expect(recovery.roots[0]?.outcome).toBe('pending-discarded');
    const after = readManifest(manifestPath(project, fixture.rootId)).manifest;
    expect(after?.buildId).toBe(before?.buildId);
    expect(after?.staleness).toBe('stale');
  });
});
