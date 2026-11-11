import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { contentHash, isNexusError, loadConfig } from 'anemia-core';
import { TMP_ROOT, cleanup, initProject, makeProject } from './helpers.js';

function writeTsConfig(projectRoot: string, source: string): void {
  fs.mkdirSync(path.join(projectRoot, '.nexus'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.nexus', 'nexus.config.ts'), source);
}

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

describe('F17 configuration security', () => {
  it('never executes an untrusted TypeScript config', async () => {
    const directory = makeProject('F17-config-security', 'f17-untrusted');
    const marker = path.join(TMP_ROOT, `marker-${randomBytes(4).toString('hex')}.txt`);
    try {
      writeTsConfig(
        directory,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker.replaceAll('\\', '\\\\'))}, 'executed');\nexport default { configVersion: 1 };\n`,
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory }));
      expect(isNexusError(error) && error.code === 'E18').toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup(directory);
      fs.rmSync(marker, { force: true });
    }
  });

  it('blocks writes outside the project even for a trusted config', async () => {
    const directory = makeProject('F17-config-security', 'f17-write');
    const marker = path.join(TMP_ROOT, `marker-${randomBytes(4).toString('hex')}.txt`);
    try {
      writeTsConfig(
        directory,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker.replaceAll('\\', '\\\\'))}, 'executed');\nexport default { configVersion: 1 };\n`,
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory, trustConfig: true }));
      expect(isNexusError(error) && error.code === 'E17').toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup(directory);
      fs.rmSync(marker, { force: true });
    }
  });

  it('blocks reads outside the project even for a trusted config', async () => {
    const directory = makeProject('F17-config-security', 'f17-read');
    const secretPath = path.join(TMP_ROOT, `secret-${randomBytes(4).toString('hex')}.txt`);
    const secret = `nexus-secret-${randomBytes(8).toString('hex')}`;
    try {
      fs.writeFileSync(secretPath, secret);
      writeTsConfig(
        directory,
        `import { readFileSync } from 'node:fs';\nconst value = readFileSync(${JSON.stringify(secretPath.replaceAll('\\', '\\\\'))}, 'utf8');\nexport default { configVersion: 1, defaults: { budgets: { maxTokens: value.length } } };\n`,
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory, trustConfig: true }));
      expect(isNexusError(error) && error.code === 'E17').toBe(true);
      const reason = isNexusError(error) ? error.reason : '';
      expect(reason).not.toContain(secret);
    } finally {
      cleanup(directory);
      fs.rmSync(secretPath, { force: true });
    }
  });

  it('blocks network access from a trusted config', async () => {
    const directory = makeProject('F17-config-security', 'f17-network');
    try {
      writeTsConfig(
        directory,
        `await fetch('https://example.com/nexus-probe');\nexport default { configVersion: 1 };\n`,
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory, trustConfig: true }));
      expect(isNexusError(error) && error.code === 'E17').toBe(true);
      expect(isNexusError(error) ? error.reason : '').toMatch(/NETWORK_BLOCKED|fetch/i);
    } finally {
      cleanup(directory);
    }
  });

  it('blocks child process execution from a trusted config', async () => {
    const directory = makeProject('F17-config-security', 'f17-shell');
    const marker = path.join(TMP_ROOT, `marker-${randomBytes(4).toString('hex')}.txt`);
    try {
      writeTsConfig(
        directory,
        `const cp = await import('node:child_process');\ncp.execSync(${JSON.stringify(`node -e "require('fs').writeFileSync(${JSON.stringify(marker.replaceAll('\\', '\\\\'))}, 'x')"`)});\nexport default { configVersion: 1 };\n`,
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory, trustConfig: true }));
      expect(isNexusError(error) && error.code === 'E17').toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup(directory);
      fs.rmSync(marker, { force: true });
    }
  });

  it('never runs project lifecycle scripts during init', async () => {
    const directory = makeProject('F17-config-security', 'f17-scripts');
    try {
      await initProject(directory);
      expect(fs.existsSync(path.join(directory, 'prepare-ran.txt'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'postinstall-ran.txt'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'build-ran.txt'))).toBe(false);
    } finally {
      cleanup(directory);
    }
  });

  it('rejects destructive commands in JSON configuration', async () => {
    const directory = makeProject('F17-config-security', 'f17-command');
    try {
      fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, '.nexus', 'nexus.config.json'),
        JSON.stringify({
          configVersion: 1,
          commands: { allow: [{ id: 'bad', cmd: 'git', args: ['clean', '-fdx'] }] },
        }),
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory }));
      expect(isNexusError(error) && error.code === 'E17').toBe(true);
    } finally {
      cleanup(directory);
    }
  });

  it('accepts a safe trusted config and rejects a stale trust hash', async () => {
    const directory = makeProject('F17-config-security', 'f17-trust');
    try {
      writeTsConfig(directory, 'export default { configVersion: 1 };\n');
      const loaded = await loadConfig({ projectRoot: directory, trustConfig: true });
      expect(loaded.sourceKind).toBe('ts');
      const content = fs.readFileSync(path.join(directory, '.nexus', 'nexus.config.ts'), 'utf8');
      fs.writeFileSync(
        path.join(directory, '.nexus', 'trust.json'),
        JSON.stringify({
          version: 1,
          entries: [
            {
              path: '.nexus/nexus.config.ts',
              contentHash: contentHash(`${content}\n// tampered`),
              trustedAt: '2026-11-12T00:00:00.000Z',
            },
          ],
        }),
      );
      const error = await errorOf(() => loadConfig({ projectRoot: directory }));
      expect(isNexusError(error) && error.code === 'E18').toBe(true);
    } finally {
      cleanup(directory);
    }
  });
});
