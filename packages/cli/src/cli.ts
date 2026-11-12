import fs from 'node:fs';
import path from 'node:path';

import {
  buildWorkspace,
  nexusError,
  mapUnknownError,
  exitCodeForError,
  isNexusError,
  loadConfig,
  runDoctor,
  runInit,
  dumpVueMap,
  queryReferences,
  querySearch,
  querySymbol,
  statusReport,
  writeBaselineSnapshot,
  diffCurrentSurface,
  type BuildProgressEvent,
  type Coverage,
  type QueryEnvelope,
  type StatusReport,
} from 'anemia-core';
import { Command, CommanderError } from 'commander';

import { BOOLEAN_FLAGS, createContext, type CliContext, type OutputFormat } from './context.js';
import { PACKAGE_NAME, PACKAGE_VERSION, versionText } from './version.js';
import { renderError, renderOutput } from './render.js';

interface ActionOutcome {
  data: Record<string, unknown>;
  exitCode: number;
  skipRender?: boolean;
}

type ActionHandler = (context: CliContext, command: Command) => Promise<ActionOutcome>;

function fallbackFormat(): OutputFormat {
  return process.stdout.isTTY === true ? 'pretty' : 'lines';
}

function writeStdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

function writeStderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function reportError(error: unknown, format: OutputFormat): number {
  const nexus = mapUnknownError(error);
  const exitCode = nexus.code === 'E23' ? 70 : exitCodeForError(nexus);
  writeStdout(renderError(nexus, format, exitCode));
  return exitCode;
}

async function execute(command: Command, handler: ActionHandler): Promise<void> {
  let context: CliContext;
  try {
    context = createContext(command.optsWithGlobals());
  } catch (error) {
    process.exitCode = reportError(error, fallbackFormat());
    return;
  }
  try {
    const outcome = await handler(context, command);
    if (context.compact && context.format === 'pretty' && !context.quiet) {
      writeStderr('--compact is ignored with --format pretty');
    }
    if (context.verbose && !context.quiet) {
      writeStderr(`format=${context.format} root=${context.root ?? context.roots ?? 'activeRoot'}`);
    }
    if (context.cursorOffset > 0) {
      const items = outcome.data.items;
      if (Array.isArray(items)) {
        const remaining = items.slice(context.cursorOffset);
        outcome.data = {
          ...outcome.data,
          items: remaining,
          truncated: true,
          nextCursor: null,
          notes: [
            ...(Array.isArray(outcome.data.notes) ? outcome.data.notes.map(String) : []),
            `cursor offset ${context.cursorOffset} applied`,
          ],
        };
        const counts = outcome.data.counts;
        if (typeof counts === 'object' && counts !== null) {
          outcome.data.counts = {
            ...(counts as Record<string, unknown>),
            returned: remaining.length,
          };
        }
      }
    }
    if (outcome.skipRender === true) {
      process.exitCode = outcome.exitCode;
      return;
    }
    const renderCommand =
      typeof outcome.data.command === 'string' ? outcome.data.command : command.name();
    const text = renderOutput({ command: renderCommand, data: outcome.data }, context.format, {
      color: context.color,
      width: context.width,
      explain: context.explain,
    });
    if (context.outputFile !== null) {
      const target = path.resolve(context.cwd, context.outputFile);
      fs.writeFileSync(target, `${text}\n`, 'utf8');
      if (!context.quiet) writeStderr(`wrote ${context.outputFile}`);
    } else {
      writeStdout(text);
    }
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.exitCode = reportError(error, context.format);
  }
}

function progressReporter(context: CliContext): (event: BuildProgressEvent) => void {
  return (event) => {
    if (context.quiet) return;
    const prefix = event.rootId === '' ? 'build' : event.rootId;
    writeStderr(`[${prefix}] ${event.message}`);
  };
}

function emptyCoverage(): Coverage {
  return {
    filesCovered: 0,
    filesSkipped: 0,
    filesIgnored: 0,
    filesFailed: 0,
    resolved: 0,
    unresolved: 0,
    unmapped: 0,
    filteredInternal: 0,
  };
}

function emptyCounts(total: number): Record<string, number> {
  return { total, returned: total, certain: 0, heuristic: 0, dynamicUnresolved: 0, partial: 0 };
}

