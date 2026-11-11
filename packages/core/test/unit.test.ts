import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configJsonSchema,
  configSchema,
  loadConfig,
  nexusError,
  stableStringify,
  contentHash,
  base32Encode,
  isNexusError,
  DEFAULT_CONFIG,
} from 'anemia-core';
import {
  computeAnonymousSymbolId,
  computeSymbolId,
  collisionSuffix,
} from '../src/index/symbol-id.js';
import { resolveRootConfig } from '../src/config/merge.js';
import { IgnoreMatcher } from '../src/discovery/ignore.js';
import { scanFiles, filesHash } from '../src/discovery/scan.js';
import { computeBuildFingerprint } from '../src/index/fingerprint.js';
import { ANALYZER_VERSION } from '../src/index/analyzer.js';
import { cleanup, makeEmptyProject } from './helpers.js';

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(isNexusError(error) && error.code === code).toBe(true);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe('hashing and canonical serialization', () => {
  it('base32 encodes RFC 4648 without padding', () => {
    expect(base32Encode(new Uint8Array([0]))).toBe('aa');
    expect(base32Encode(new Uint8Array([0, 0, 0]))).toBe('aaaaa');
    expect(base32Encode(new Uint8Array([255]))).toMatch(/^[a-z2-7]+$/);
  });

  it('stableStringify sorts object keys but keeps array order', () => {
    expect(stableStringify({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
    expect(stableStringify({ a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4}}');
  });

  it('contentHash normalizes CRLF', () => {
    expect(contentHash('a\r\nb')).toBe(contentHash('a\nb'));
    expect(contentHash('a\nb')).not.toBe(contentHash('a\nc'));
  });
});

describe('symbol identity', () => {
  const base = {
    rootId: 'root',
    kind: 'fn' as const,
    nameChain: 'add',
    structuralFingerprint: 'abc',
  };

  it('is deterministic and ignores paths', () => {
    const first = computeSymbolId(base);
    const second = computeSymbolId(base);
    expect(first).toBe(second);
    expect(first).toMatch(/^s_[a-z2-7]{16}$/);
    expect(first).not.toContain('src/');
  });

  it('changes with kind, name chain or structure', () => {
    expect(computeSymbolId({ ...base, kind: 'class' })).not.toBe(computeSymbolId(base));
    expect(computeSymbolId({ ...base, nameChain: 'multiply' })).not.toBe(computeSymbolId(base));
    expect(computeSymbolId({ ...base, structuralFingerprint: 'def' })).not.toBe(
      computeSymbolId(base),
    );
  });

  it('anonymous ids are position anchored and volatile by contract', () => {
    const anonymous = computeAnonymousSymbolId({
      rootId: 'root',
      kind: 'fn',
      path: 'src/a.ts',
      startLine: 1,
      startCol: 0,
      syntaxContextHash: 'ctx',
    });
    const moved = computeAnonymousSymbolId({
      rootId: 'root',
      kind: 'fn',
      path: 'src/a.ts',
      startLine: 2,
      startCol: 0,
      syntaxContextHash: 'ctx',
    });
    expect(anonymous).not.toBe(moved);
    expect(anonymous).toMatch(/^s_[a-z2-7]{16}$/);
    expect(collisionSuffix('locator')).toMatch(/^#[0-9a-f]{7}$/);
  });
});

describe('configuration schema', () => {
  it('rejects unknown fields and invalid versions', () => {
    expect(configSchema.safeParse({ configVersion: 1, unknown: true }).success).toBe(false);
    expect(configSchema.safeParse({ configVersion: 2 }).success).toBe(false);
    expect(configSchema.safeParse({}).success).toBe(false);
    const parsed = configSchema.parse({ configVersion: 1 });
    expect(parsed.defaults.output.format).toBe('auto');
    expect(parsed.workspaces.roots).toEqual([]);
  });

  it('derives JSON Schema from the same Zod schema', () => {
    const schema = configJsonSchema();
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.configVersion).toBeDefined();
    expect(properties.workspaces).toBeDefined();
  });

  it('merges builtin ignore rules additively and keeps includes', () => {
    const config = configSchema.parse({
      configVersion: 1,
      defaults: { ignore: { dirs: ['generated'] } },
      roots: { root: { ignore: { include: ['dist/types/**'] } } },
    });
    const effective = resolveRootConfig(config, 'root', config.roots.root);
    expect(effective.ignore.dirs).toContain('node_modules');
    expect(effective.ignore.dirs).toContain('.nexus');
    expect(effective.ignore.dirs).toContain('generated');
    expect(effective.ignore.include).toContain('dist/types/**');
    expect(effective.configHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('configuration loading', () => {
  it('loads JSON and reports a stable content hash', async () => {
    const directory = makeEmptyProject('config-json');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, '.nexus', 'nexus.config.json'),
      JSON.stringify({ configVersion: 1 }),
    );
    const loaded = await loadConfig({ projectRoot: directory });
    expect(loaded.sourceKind).toBe('json');
    expect(loaded.config?.configVersion).toBe(1);
    expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);
    cleanup(directory);
  });

  it('rejects a repository-root configuration', async () => {
    const directory = makeEmptyProject('config-root');
    fs.writeFileSync(
      path.join(directory, 'nexus.config.json'),
      JSON.stringify({ configVersion: 1 }),
    );
    await expectCode(() => loadConfig({ projectRoot: directory }), 'E17');
    cleanup(directory);
  });

  it('rejects dual configuration sources', async () => {
    const directory = makeEmptyProject('config-dual');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.nexus', 'nexus.config.json'), '{"configVersion":1}');
    fs.writeFileSync(path.join(directory, '.nexus', 'nexus.config.ts'), 'export default {}');
    await expectCode(() => loadConfig({ projectRoot: directory }), 'E17');
    cleanup(directory);
  });

  it('rejects dangerous commands in configuration', async () => {
    const directory = makeEmptyProject('config-danger');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, '.nexus', 'nexus.config.json'),
      JSON.stringify({
        configVersion: 1,
        commands: { allow: [{ id: 'bad', cmd: 'rm', args: ['-rf', '/'] }] },
      }),
    );
    await expectCode(() => loadConfig({ projectRoot: directory }), 'E17');
    cleanup(directory);
  });

  it('refuses an untrusted TypeScript config with E18', async () => {
    const directory = makeEmptyProject('config-ts');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, '.nexus', 'nexus.config.ts'),
      'export default { configVersion: 1 };\n',
    );
    await expectCode(() => loadConfig({ projectRoot: directory }), 'E18');
    cleanup(directory);
  });

  it('loads an explicitly trusted TypeScript config in a child process', async () => {
    const directory = makeEmptyProject('config-ts-trust');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    const content =
      'export default { configVersion: 1, defaults: { budgets: { maxTokens: 2222 } } };\n';
    fs.writeFileSync(path.join(directory, '.nexus', 'nexus.config.ts'), content);
    const loaded = await loadConfig({ projectRoot: directory, trustConfig: true });
    expect(loaded.sourceKind).toBe('ts');
    expect(loaded.authorization).toBe('flag');
    expect(loaded.config?.defaults.budgets.maxTokens).toBe(2222);
    cleanup(directory);
  });

  it('accepts a trust.json entry only when the content hash matches', async () => {
    const directory = makeEmptyProject('config-ts-trust-file');
    fs.mkdirSync(path.join(directory, '.nexus'), { recursive: true });
    const content = 'export default { configVersion: 1 };\n';
    fs.writeFileSync(path.join(directory, '.nexus', 'nexus.config.ts'), content);
    fs.writeFileSync(
      path.join(directory, '.nexus', 'trust.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: '.nexus/nexus.config.ts',
            contentHash: contentHash(content),
            trustedAt: '2026-11-12T00:00:00.000Z',
          },
        ],
      }),
    );
    const loaded = await loadConfig({ projectRoot: directory });
    expect(loaded.authorization).toBe('trust-file');
    fs.writeFileSync(
      path.join(directory, '.nexus', 'nexus.config.ts'),
      'export default { configVersion: 1, };\n',
    );
    await expectCode(() => loadConfig({ projectRoot: directory }), 'E18');
    cleanup(directory);
  });
});

