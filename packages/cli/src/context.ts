import fs from 'node:fs';
import path from 'node:path';

import { nexusError } from 'anemia-core';

export type OutputFormat = 'pretty' | 'lines' | 'json' | 'markdown';

export interface RawGlobalOptions {
  format?: string;
  color?: string | boolean;
  width?: string | number;
  pager?: string;
  compact?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  explain?: boolean;
  noTruncate?: boolean;
  budgetHint?: string | number;
  cursor?: string;
  outputFile?: string;
  root?: string;
  roots?: string;
  yes?: boolean;
  nonInteractive?: boolean;
  trustConfig?: boolean;
}

export interface CliContext {
  projectRoot: string;
  cwd: string;
  isTTY: boolean;
  format: OutputFormat;
  color: boolean;
  width: number;
  pager: 'auto' | 'off';
  compact: boolean;
  verbose: boolean;
  quiet: boolean;
  explain: boolean;
  noTruncate: boolean;
  budgetHint: number | null;
  cursorOffset: number;
  outputFile: string | null;
  root: string | null;
  roots: string | null;
  yes: boolean;
  nonInteractive: boolean;
  trustConfig: boolean;
}

const FORMATS: readonly OutputFormat[] = ['pretty', 'lines', 'json', 'markdown'];

function parseFormat(value: string, source: string): OutputFormat {
  if ((FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw nexusError('E00', `invalid ${source}`, {
    reason: `expected one of ${FORMATS.join(', ')}, received ${JSON.stringify(value)}`,
    suggestion: 'Use --format pretty|lines|json|markdown.',
    evidence: { validValues: [...FORMATS] },
  });
}

function parsePositiveInt(value: string | number | undefined, name: string): number | null {
  if (value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw nexusError('E00', `${name} must be a positive integer`, {
      reason: `received ${JSON.stringify(value)}`,
      suggestion: `Pass ${name} <positive integer>.`,
    });
  }
  return parsed;
}

function decodeCursor(token: string | undefined): number {
  if (token === undefined || token === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const offset = (parsed as Record<string, unknown>).o;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new Error('invalid offset');
    }
    return offset;
  } catch {
    throw nexusError('E00', 'invalid --cursor token', {
      reason: 'cursor is not a valid base64url offset token',
      suggestion: 'Use the nextCursor value returned by a previous command.',
    });
  }
}

function envFormat(): OutputFormat | null {
  const value = process.env.NEXUS_FORMAT;
  if (value === undefined || value === '') return null;
  return parseFormat(value, 'NEXUS_FORMAT');
}

function configFormat(projectRoot: string): OutputFormat | null {
  try {
    const loaded = loadConfigSync(projectRoot);
    return loaded;
  } catch {
    return null;
  }
}

// The format is resolved before a command runs; failures are reported by the
// command itself. This deliberately does not execute TS configs: only the JSON
// file's output.format is used here.
function loadConfigSync(projectRoot: string): OutputFormat | null {
  const configPath = path.join(projectRoot, '.nexus', 'nexus.config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const output = (raw as Record<string, unknown>).output;
    if (typeof output !== 'object' || output === null) return null;
    const format = (output as Record<string, unknown>).format;
    if (format === 'auto' || format === undefined) return null;
    if (typeof format !== 'string') return null;
    return parseFormat(format, 'configuration output.format');
  } catch {
    return null;
  }
}

export function createContext(options: RawGlobalOptions): CliContext {
  const cwd = process.cwd();
  const projectRoot = path.resolve(cwd);
  const isTTY = process.stdout.isTTY === true;
  if (options.root !== undefined && options.roots !== undefined) {
    throw nexusError('E00', '--root and --roots are mutually exclusive', {
      reason: 'both scope selectors were provided',
      suggestion: 'Pass either --root <rootId> or --roots <all|id,id>.',
    });
  }
  const explicitFormat =
    options.format === undefined ? null : parseFormat(options.format, '--format');
  const format =
    explicitFormat ?? envFormat() ?? configFormat(projectRoot) ?? (isTTY ? 'pretty' : 'lines');

  const noColor = options.color === false || process.env.NO_COLOR !== undefined;
  const colorMode = typeof options.color === 'string' ? options.color : 'auto';
  if (options.color !== undefined && typeof options.color === 'string') {
    if (!['auto', 'always', 'never'].includes(options.color)) {
      throw nexusError('E00', 'invalid --color', {
        reason: `expected auto, always or never, received ${JSON.stringify(options.color)}`,
        suggestion: 'Use --color auto|always|never.',
        evidence: { validValues: ['auto', 'always', 'never'] },
      });
    }
  }
  const color = !noColor && (colorMode === 'always' || (colorMode === 'auto' && isTTY));

  const widthOption = parsePositiveInt(options.width, '--width');
  let width = widthOption ?? 120;
  if (widthOption === null) {
    const columns = process.stdout.columns;
    if (typeof columns === 'number' && columns > 0) width = Math.min(columns, 120);
  }

  const pager = isTTY && options.pager !== 'off' ? 'auto' : 'off';
  if (options.pager !== undefined && !['auto', 'off'].includes(options.pager)) {
    throw nexusError('E00', 'invalid --pager', {
      reason: `expected auto or off, received ${JSON.stringify(options.pager)}`,
      suggestion: 'Use --pager auto|off.',
      evidence: { validValues: ['auto', 'off'] },
    });
  }

  const budgetHint = parsePositiveInt(options.budgetHint, '--budget-hint');

  return {
    projectRoot,
    cwd,
    isTTY,
    format,
    color,
    width,
    pager,
    compact: options.compact === true,
    verbose: options.verbose === true,
    quiet: options.quiet === true,
    explain: options.explain === true,
    noTruncate: options.noTruncate === true,
    budgetHint,
    cursorOffset: decodeCursor(options.cursor),
    outputFile: options.outputFile ?? null,
    root: options.root ?? null,
    roots: options.roots ?? null,
    yes: options.yes === true,
    nonInteractive: options.nonInteractive === true,
    trustConfig: options.trustConfig === true,
  };
}

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--compact',
  '--verbose',
  '--quiet',
  '--explain',
  '--no-truncate',
  '--yes',
  '--non-interactive',
  '--trust-config',
  '--no-color',
  '--write-config',
  '--force',
  '--history',
  '--expand',
  '--include-heuristic',
  '--no-template',
  '--rebuild',
  '--serial',
  '--rebuild-affected',
  '--public',
  '--internal',
  '--schema',
  '--mcp',
  '--repair',
  '--json-schema',
  '--reverse',
  '--dry-run',
  '--watch',
  '--read-only',
  '--auto-bootstrap',
]);