function envelopeFields(envelope: QueryEnvelope<unknown>): Record<string, unknown> {
  return {
    counts: envelope.counts,
    coverage: envelope.coverage,
    truncated: envelope.truncated,
    nextCursor: envelope.nextCursor,
    staleness: envelope.staleness,
    buildFingerprint: envelope.buildFingerprint,
    identityAmbiguous: envelope.identityAmbiguous,
    degraded: envelope.degraded,
    items: envelope.items,
    warnings: envelope.warnings,
    budget: envelope.budget,
    mode: envelope.mode,
    notes: envelope.notes,
  };
}

function selfInfo(context: CliContext): StatusReport['self'] {
  const invoked = process.argv[1] ?? '';
  const relative = path.relative(context.projectRoot, invoked).replaceAll('\\', '/');
  const binaryPath =
    relative === '' || relative.startsWith('..') ? path.basename(invoked) : relative;
  return {
    serverVersion: PACKAGE_VERSION,
    packageName: PACKAGE_NAME,
    binaryPath,
    projectRoot: '.',
    nodeVersion: process.versions.node,
  };
}

function addExamples(command: Command, examples: readonly string[]): Command {
  return command.addHelpText(
    'after',
    `\nExamples:\n${examples.map((example) => `  ${example}`).join('\n')}\n`,
  );
}

