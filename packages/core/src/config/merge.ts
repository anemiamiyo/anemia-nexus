import { stableStringify } from '../util/stable-json.js';
import { sha256Hex } from '../util/hash.js';
import { BUILTIN_IGNORE_DIRS, BUILTIN_IGNORE_FILES, BUILTIN_IGNORE_GLOBS } from './builtin.js';
import type {
  BudgetsConfig,
  IgnoreConfig,
  NexusConfig,
  OutputConfig,
  RootOverride,
  SurfaceConfig,
} from './schema.js';

export interface EffectiveRootConfig {
  rootId: string;
  ignore: IgnoreConfig;
  budgets: BudgetsConfig;
  output: OutputConfig;
  style: NexusConfig['style'];
  surface: SurfaceConfig;
  vue: NexusConfig['vue'];
  commands: NexusConfig['commands'];
  configHash: string;
  ignoreHash: string;
  builtinIgnore: {
    dirs: readonly string[];
    files: readonly string[];
    globs: readonly string[];
  };
  configSources: {
    builtin: string[];
    defaults: string[];
    root: string[];
  };
}

function mergeIgnore(
  defaults: IgnoreConfig,
  override: RootOverride['ignore'],
): { ignore: IgnoreConfig; sources: { builtin: string[]; defaults: string[]; root: string[] } } {
  const root = override ?? {};
  const dirs = dedupe([...BUILTIN_IGNORE_DIRS, ...defaults.dirs, ...(root.dirs ?? [])]);
  const files = dedupe([...BUILTIN_IGNORE_FILES, ...defaults.files, ...(root.files ?? [])]);
  const globs = dedupe([...BUILTIN_IGNORE_GLOBS, ...defaults.globs, ...(root.globs ?? [])]);
  const include = dedupe([...defaults.include, ...(root.include ?? [])]);
  return {
    ignore: {
      dirs,
      files,
      globs,
      include,
      modes: root.modes ?? defaults.modes,
      pruneWatcher: root.pruneWatcher ?? defaults.pruneWatcher,
    },
    sources: {
      builtin: [...BUILTIN_IGNORE_DIRS, ...BUILTIN_IGNORE_FILES, ...BUILTIN_IGNORE_GLOBS],
      defaults: [...defaults.dirs, ...defaults.files, ...defaults.globs, ...defaults.include],
      root: [
        ...(root.dirs ?? []),
        ...(root.files ?? []),
        ...(root.globs ?? []),
        ...(root.include ?? []),
      ],
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

/**
 * Merge priority: builtin baseline → `defaults` → `roots.<rootId>`
 * (docs/05-data-model.md 5.8.1). Later layers override scalars; ignore lists
 * are additive and the builtin baseline can never be removed.
 */
export function resolveRootConfig(
  config: NexusConfig,
  rootId: string,
  rootOverride?: RootOverride,
): EffectiveRootConfig {
  const override = rootOverride ?? config.roots[rootId];
  const { ignore, sources } = mergeIgnore(config.defaults.ignore, override?.ignore);
  const budgets: BudgetsConfig = { ...config.defaults.budgets, ...(override?.budgets ?? {}) };
  const output: OutputConfig = { ...config.defaults.output, ...(override?.output ?? {}) };
  const surface: SurfaceConfig = {
    entries: override?.surface?.entries ?? config.surface.entries,
    manual: override?.surface?.manual ?? config.surface.manual,
    baselinePath: override?.surface?.baselinePath ?? config.surface.baselinePath,
  };
  const effective = {
    configVersion: config.configVersion,
    rootId,
    ignore,
    budgets,
    output,
    style: config.style,
    surface,
    vue: config.vue,
    commands: config.commands,
  };
  return {
    rootId,
    ignore,
    budgets,
    output,
    style: config.style,
    surface,
    vue: config.vue,
    commands: config.commands,
    configHash: sha256Hex(stableStringify(effective)),
    ignoreHash: sha256Hex(stableStringify(ignore)),
    builtinIgnore: {
      dirs: BUILTIN_IGNORE_DIRS,
      files: BUILTIN_IGNORE_FILES,
      globs: BUILTIN_IGNORE_GLOBS,
    },
    configSources: sources,
  };
}

export function configSetHash(configs: readonly EffectiveRootConfig[]): string {
  const canonical = [...configs]
    .map((entry) => ({ rootId: entry.rootId, configHash: entry.configHash }))
    .sort((left, right) => (left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0));
  return sha256Hex(stableStringify(canonical));
}
