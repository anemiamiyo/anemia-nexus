import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from '../errors.js';
import { sha256Hex } from '../util/hash.js';
import { loadTsConfig } from './ts-loader.js';
import { configSchema, type NexusConfig } from './schema.js';
import { zodIssuesToText } from './zod-error.js';
import { isDangerousCommand } from './commands.js';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const ROOT_LEVEL_CONFIGS = [
  'nexus.config.json',
  'nexus.config.ts',
  'nexus.config.js',
  'nexus.config.mjs',
  'nexus.config.cjs',
];

export type ConfigSourceKind = 'json' | 'ts' | 'none';
export type ConfigAuthorization = 'none' | 'flag' | 'trust-file';

export interface LoadedConfig {
  config: NexusConfig | null;
  sourcePath: string | null;
  sourceKind: ConfigSourceKind;
  contentHash: string | null;
  authorization: ConfigAuthorization;
  loadDurationMs: number;
}

export interface LoadConfigOptions {
  projectRoot: string;
  trustConfig?: boolean;
}

function findRootLevelConfig(projectRoot: string): string | null {
  for (const name of ROOT_LEVEL_CONFIGS) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function displayPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
}

function validateCommands(config: NexusConfig, configLabel: string): void {
  for (const command of config.commands.allow) {
    if (isDangerousCommand(command.cmd, command.args)) {
      throw nexusError('E17', 'configuration contains a dangerous command', {
        reason: `commands.allow[${command.id}] is rejected by the security policy`,
        file: configLabel,
        suggestion: 'Remove destructive or remote-execution commands from commands.allow.',
        evidence: { id: command.id, cmd: command.cmd, args: command.args },
      });
    }
  }
}

function parseJsonConfig(
  projectRoot: string,
  absolutePath: string,
  text: string,
): { config: NexusConfig; contentHash: string } {
  const label = displayPath(projectRoot, absolutePath);
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw nexusError('E17', 'configuration file is too large', {
      reason: `configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
      file: label,
      suggestion: 'Keep configuration under 2 MB.',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw nexusError('E17', 'configuration is not valid JSON', {
      reason: error instanceof Error ? error.message : String(error),
      file: label,
      suggestion: 'Fix the JSON syntax; comments are not allowed in JSON configuration.',
    });
  }
  const version =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).configVersion
      : undefined;
  if (typeof version === 'number' && version > 1) {
    throw nexusError('E17', 'configuration version is newer than this CLI', {
      reason: `configVersion ${version} is not supported by this CLI (expected 1)`,
      file: label,
      suggestion: 'Upgrade the CLI or lower configVersion to 1.',
    });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw nexusError('E17', 'configuration failed schema validation', {
      reason: zodIssuesToText(parsed.error.issues),
      file: label,
      suggestion: 'Unknown fields and wrong types are rejected; remove or fix the reported fields.',
      evidence: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  validateCommands(parsed.data, label);
  return { config: parsed.data, contentHash: sha256Hex(text.replaceAll('\r\n', '\n')) };
}

/**
 * Loads exactly one configuration source (docs/05-data-model.md 5.8,
 * docs/18-security.md 18.3). Source precedence is deliberately absent: two
 * sources is an error, not a merge.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const { projectRoot, trustConfig = false } = options;
  const rootLevel = findRootLevelConfig(projectRoot);
  if (rootLevel !== null) {
    throw nexusError('E17', 'configuration is in the wrong location', {
      reason: 'configuration must live in .nexus/; the repository root is not accepted',
      file: displayPath(projectRoot, rootLevel),
      suggestion: 'Move it to .nexus/nexus.config.json (or .ts with explicit trust).',
    });
  }

  const jsonPath = path.join(projectRoot, '.nexus', 'nexus.config.json');
  const tsPath = path.join(projectRoot, '.nexus', 'nexus.config.ts');
  const hasJson = fs.existsSync(jsonPath);
  const hasTs = fs.existsSync(tsPath);

  if (hasJson && hasTs) {
    throw nexusError('E17', 'two configuration sources found', {
      reason: 'both .nexus/nexus.config.json and .nexus/nexus.config.ts exist',
      file: '.nexus/nexus.config.json',
      suggestion: 'Delete one of the two files; configs are never merged.',
      evidence: { files: ['.nexus/nexus.config.json', '.nexus/nexus.config.ts'] },
    });
  }

  if (!hasJson && !hasTs) {
    return {
      config: null,
      sourcePath: null,
      sourceKind: 'none',
      contentHash: null,
      authorization: 'none',
      loadDurationMs: 0,
    };
  }

  if (hasJson) {
    const text = fs.readFileSync(jsonPath, 'utf8');
    const { config, contentHash } = parseJsonConfig(projectRoot, jsonPath, text);
    return {
      config,
      sourcePath: jsonPath,
      sourceKind: 'json',
      contentHash,
      authorization: 'none',
      loadDurationMs: 0,
    };
  }

  const text = fs.readFileSync(tsPath, 'utf8');
  const contentHash = sha256Hex(text.replaceAll('\r\n', '\n'));
  const result = await loadTsConfig({
    projectRoot,
    configPath: tsPath,
    contentHash,
    trustForThisProcess: trustConfig,
  });
  validateCommands(result.config, displayPath(projectRoot, tsPath));
  return {
    config: result.config,
    sourcePath: tsPath,
    sourceKind: 'ts',
    contentHash,
    authorization: result.authorization,
    loadDurationMs: result.durationMs,
  };
}
