import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildWorkspace, loadConfig, runInit, type LoadedConfig } from 'anemia-core';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const TMP_ROOT = path.join(REPO_ROOT, '.nexus', 'test-tmp');

export function makeProject(fixtureName: string, label: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const destination = path.join(TMP_ROOT, `${label}-${randomBytes(4).toString('hex')}`);
  fs.cpSync(path.join(REPO_ROOT, 'fixtures', fixtureName), destination, { recursive: true });
  fs.rmSync(path.join(destination, '.nexus'), { recursive: true, force: true });
  return destination;
}

export function makeEmptyProject(label: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const destination = path.join(TMP_ROOT, `${label}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(destination, { recursive: true });
  return destination;
}

export function cleanup(directory: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

export interface IndexedFixture {
  directory: string;
  rootId: string;
  loaded: LoadedConfig;
  build: Awaited<ReturnType<typeof buildWorkspace>>;
}

export async function initProject(
  directory: string,
  options: { roots?: string; skipTypecheck?: boolean } = {},
): Promise<void> {
  await runInit({
    projectRoot: directory,
    roots: options.roots ?? 'all',
    writeConfig: true,
    yes: true,
    nonInteractive: true,
    skipTypecheck: options.skipTypecheck ?? true,
  });
}

export async function indexFixture(
  fixtureName: string,
  label: string,
  options: { skipTypecheck?: boolean } = {},
): Promise<IndexedFixture> {
  const directory = makeProject(fixtureName, label);
  await initProject(directory, { skipTypecheck: options.skipTypecheck ?? true });
  const loaded = await loadConfig({ projectRoot: directory });
  const build = await buildWorkspace({ projectRoot: directory, loadedConfig: loaded });
  const rootId = loaded.config?.workspaces.roots[0] ?? '';
  return { directory, rootId, loaded, build };
}

export function escapedPath(value: string): string {
  return value.replaceAll('\\', '\\\\');
}