function versionString(context: { projectRoot: string }): string {
  let suffix = '';
  try {
    const rootsDir = path.join(context.projectRoot, '.nexus', 'roots');
    if (fs.existsSync(rootsDir)) {
      for (const entry of fs.readdirSync(rootsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(rootsDir, entry.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
        if (typeof raw === 'object' && raw !== null) {
          const fingerprint = (raw as Record<string, unknown>).buildFingerprint;
          if (typeof fingerprint === 'string' && fingerprint.length > 3) {
            suffix = `\nbuild ${fingerprint.slice(0, 12)}`;
            break;
          }
        }
      }
    }
  } catch {
    // version output must not fail
  }
  return `${versionText()}${suffix}`;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('nex')
    .description(
      'Anemia Nexus — deterministic index for change audit and API governance (Phase 01)',
    )
    .version(
      versionString({ projectRoot: process.cwd() }),
      '-v, --version',
      'print package, Node and build fingerprint',
    )
    .option('--format <fmt>', 'output format: pretty | lines | json | markdown')
    .option('--color <mode>', 'color mode for pretty: auto | always | never')
    .option('--no-color', 'disable color (same as --color never)')
    .option('--width <n>', 'pretty width (default: min(COLUMNS, 120))')
    .option('--pager <mode>', 'pretty pager: auto | off')
    .option('--compact', 'compact output (ignored with pretty)')
    .option('--verbose', 'write diagnostics to stderr')
    .option('--quiet', 'suppress progress and hints')
    .option('--explain', 'include relation evidence')
    .option('--no-truncate', 'request complete output')
    .option('--budget-hint <tokens>', 'soft token budget hint')
    .option('--cursor <token>', 'continue from a cursor token')
    .option('--output-file <path>', 'write the result to an explicit file')
    .option('--root <rootId>', 'select one root')
    .option('--roots <sel>', 'select roots: all or comma-separated ids')
    .option('--yes', 'answer yes to confirmations')
    .option('--non-interactive', 'never wait for input')
    .option('--trust-config', 'trust the TypeScript config for this process only')
    .enablePositionalOptions(false);

  program.configureHelp({ sortSubcommands: false, sortOptions: false });
  program.showSuggestionAfterError(true);

  const init = addExamples(
    program
      .command('init')
      .description('discover roots, print candidates, write .nexus/ configuration')
      .helpGroup('Lifecycle')
      .option('--roots <sel>', 'select roots: all or comma-separated ids')
      .option('--write-config', 'write .nexus/ configuration')
      .option('--force', 'overwrite an existing configuration')
      .option('--no-typecheck', 'skip independent tsc verification (not recommended)'),
    ['nex init --roots all', 'nex init --roots ui,docs --write-config --yes'],
  );
  init.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const result = await runInit({
        projectRoot: context.projectRoot,
        roots: typeof opts.roots === 'string' ? opts.roots : null,
        writeConfig: opts.writeConfig === true,
        yes: context.yes,
        force: opts.force === true,
        nonInteractive: context.nonInteractive || process.stdin.isTTY !== true,
        skipTypecheck: opts.typecheck === false,
      });
      return {
        data: {
          command: 'init',
          written: result.written,
          wouldWrite: result.wouldWrite,
          existingConfig: result.existingConfig,
          selected: result.selected,
          candidates: result.candidates,
          messages: result.messages,
          counts: emptyCounts(result.candidates.length),
          coverage: emptyCoverage(),
          truncated: false,
          nextCursor: null,
          staleness: 'uninitialized',
          buildFingerprint: null,
          degraded: [],
          notes: result.messages,
          guidance: result.written
            ? ['nex build', 'nex status']
            : ['nex init --roots all --write-config --yes'],
        },
        exitCode: 0,
      };
    });
  });

  const build = addExamples(
    program
      .command('build')
      .description('run a full build for every selected root')
      .helpGroup('Lifecycle')
      .option('--serial', 'build roots serially (Phase 01 is serial)')
      .option('--rebuild', 'force a full rebuild')
      .option('--budget-mb <n>', 'per-root memory budget hint'),
    ['nex build', 'nex build --serial --format json'],
  );
  build.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      if (opts.budgetMb !== undefined) {
        const parsed = Number.parseInt(String(opts.budgetMb), 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw nexusError('E00', '--budget-mb must be a positive integer', {
            reason: `received ${JSON.stringify(opts.budgetMb)}`,
            suggestion: 'Pass --budget-mb <positive integer>.',
          });
        }
      }
      // Config load is explicit here so a missing/unsafe config fails before scanning.
      const loadedConfig = await loadConfig({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      const result = await buildWorkspace({
        projectRoot: context.projectRoot,
        loadedConfig,
        onProgress: progressReporter(context),
        serial: opts.serial === true,
      });
      const failedRoots = result.failedRoots;
      const coverage = emptyCoverage();
      let symbols = 0;
      let certain = 0;
      let unresolved = 0;
      const degraded = new Set<string>();
      for (const root of result.roots) {
        if (!root.ok || root.coverage === null) continue;
        coverage.filesCovered += root.coverage.filesCovered;
        coverage.filesSkipped += root.coverage.filesSkipped;
        coverage.filesIgnored += root.coverage.filesIgnored;
        coverage.filesFailed += root.coverage.filesFailed;
        coverage.resolved += root.coverage.resolved;
        coverage.unresolved += root.coverage.unresolved;
        coverage.unmapped += root.coverage.unmapped;
        coverage.filteredInternal += root.coverage.filteredInternal ?? 0;
        symbols += root.symbols;
        certain += root.coverage.resolved;
        unresolved += root.coverage.unresolved;
        for (const entry of root.degraded) degraded.add(entry);
      }
      return {
        data: {
          command: 'build',
          roots: result.roots,
          failedRoots,
          totalMs: result.totalMs,
          counts: {
            total: symbols,
            returned: symbols,
            certain,
            heuristic: 0,
            dynamicUnresolved: 0,
            partial: unresolved,
          },
          coverage,
          truncated: false,
          nextCursor: null,
          staleness: failedRoots.length > 0 ? 'stale' : 'fresh',
          buildFingerprint: result.roots.find((root) => root.ok)?.buildFingerprint ?? null,
          degraded: [...degraded].sort(),
          notes: failedRoots.length > 0 ? [`failed roots: ${failedRoots.join(', ')}`] : [],
        },
        exitCode: failedRoots.length > 0 ? 1 : 0,
      };
    });
  });

  const status = addExamples(
    program
      .command('status')
      .description('index state, coverage, capabilities (never fails)')
      .helpGroup('Lifecycle')
      .option('--json-schema', 'print the status output schema (not provided)'),
    ['nex status', 'nex status --format json'],
  );
  status.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      if (opts.jsonSchema === true) {
        throw nexusError('E24', 'status output schema is not provided in Phase 01', {
          reason: 'the versioned status JSON Schema arrives with the full output contract',
          suggestion: 'Use `nex doctor --schema` for the configuration schema.',
        });
      }
      const report = await statusReport({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        trustConfig: context.trustConfig,
        self: selfInfo(context),
      });
      return {
        data: {
          command: 'status',
          state: report.state,
          staleness: report.staleness,
          activeRoot: report.activeRoot,
          roots: report.roots,
          coverage: report.coverage,
          counts: report.counts,
          capabilities: report.capabilities,
          self: report.self,
          config: report.config,
          guidance: report.guidance,
          warnings: report.warnings,
          projectRoot: report.projectRoot,
          truncated: false,
          nextCursor: null,
          buildFingerprint: null,
          degraded: [...new Set(report.roots.flatMap((root) => root.degraded))].sort(),
          notes: [],
        },
        exitCode: 0,
      };
    });
  });

  const doctor = addExamples(
    program
      .command('doctor')
      .description('diagnose environment, configuration, database and consistency')
      .helpGroup('Lifecycle')
      .option('--schema', 'print the configuration JSON Schema')
      .option('--mcp', 'MCP diagnostics (not provided)')
      .option('--dump-vue-map <file>', 'print the Vue projection and offset mapping')
      .option('--repair', 'repair Nexus data (not provided)'),
    ['nex doctor', 'nex doctor --schema'],
  );
  doctor.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      if (opts.mcp === true) {
        throw nexusError('E24', 'doctor --mcp is not provided in Phase 01', {
          reason: 'MCP diagnostics arrive with the MCP server in Phase 07',
          suggestion: 'Use `nex status` for indexing state.',
        });
      }
      if (typeof opts.dumpVueMap === 'string') {
        const dump = dumpVueMap({
          projectRoot: context.projectRoot,
          file: opts.dumpVueMap,
        });
        writeStdout(JSON.stringify(dump, null, 2));
        return { data: {}, exitCode: 0, skipRender: true };
      }
      if (opts.repair === true) {
        throw nexusError('E24', 'doctor --repair is not provided in Phase 01', {
          reason: 'Phase 01 doctor is read-only',
          suggestion: 'Delete the root index and rebuild; data is a derived artifact.',
        });
      }
      if (opts.schema === true) {
        const report = await runDoctor({ projectRoot: context.projectRoot, schemaOnly: true });
        writeStdout(JSON.stringify(report.schema ?? {}, null, 2));
        return { data: {}, exitCode: 0, skipRender: true };
      }
      const report = await runDoctor({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      return {
        data: {
          command: 'doctor',
          checks: report.checks,
          summary: report.summary,
          roots: report.roots,
          schema: null,
          counts: emptyCounts(report.checks.length),
          coverage: emptyCoverage(),
          truncated: false,
          nextCursor: null,
          staleness: report.exitCode === 0 ? 'fresh' : 'stale',
          buildFingerprint: null,
          degraded: [],
          notes: [],
        },
        exitCode: report.exitCode,
      };
    });
  });

  const symbol = addExamples(
    program
      .command('symbol <identifier>')
      .description('symbol details by name or symbolId')
      .helpGroup('Query')
      .option('--history', 'include identity history')
      .option('--expand', 'include a source excerpt'),
    ['nex symbol useButton', 'nex symbol s_7f3k9m2q1x8b4c6d --history'],
  );
  symbol.action(async (identifier: string, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const result = await querySymbol(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
        },
        identifier,
        opts.history === true,
      );
      let source: string[] | null = null;
      if (opts.expand === true) {
        const absolute = path.resolve(context.projectRoot, result.symbol.path);
        const relative = path.relative(context.projectRoot, absolute);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          try {
            const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
            const start = Math.max(0, result.symbol.declarationLocator.startLine - 1);
            source = lines.slice(start, start + 60);
          } catch {
            source = null;
          }
        }
      }
      const data = {
        command: 'symbol',
        ...envelopeFields(result.envelope),
        counts: { ...result.envelope.counts, total: 1, returned: 1, certain: 1 },
        symbol: result.envelope.items[0] ?? null,
        source,
      };
      return { data, exitCode: 0 };
    });
  });

  const references = addExamples(
    program
      .command('references <identifier>')
      .description('complete reference set for one symbol')
      .helpGroup('Query')
      .option('--no-template', 'exclude Vue template edges')
      .option('--depth <n>', 'relation depth')
      .option('--include-heuristic', 'include heuristic edges'),
    ['nex references useButton', 'nex references s_7f3k9m2q1x8b4c6d --format json'],
  );
  references.action(async (identifier: string, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const result = await queryReferences(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
        },
        identifier,
        opts.includeHeuristic === true,
        opts.template !== false,
      );
      return {
        data: {
          command: 'references',
          ...envelopeFields(result.envelope),
          symbol: result.envelope.items[0]?.symbolName ?? null,
        },
        exitCode: 0,
      };
    });
  });

  const search = addExamples(
    program
      .command('search [term]')
      .description('search symbols by name, kind or path')
      .helpGroup('Query')
      .option('--type <kind>', 'symbol kind')
      .option('--path <dir>', 'restrict to a path prefix')
      .option('--public', 'public symbols only')
      .option('--internal', 'internal symbols only'),
    ['nex search useButton', 'nex search --type fn --path src/'],
  );
  search.action(async (term: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      if (opts.public === true && opts.internal === true) {
        throw nexusError('E00', '--public and --internal are mutually exclusive', {
          reason: 'both filters were provided',
          suggestion: 'Pass either --public or --internal.',
        });
      }
      const result = await querySearch(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
        },
        term ?? '',
        {
          kind: typeof opts.type === 'string' ? opts.type : undefined,
          pathPrefix: typeof opts.path === 'string' ? opts.path : undefined,
          publicOnly: opts.public === true ? true : opts.internal === true ? false : undefined,
        },
      );
      return {
        data: { command: 'search', ...envelopeFields(result.envelope) },
        exitCode: 0,
      };
    });
  });

  const queryAlias = program
    .command('query [term]', { hidden: true })
    .description('compatibility alias for search');
  queryAlias.action(async (term: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const result = await querySearch(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
        },
        term ?? '',
        {},
      );
      return { data: { command: 'search', ...envelopeFields(result.envelope) }, exitCode: 0 };
    });
  });

  const apiSnapshot = addExamples(
    program
      .command('api-snapshot')
      .description('write nexus.baseline.json from the current API Surface')
      .helpGroup('Governance')
      .option('--yes', 'overwrite an existing baseline without prompting'),
    ['nex api-snapshot --yes', 'nex api-snapshot --root ui'],
  );
  apiSnapshot.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const loaded = await loadConfig({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      const result = writeBaselineSnapshot({
        projectRoot: context.projectRoot,
        loadedConfig: loaded,
        rootId: context.root,
        yes: context.yes,
      });
      const roots = Object.keys(result.baseline.roots)
        .sort()
        .map((rootId) => {
          const root = result.baseline.roots[rootId];
          return {
            rootId,
            entries: root?.entries.length ?? 0,
            internal: root?.internal.length ?? 0,
            opaque: root?.opaque.length ?? 0,
            deprecated: root?.deprecated.length ?? 0,
            surfaceHash: root?.surfaceHash ?? null,
          };
        });
      return {
        data: {
          command: 'api-snapshot',
          path: result.path,
          overwritten: result.overwritten,
          surfaceHash: result.surfaceHash,
          counts: {
            total: roots.reduce((sum, root) => sum + root.entries, 0),
            roots: roots.length,
            entries: roots.reduce((sum, root) => sum + root.entries, 0),
            internal: roots.reduce((sum, root) => sum + root.internal, 0),
            deprecated: roots.reduce((sum, root) => sum + root.deprecated, 0),
          },
          roots,
        },
        exitCode: 0,
      };
    });
  });

  const apiDiff = addExamples(
    program
      .command('api-diff')
      .description('semantic diff of the current API Surface against a baseline')
      .helpGroup('Governance')
      .option('--base <ref|file>', 'baseline file or git ref')
      .option('--fail-on <level>', 'breaking|additive|ambiguous', 'breaking'),
    ['nex api-diff', 'nex api-diff --base HEAD~1 --fail-on breaking'],
  );
  apiDiff.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const failOn = typeof opts.failOn === 'string' ? opts.failOn : 'breaking';
      if (!['breaking', 'additive', 'ambiguous'].includes(failOn)) {
        throw nexusError('E00', 'invalid --fail-on value', {
          reason: `expected breaking, additive or ambiguous, received ${JSON.stringify(failOn)}`,
          suggestion: 'Use --fail-on breaking|additive|ambiguous.',
        });
      }
      const loaded = await loadConfig({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      const result = diffCurrentSurface({
        projectRoot: context.projectRoot,
        loadedConfig: loaded,
        rootId: context.root,
        base: typeof opts.base === 'string' ? opts.base : null,
      });
      const rank: Record<string, number> = { breaking: 3, additive: 2, ambiguous: 1 };
      const threshold = rank[failOn] ?? 3;
      const blocking = result.diff.items.filter(
        (entry) => entry.severity !== 'internal' && (rank[entry.severity] ?? 0) >= threshold,
      );
      const warningsOnly =
        blocking.length === 0 && result.diff.items.some((entry) => entry.severity === 'ambiguous');
      const exitCode = blocking.length > 0 ? 1 : warningsOnly ? 2 : 0;
      return {
        data: {
          command: 'api-diff',
          base: result.baseLabel,
          surfaceHash: result.diff.surfaceHash,
          baselineSurfaceHash: result.diff.baselineSurfaceHash,
          failOn,
          exitCode,
          counts: result.diff.counts,
          items: result.diff.items,
          warnings: result.diff.warnings,
          notes: result.diff.notes,
        },
        exitCode,
      };
    });
  });

  const stubs: Array<[string, string, string]> = [
    ['update', 'incremental update (not provided)', 'Lifecycle'],
    ['deps', 'dependency and architecture view (not provided)', 'Query'],
    ['impact', 'change impact analysis (not provided)', 'Query'],
    ['context', 'layered context packets (not provided)', 'Query'],
    ['similar', 'similar API search (not provided)', 'Governance'],
    ['audit-duplicates', 'duplicate implementation audit (not provided)', 'Governance'],
    ['preflight', 'pre-change audit (not provided)', 'Audit'],
    ['postflight', 'post-change audit (not provided)', 'Audit'],
    ['verify', 'authorized command orchestration (not provided)', 'Audit'],
    ['print', 'print integration assets (not provided)', 'Access'],
    ['mcp', 'MCP server (not provided)', 'Access'],
    ['test', 'fixture and consistency tests (not provided)', 'Test'],
  ];
  for (const [name, description, group] of stubs) {
    const stub = program
      .command(name)
      .description(`${description} [not implemented]`)
      .helpGroup(group)
      .allowUnknownOption(true)
      .allowExcessArguments(true);
    stub.action(async (_options, command: Command) => {
      await execute(command, async () => {
        throw nexusError('E24', `${name} is not provided in Phase 01`, {
          reason: 'this capability belongs to a later phase',
          suggestion:
            'Phase 01 implements init, build, status, doctor, symbol, references and search.',
        });
      });
    });
  }

  for (const [name, asset] of [
    ['mcp-config', 'mcp-config'],
    ['agents', 'agents'],
    ['skill', 'skill'],
  ] as const) {
    const alias = program
      .command(`${name} [args...]`, { hidden: true })
      .description(`compatibility alias for print ${asset}`)
      .allowUnknownOption(true)
      .allowExcessArguments(true);
    alias.action(async (_args: string[], _options, command: Command) => {
      await execute(command, async () => {
        throw nexusError('E24', `print ${asset} is not provided in Phase 01`, {
          reason: 'integration materials arrive in Phase 07',
          suggestion: 'No integration asset is generated by this build.',
        });
      });
    });
  }

  program.addHelpText(
    'after',
    `
Compatibility aliases (not shown above):
  query        -> search
  mcp-config   -> print mcp-config
  agents       -> print agents
  skill        -> print skill

Phase 03 implements: init, build, status, doctor, symbol, references, search, api-snapshot, api-diff.
Other commands return E24 "not provided"; they never return fake data.
`,
  );

  program.exitOverride();
  return program;
}