describe('ignore and scanning', () => {
  it('excludes builtin directories and honors explicit include', () => {
    const effective = resolveRootConfig(DEFAULT_CONFIG, 'root');
    const matcher = new IgnoreMatcher({
      ...effective.ignore,
      include: ['dist/types/**'],
    });
    expect(matcher.isDirectoryIgnored('node_modules')).toBe(true);
    expect(matcher.isDirectoryIgnored('src')).toBe(false);
    expect(matcher.isFileIgnored('dist/types/a.d.ts')).toBe(false);
    expect(matcher.isFileIgnored('dist/other/a.js')).toBe(true);
    expect(matcher.mayContainInclude('dist')).toBe(true);
  });

  it('scans TS/TSX deterministically and never reads sensitive files', () => {
    const directory = makeEmptyProject('scan');
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'src', 'b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(directory, 'src', 'a.tsx'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(directory, 'src', '.env.ts'), 'export const secret = 1;\n');
    fs.writeFileSync(path.join(directory, 'node_modules', 'pkg', 'index.ts'), 'export {};\n');
    const effective = resolveRootConfig(DEFAULT_CONFIG, 'root');
    const result = scanFiles({
      projectRoot: directory,
      rootPath: directory,
      absoluteRoot: directory,
      ignore: new IgnoreMatcher(effective.ignore),
    });
    expect(result.files.map((file) => file.path)).toEqual(['src/a.tsx', 'src/b.ts']);
    expect(filesHash(result.files)).toBe(filesHash([...result.files]));
    cleanup(directory);
  });
});

describe('build fingerprint', () => {
  it('is deterministic and excludes timestamps by construction', () => {
    const fields = {
      filesHash: 'f',
      configHash: 'c',
      schemaVersion: 1,
      analyzerVersion: ANALYZER_VERSION,
      rootSetHash: 'r',
      nodeVersion: '22.16.0',
      sqliteVersion: '3.50.0',
      platform: 'win32-x64',
      degraded: [] as string[],
    };
    const first = computeBuildFingerprint(fields);
    const second = computeBuildFingerprint({ ...fields });
    expect(first).toBe(second);
    expect(first).toMatch(/^bf_[a-z2-7]{20}$/);
    expect(computeBuildFingerprint({ ...fields, degraded: ['syntax-only'] })).not.toBe(first);
  });
});

describe('error contract', () => {
  it('keeps code-based categories stable', () => {
    const error = nexusError('E01', 'index not found');
    expect(error.category).toBe('index');
    expect(error.severity).toBe('error');
  });
});
