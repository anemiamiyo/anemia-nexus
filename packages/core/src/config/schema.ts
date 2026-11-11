import { z } from 'zod';

const safeRelativePattern = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value), {
    message: 'must be a project-relative pattern, not an absolute path',
  })
  .refine((value) => !value.split(/[\\/]/).includes('..'), {
    message: 'must not contain ".." path segments',
  });

export const ignoreSchema = z.strictObject({
  dirs: z.array(safeRelativePattern).default([]),
  files: z.array(safeRelativePattern).default([]),
  globs: z.array(safeRelativePattern).default([]),
  include: z.array(safeRelativePattern).default([]),
  modes: z.array(z.enum(['build', 'update', 'watch'])).default(['build', 'update', 'watch']),
  pruneWatcher: z.boolean().default(true),
});

export const budgetsSchema = z.strictObject({
  maxTokens: z.number().int().positive().default(8000),
  maxFiles: z.number().int().positive().default(200),
});

export const outputSchema = z.strictObject({
  format: z.enum(['auto', 'pretty', 'lines', 'json', 'markdown']).default('auto'),
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  width: z.number().int().positive().default(120),
  pager: z.enum(['auto', 'off']).default('auto'),
});

export const defaultsSchema = z.strictObject({
  ignore: ignoreSchema.default(() => ignoreSchema.parse({})),
  budgets: budgetsSchema.default(() => budgetsSchema.parse({})),
  output: outputSchema.default(() => outputSchema.parse({})),
});

export const workspacesSchema = z.strictObject({
  mode: z.enum(['prompt', 'all']).default('prompt'),
  roots: z.array(z.string().min(1)).default([]),
  exclude: z.array(safeRelativePattern).default([]),
  followTsReferences: z.boolean().default(false),
});

export const rootOverrideSchema = z.strictObject({
  ignore: ignoreSchema.partial().optional(),
  budgets: budgetsSchema.partial().optional(),
  output: outputSchema.partial().optional(),
  include: z.array(safeRelativePattern).optional(),
});

export const styleSchema = z.strictObject({
  aliases: z.record(z.string(), z.string()).default({}),
  extensions: z.array(z.enum(['.css', '.scss', '.less'])).default(['.css', '.scss', '.less']),
  html: z.boolean().default(false),
});

export const vueSchema = z.strictObject({
  typeResolver: z.string().min(1).nullable().default(null),
});

export const commandSchema = z.strictObject({
  id: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: safeRelativePattern.default('.'),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
});

export const commandsSchema = z.strictObject({
  allow: z.array(commandSchema).default([]),
});

export const configSchema = z.strictObject({
  configVersion: z.literal(1),
  defaults: defaultsSchema.default(() => defaultsSchema.parse({})),
  workspaces: workspacesSchema.default(() => workspacesSchema.parse({})),
  roots: z.record(z.string(), rootOverrideSchema).default({}),
  style: styleSchema.default(() => styleSchema.parse({})),
  vue: vueSchema.default(() => vueSchema.parse({})),
  commands: commandsSchema.default(() => commandsSchema.parse({})),
});

export type NexusConfig = z.infer<typeof configSchema>;
export type IgnoreConfig = z.infer<typeof ignoreSchema>;
export type BudgetsConfig = z.infer<typeof budgetsSchema>;
export type OutputConfig = z.infer<typeof outputSchema>;
export type WorkspacesConfig = z.infer<typeof workspacesSchema>;
export type CommandConfig = z.infer<typeof commandSchema>;
export type RootOverride = z.infer<typeof rootOverrideSchema>;

export const DEFAULT_CONFIG: NexusConfig = configSchema.parse({ configVersion: 1 });