function nodeVersionSatisfied(): boolean {
  const [majorRaw, minorRaw] = process.versions.node.split('.');
  const major = Number.parseInt(majorRaw ?? '0', 10);
  const minor = Number.parseInt(minorRaw ?? '0', 10);
  return major > 22 || (major === 22 && minor >= 16);
}

function prevalidateArgv(argv: readonly string[]): void {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) continue;
    const equals = argument.indexOf('=');
    if (equals === -1) continue;
    const flag = argument.slice(0, equals);
    if (BOOLEAN_FLAGS.has(flag)) {
      throw nexusError('E00', `${flag} does not accept a value`, {
        reason: 'boolean flags use --flag / --no-flag, not --flag=value',
        suggestion: `Use ${flag} without =value.`,
      });
    }
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  if (!nodeVersionSatisfied()) {
    const error = nexusError('E14', 'Node.js version is below the supported minimum', {
      reason: `current ${process.versions.node}, required >= 22.16.0`,
      suggestion: 'Upgrade Node.js to 22.16.0 or newer (nvm install 22.16.0).',
    });
    writeStdout(renderError(error, fallbackFormat(), 1));
    return 1;
  }
  try {
    prevalidateArgv(argv);
  } catch (error) {
    return reportError(error, fallbackFormat());
  }
  const program = buildProgram();
  try {
    await program.parseAsync([...argv], { from: 'node' });
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.help' ||
        error.code === 'commander.version'
      ) {
        return 0;
      }
      const usage = nexusError('E00', 'invalid command line', {
        reason: error.message,
        suggestion: 'Run `nex --help` or `nex <command> --help` for valid arguments.',
      });
      return reportError(usage, fallbackFormat());
    }
    if (isNexusError(error)) return reportError(error, fallbackFormat());
    return reportError(error, fallbackFormat());
  }
}
