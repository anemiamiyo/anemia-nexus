import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctorRepair } from 'anemia-core';

import { cleanup, indexFixture } from './helpers.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) cleanup(directories.pop() as string);
});

async function fixture(): Promise<{ directory: string; rootId: string }> {
  const indexed = await indexFixture('F01-reexport-chain', 'repair');
  directories.push(indexed.directory);
  return { directory: indexed.directory, rootId: indexed.rootId };
}

describe('doctor --repair (11.3 / 12.3.3)', () => {
  it('rebuilds derived workspace.json and leaves source files untouched', async () => {
    const { directory } = await fixture();
    const sourceBefore = fs.readFileSync(path.join(directory, 'src', 'core', 'impl.ts'), 'utf8');
    const configBefore = fs.readFileSync(
      path.join(directory, '.nexus', 'nexus.config.json'),
      'utf8',
    );
    fs.rmSync(path.join(directory, '.nexus', 'workspace.json'), { force: true });
    const report = await runDoctorRepair({ projectRoot: directory });
    expect(report.exitCode).toBe(0);
    expect(report.workspace.repaired).toBe(true);
    expect(report.actions.some((action) => action.id === 'workspace')).toBe(true);
    expect(fs.existsSync(path.join(directory, '.nexus', 'workspace.json'))).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'src', 'core', 'impl.ts'), 'utf8')).toBe(
      sourceBefore,
    );
    expect(fs.readFileSync(path.join(directory, '.nexus', 'nexus.config.json'), 'utf8')).toBe(
      configBefore,
    );
  });

  it('removes an orphan root directory but keeps configured roots', async () => {
    const { directory, rootId } = await fixture();
    const orphan = path.join(directory, '.nexus', 'roots', 'no-longer-configured');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'index.db'), 'orphan');
    const report = await runDoctorRepair({ projectRoot: directory });
    expect(report.removedOrphans).toContain('no-longer-configured');
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(directory, '.nexus', 'roots', rootId, 'index.db'))).toBe(true);
  });

  it('reports a corrupt committed database instead of deleting it', async () => {
    const { directory, rootId } = await fixture();
    const dbPath = path.join(directory, '.nexus', 'roots', rootId, 'index.db');
    fs.writeFileSync(dbPath, 'not-a-sqlite-database');
    const report = await runDoctorRepair({ projectRoot: directory });
    expect(report.exitCode).toBe(1);
    expect(
      report.actions.some((action) => action.id === 'invalid-roots' && action.status === 'failed'),
    ).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
