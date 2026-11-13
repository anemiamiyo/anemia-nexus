import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  buildWorkspace,
  nexusError,
  mapUnknownError,
  exitCodeForError,
  isNexusError,
  loadConfig,
  runDoctor,
  runDoctorRepair,
  runInit,
  dumpVueMap,
  queryReferences,
  querySearch,
  querySymbol,
  queryDependencies,
  statusReport,
  analyzeImpact,
  impactData,
  runPreflight,
  runPostflight,
  runVerify,
  runSimilar,
  runAuditDuplicates,
  runContext,
  type BuildProgressEvent,
  writeBaselineSnapshot,
  diffCurrentSurface,
  type Coverage,
  type DependencyQueryType,
  type QueryEnvelope,
  type StatusReport,
} from 'anemia-core';
import { startMcpServer } from 'anemia-mcp';
import { Command, CommanderError } from 'commander';

import { BOOLEAN_FLAGS, createContext, type CliContext, type OutputFormat } from './context.js';
import {
  agentsAsset,
  clientTarget,
  isPrintAsset,
  isPrintClient,
  mcpConfigAsset,
  skillAsset,
  type PrintAsset,
} from './assets.js';
import { probeMcpServer, withProbeDirectory } from './mcp-probe.js';
import { PACKAGE_NAME, PACKAGE_VERSION, versionText } from './version.js';
import { renderError, renderOutput } from './render.js';

interface ActionOutcome {
  data: Record<string, unknown>;
  exitCode: number;
  skipRender?: boolean;
  format?: OutputFormat;
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
    const text = renderOutput(
      { command: renderCommand, data: outcome.data },
      outcome.format ?? context.format,
      {
        color: context.color,
        width: context.width,
        explain: context.explain,
      },
    );
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

/** Global `--root` / `--roots` for lifecycle commands; undefined means all. */
function selectedRootIds(opts: Record<string, unknown>): string[] | undefined {
  const roots = typeof opts.roots === 'string' ? opts.roots.trim() : '';
  if (roots !== '' && roots !== 'all') {
    return roots
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  const root = typeof opts.root === 'string' ? opts.root.trim() : '';
  if (root !== '') return [root];
  return undefined;
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
    scope: envelope.scope,
    byRoot: envelope.byRoot,
    globalAmbiguous: envelope.globalAmbiguous,
    staleRoots: envelope.staleRoots,
    failedRoots: envelope.failedRoots,
    completeness: envelope.completeness,
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

function confirmRepair(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Repair .nexus/ derived data only? [y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
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
      'Anemia Nexus — deterministic index for change audit and API governance (Phase 05)',
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

  const emitPrint = (
    context: CliContext,
    asset: PrintAsset,
    clientValue: unknown,
  ): ActionOutcome => {
    if (context.outputFile !== null) {
      throw nexusError('E00', 'print never writes files', {
        reason: '--output-file was provided, but integration assets are stdout-only',
        suggestion: 'Redirect stdout yourself if you need a file.',
      });
    }
    const clientRaw = clientValue === undefined ? 'dsh' : clientValue;
    if (asset === 'mcp-config') {
      if (typeof clientRaw !== 'string' || !isPrintClient(clientRaw)) {
        throw nexusError('E00', 'invalid --client value', {
          reason: `expected dsh, claude or cursor, received ${JSON.stringify(clientRaw)}`,
          suggestion: 'Use --client dsh|claude|cursor.',
        });
      }
      process.stdout.write(mcpConfigAsset(clientRaw));
      if (!context.quiet) {
        writeStderr(`Merge this JSON into ${clientTarget(clientRaw)}; nothing was written.`);
      }
    } else {
      if (clientValue !== undefined) {
        throw nexusError('E00', '--client is only valid with mcp-config', {
          reason: `received --client ${JSON.stringify(clientValue)} for ${asset}`,
          suggestion: `Run \`nex print ${asset}\` without --client.`,
        });
      }
      process.stdout.write(asset === 'agents' ? agentsAsset() : skillAsset());
      if (!context.quiet) writeStderr('Printed to stdout only; nothing was written.');
    }
    return { data: {}, exitCode: 0, skipRender: true };
  };

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
        selectedRootIds: selectedRootIds(opts),
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

  const update = addExamples(
    program
      .command('update')
      .description('incremental update: content-hash change detection per root')
      .helpGroup('Lifecycle')
      .option('--rebuild-affected', 'force a full rebuild for every changed root')
      .option('--files <glob>', 'treat matching project files as changed')
      .option('--serial', 'build roots serially (concurrency 1)')
      .option('--budget-mb <n>', 'per-root memory budget hint'),
    ['nex update', 'nex update --files src/api.ts --format json'],
  );
  update.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      let budgetMB: number | undefined;
      if (opts.budgetMb !== undefined) {
        const parsed = Number.parseInt(String(opts.budgetMb), 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw nexusError('E00', '--budget-mb must be a positive integer', {
            reason: `received ${JSON.stringify(opts.budgetMb)}`,
            suggestion: 'Pass --budget-mb <positive integer>.',
          });
        }
        budgetMB = parsed;
      }
      const loadedConfig = await loadConfig({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      const result = await buildWorkspace({
        projectRoot: context.projectRoot,
        loadedConfig,
        onProgress: progressReporter(context),
        serial: opts.serial === true,
        mode: 'update',
        selectedRootIds: selectedRootIds(opts),
        forceFull: opts.rebuildAffected === true,
        forcedGlobs: typeof opts.files === 'string' ? [opts.files] : undefined,
        budgetMB,
      });
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
      const invalid = result.recovery?.invalid ?? [];
      const notes: string[] = [];
      if (result.failedRoots.length > 0)
        notes.push(`failed roots: ${result.failedRoots.join(', ')}`);
      if (invalid.length > 0) notes.push(`invalid roots: ${invalid.join(', ')} (run nex doctor)`);
      if (result.roots.every((root) => root.mode === 'fresh'))
        notes.push('all roots fresh; no files written');
      for (const root of result.roots) {
        if (root.changed !== undefined && root.changed.reasons.length > 0) {
          notes.push(`${root.rootId}: ${root.changed.reasons.join(', ')}`);
        }
      }
      return {
        data: {
          command: 'update',
          roots: result.roots,
          failedRoots: result.failedRoots,
          totalMs: result.totalMs,
          resources: result.resources ?? null,
          recovery: result.recovery ?? null,
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
          staleness: result.failedRoots.length > 0 || invalid.length > 0 ? 'stale' : 'fresh',
          buildFingerprint: result.roots.find((root) => root.ok)?.buildFingerprint ?? null,
          degraded: [...degraded].sort(),
          notes,
        },
        exitCode: result.failedRoots.length > 0 || invalid.length > 0 ? 1 : 0,
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
        throw nexusError('E24', 'status output schema is not provided', {
          reason: 'the versioned status JSON Schema is not part of the Phase 07 deliverable',
          suggestion:
            'Use `nex status --format json` for the current shape, or `nex doctor --schema` for the configuration schema.',
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
          onboarding: report.onboarding,
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
      .option('--mcp', 'probe the real MCP server handshake and tools/list')
      .option('--dump-vue-map <file>', 'print the Vue projection and offset mapping')
      .option('--repair', 'repair .nexus/ derived data (requires --yes in non-TTY)'),
    ['nex doctor', 'nex doctor --schema', 'nex doctor --repair --yes', 'nex doctor --mcp'],
  );
  doctor.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const modeCount = [
        opts.schema === true,
        opts.mcp === true,
        opts.repair === true,
        typeof opts.dumpVueMap === 'string',
      ].filter(Boolean).length;
      if (modeCount > 1) {
        throw nexusError('E00', 'doctor modes are mutually exclusive', {
          reason: '--schema, --mcp, --repair and --dump-vue-map cannot be combined',
          suggestion: 'Run one doctor mode at a time.',
        });
      }
      if (opts.mcp === true) {
        const entry = process.argv[1] ?? '';
        const probe = await withProbeDirectory((cwd) =>
          probeMcpServer({ entry, cwd, timeoutMs: 20_000 }),
        );
        const check = {
          id: 'mcp',
          title: 'MCP server handshake',
          status: probe.ok ? ('pass' as const) : ('fail' as const),
          detail: `protocol=${probe.protocolVersion ?? 'unknown'} tools=${probe.tools.length} durationMs=${probe.durationMs}`,
          suggestion: probe.ok
            ? null
            : 'Run `nex mcp` manually and inspect stderr; the probe uses an isolated temporary project.',
          evidence: {
            protocolVersion: probe.protocolVersion,
            tools: probe.tools,
            durationMs: probe.durationMs,
            stderr: probe.stderr.slice(0, 2000),
          },
        };
        const summary = {
          pass: probe.ok ? 1 : 0,
          warn: 0,
          fail: probe.ok ? 0 : 1,
        };
        return {
          data: {
            command: 'doctor',
            checks: [check],
            summary,
            roots: [],
            schema: null,
            counts: emptyCounts(1),
            coverage: emptyCoverage(),
            truncated: false,
            nextCursor: null,
            staleness: probe.ok ? 'fresh' : 'stale',
            buildFingerprint: null,
            degraded: [],
            notes: ['MCP probe only performs initialize + tools/list; it never calls refresh'],
          },
          exitCode: probe.ok ? 0 : 1,
        };
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
        if (!context.yes) {
          if (!context.isTTY || context.nonInteractive) {
            throw nexusError('E00', 'doctor --repair requires --yes in non-interactive mode', {
              reason: 'repair is destructive and no confirmation was possible',
              suggestion: 'Re-run with `nex doctor --repair --yes`.',
            });
          }
          const confirmed = await confirmRepair();
          if (!confirmed) {
            return {
              data: {
                command: 'doctor',
                checks: [],
                summary: { pass: 0, warn: 0, fail: 0 },
                roots: [],
                schema: null,
                repair: { skipped: true, actions: [] },
                counts: emptyCounts(0),
                coverage: emptyCoverage(),
                truncated: false,
                nextCursor: null,
                staleness: 'fresh',
                buildFingerprint: null,
                degraded: [],
                notes: ['repair was not confirmed; nothing was written'],
              },
              exitCode: 0,
            };
          }
        }
        const repair = await runDoctorRepair({
          projectRoot: context.projectRoot,
          trustConfig: context.trustConfig,
        });
        return {
          data: {
            command: 'doctor',
            checks: repair.doctor.checks,
            summary: repair.doctor.summary,
            roots: repair.doctor.roots,
            schema: null,
            repair: {
              actions: repair.actions,
              recovery: repair.recovery,
              workspace: repair.workspace,
              removedOrphans: repair.removedOrphans,
            },
            counts: emptyCounts(repair.doctor.checks.length),
            coverage: emptyCoverage(),
            truncated: false,
            nextCursor: null,
            staleness: repair.exitCode === 0 ? 'fresh' : 'stale',
            buildFingerprint: null,
            degraded: [],
            notes: [
              'repair only touches .nexus/ derived data; source and configuration are unchanged',
            ],
          },
          exitCode: repair.exitCode,
        };
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
        counts:
          result.envelope.counts.total <= 1
            ? { ...result.envelope.counts, total: 1, returned: 1, certain: 1 }
            : result.envelope.counts,
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

  const deps = addExamples(
    program
      .command('deps [target]')
      .description('dependency, module, style or static call relations')
      .helpGroup('Query')
      .option('--reverse', 'show incoming edges')
      .option('--type <type>', 'file|module|style|call', 'file'),
    [
      'nex deps src/core/useOverlay.ts',
      'nex deps src/styles/theme.scss --type style --reverse',
      'nex deps --type module core',
      'nex deps --type call useOverlay --reverse --explain',
    ],
  );
  deps.action(async (target: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const type = typeof opts.type === 'string' ? opts.type : 'file';
      if (!['file', 'module', 'style', 'call'].includes(type)) {
        throw nexusError('E00', 'invalid --type value', {
          reason: `expected file, module, style or call, received ${JSON.stringify(type)}`,
          suggestion: 'Use --type file|module|style|call.',
        });
      }
      const result = await queryDependencies(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
        },
        target ?? '',
        type as DependencyQueryType,
        opts.reverse === true,
      );
      return {
        data: {
          command: 'deps',
          type: result.type,
          target: result.target,
          reverse: result.reverse,
          ...envelopeFields(result.envelope),
          architecture: {
            modules: result.data.modules,
            violations: result.data.violations,
          },
          blindSpots: result.data.blindSpots,
          crossRootEdges: result.data.crossRootEdges,
        },
        exitCode: 0,
      };
    });
  });

  const impact = addExamples(
    program
      .command('impact [target]')
      .description('change impact, risk and affected surface for a file or symbol')
      .helpGroup('Query')
      .option('--symbol <name>', 'analyze a symbol instead of a file path')
      .option('--depth <n>', 'indirect expansion depth (default 3, max 10)')
      .option('--no-template', 'exclude Vue template edges from consumers'),
    [
      'nex impact src/core/useOverlay.ts',
      'nex impact --symbol useOverlay --depth 2 --explain',
      'nex impact src/styles/theme.scss --format json',
    ],
  );
  impact.action(async (target: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const result = await analyzeImpact({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        rootId: context.root,
        roots: context.roots,
        trustConfig: context.trustConfig,
        target: target ?? '',
        symbol: typeof opts.symbol === 'string' ? opts.symbol : null,
        depth: typeof opts.depth === 'string' ? Number.parseInt(opts.depth, 10) : undefined,
        includeTemplate: opts.template !== false,
      });
      const data = impactData(result);
      const counts = data.counts as { heuristic: number; dynamicUnresolved: number };
      const exitCode =
        counts.heuristic > 0 ||
        counts.dynamicUnresolved > 0 ||
        data.completeness !== 'complete' ||
        data.staleness !== 'fresh'
          ? 2
          : 0;
      return { data, exitCode };
    });
  });

  const reportFormatOf = (opts: Record<string, unknown>): OutputFormat | undefined => {
    const value = opts.report;
    if (value === undefined) return undefined;
    if (value === 'json') return 'json';
    if (value === 'md' || value === 'markdown') return 'markdown';
    throw nexusError('E00', 'invalid --report value', {
      reason: `expected md or json, received ${JSON.stringify(value)}`,
      suggestion: 'Use --report md|json.',
    });
  };

  const preflight = addExamples(
    program
      .command('preflight [target]')
      .description('pre-change audit: existing APIs, similar code, dependencies, impact, tests')
      .helpGroup('Audit')
      .option('--task <text>', 'task description used for API and similarity search')
      .option('--symbol <name>', 'analyze a symbol instead of a file path')
      .option('--base <ref>', 'baseline ref for the Surface diff')
      .option('--fail-on <level>', 'accepted for symmetry; preflight is read-only')
      .option('--report <fmt>', 'md|json report format')
      .option('--depth <n>', 'impact depth (default 3)'),
    [
      'nex preflight src/core/useOverlay.ts',
      'nex preflight --task "add a close button to the overlay"',
      'nex preflight --symbol useOverlay --report md',
    ],
  );
  preflight.action(async (target: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const result = await runPreflight({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        rootId: context.root,
        roots: context.roots,
        trustConfig: context.trustConfig,
        target: target ?? null,
        symbol: typeof opts.symbol === 'string' ? opts.symbol : null,
        task: typeof opts.task === 'string' ? opts.task : null,
        base: typeof opts.base === 'string' ? opts.base : null,
        depth: typeof opts.depth === 'string' ? Number.parseInt(opts.depth, 10) : undefined,
      });
      const { exitCode, ...data } = result;
      return {
        data: { ...data, command: 'preflight' },
        exitCode,
        format: reportFormatOf(opts),
      };
    });
  });

  const postflight = addExamples(
    program
      .command('postflight')
      .description('post-change audit: Git diff, changed symbols, Surface/deps/architecture/tests')
      .helpGroup('Audit')
      .option('--base <ref>', 'Git base ref (default HEAD)')
      .option('--fail-on <level>', 'breaking|additive|ambiguous|warning|none', 'breaking')
      .option('--report <fmt>', 'md|json report format')
      .option('--only <ids>', 'verify command ids (comma-separated)'),
    [
      'nex postflight',
      'nex postflight --base origin/main --fail-on breaking --format json',
      'nex postflight --base HEAD~1 --report markdown',
    ],
  );
  postflight.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const failOn = typeof opts.failOn === 'string' ? opts.failOn : 'breaking';
      if (!['breaking', 'additive', 'ambiguous', 'warning', 'none'].includes(failOn)) {
        throw nexusError('E00', 'invalid --fail-on value', {
          reason: `expected breaking|additive|ambiguous|warning|none, received ${JSON.stringify(failOn)}`,
          suggestion: 'Use --fail-on breaking|additive|ambiguous|warning|none.',
        });
      }
      const result = await runPostflight({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        rootId: context.root,
        roots: context.roots,
        trustConfig: context.trustConfig,
        base: typeof opts.base === 'string' ? opts.base : null,
        failOn: failOn as 'breaking' | 'additive' | 'ambiguous' | 'warning' | 'none',
        yes: opts.yes === true,
        only:
          typeof opts.only === 'string'
            ? opts.only
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry !== '')
            : null,
      });
      return {
        data: { ...result, command: 'postflight' },
        exitCode: result.exit.code,
        format: reportFormatOf(opts),
      };
    });
  });

  const verify = addExamples(
    program
      .command('verify')
      .description('run commands from the authorized commands.allow whitelist')
      .helpGroup('Audit')
      .option('--only <ids>', 'run only these command ids (comma-separated)')
      .option('--dry-run', 'list authorization state without executing')
      .option('--purpose <text>', 'purpose echoed with every command'),
    ['nex verify --dry-run', 'nex verify --yes', 'nex verify --only typecheck --yes'],
  );
  verify.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const loaded = await loadConfig({
        projectRoot: context.projectRoot,
        trustConfig: context.trustConfig,
      });
      if (loaded.config === null) {
        throw nexusError('E17', 'configuration is not available', {
          reason: 'no valid .nexus/nexus.config.json',
          suggestion: 'Run `nex init --write-config --yes` first.',
        });
      }
      const result = await runVerify({
        projectRoot: context.projectRoot,
        config: loaded.config,
        only:
          typeof opts.only === 'string'
            ? opts.only
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry !== '')
            : null,
        dryRun: opts.dryRun === true,
        yes: opts.yes === true,
        explicit: true,
        purpose: typeof opts.purpose === 'string' ? opts.purpose : 'verify',
        onEcho: (line) => {
          if (!context.quiet) writeStderr(line);
        },
      });
      const failed = result.commands.filter(
        (entry) => entry.status === 'failed' || entry.status === 'timedOut',
      ).length;
      const counts = {
        total: result.commands.length,
        returned: result.commands.length,
        certain: result.commands.filter((entry) => entry.status === 'passed').length,
        heuristic: 0,
        dynamicUnresolved: 0,
        partial: 0,
      };
      return {
        data: {
          command: 'verify',
          commands: result.commands,
          skipped: result.skipped,
          counts,
          failed,
          notes: [
            'commands are complete cmd+args entries from commands.allow; no shell is used',
            '.nexus/trust.json records authorization by command signature',
          ],
        },
        exitCode: failed > 0 ? 1 : 0,
      };
    });
  });

  const contextCommand = addExamples(
    program
      .command('context [target]')
      .description('layered task context: summary, relations and source excerpt')
      .helpGroup('Query')
      .option('--task <text>', 'task description used to extract a target')
      .option('--symbol <name>', 'analyze a symbol instead of a file path')
      .option('--depth <n>', 'relation depth (default 3)')
      .option('--context-lines <n>', 'include a source excerpt of the target (0-400)'),
    [
      'nex context src/core/useOverlay.ts --context-lines 20',
      'nex context --task "add a close button" --depth 2',
      'nex context --symbol useOverlay --format json',
    ],
  );
  contextCommand.action(async (target: string | undefined, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const positive = (value: unknown, name: string, max = 400): number | undefined => {
        if (value === undefined) return undefined;
        const parsed = Number.parseInt(String(value), 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
          throw nexusError('E00', `${name} must be an integer between 0 and ${max}`, {
            reason: `received ${JSON.stringify(value)}`,
            suggestion: `Use ${name} 0..${max}.`,
          });
        }
        return parsed;
      };
      const parsed = await runContext({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        rootId: context.root,
        roots: context.roots,
        trustConfig: context.trustConfig,
        task: typeof opts.task === 'string' ? opts.task : null,
        target: target ?? null,
        symbol: typeof opts.symbol === 'string' ? opts.symbol : null,
        depth: positive(opts.depth, '--depth', 10),
        contextLines: positive(opts.contextLines, '--context-lines', 400),
        cursor: context.cursor,
        noTruncate: context.noTruncate,
      });
      const degraded = Array.isArray(parsed.degraded) ? parsed.degraded : [];
      return {
        data: {
          ...parsed,
          command: 'context',
          degraded,
          notes: parsed.notes,
        },
        exitCode: parsed.staleness === 'fresh' ? 0 : 2,
      };
    });
  });

  const similar = addExamples(
    program
      .command('similar <query>')
      .description('deterministic similar-API search (heuristic, explainable rules)')
      .helpGroup('Governance')
      .option('--top <n>', 'maximum candidates (1-50, default 10)')
      .option('--scope <scope>', 'public|all (default all)'),
    [
      'nex similar useOverlay',
      'nex similar "load user profile" --top 5',
      'nex similar s_7f3k9m2q1x8b4c6d --scope public --explain',
    ],
  );
  similar.action(async (query: string, _options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      let top: number | undefined;
      if (opts.top !== undefined) {
        const parsed = Number.parseInt(String(opts.top), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
          throw nexusError('E00', '--top must be an integer between 1 and 50', {
            reason: `received ${JSON.stringify(opts.top)}`,
            suggestion: 'Use --top 1..50.',
          });
        }
        top = parsed;
      }
      const scope = typeof opts.scope === 'string' ? opts.scope : 'all';
      if (scope !== 'public' && scope !== 'all') {
        throw nexusError('E00', 'invalid --scope value', {
          reason: `expected public or all, received ${JSON.stringify(scope)}`,
          suggestion: 'Use --scope public|all.',
        });
      }
      const data = await runSimilar(
        {
          projectRoot: context.projectRoot,
          cwd: context.cwd,
          rootId: context.root,
          roots: context.roots,
          trustConfig: context.trustConfig,
          top,
          scope,
          explain: context.explain,
        },
        query,
      );
      return { data: { ...data, command: 'similar' }, exitCode: 0 };
    });
  });

  const auditDuplicates = addExamples(
    program
      .command('audit-duplicates')
      .description('report duplicate and near-duplicate implementations (heuristic only)')
      .helpGroup('Governance')
      .option('--threshold <n>', 'similarity threshold 0..1 (default 0.8)')
      .option('--scope <scope>', 'public|all (default all)'),
    [
      'nex audit-duplicates',
      'nex audit-duplicates --threshold 0.9 --scope public',
      'nex audit-duplicates --threshold 0.55 --format json',
    ],
  );
  auditDuplicates.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      let threshold: number | undefined;
      if (opts.threshold !== undefined) {
        const parsed =
          typeof opts.threshold === 'number'
            ? opts.threshold
            : Number.parseFloat(String(opts.threshold));
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw nexusError('E00', '--threshold must be a number between 0 and 1', {
            reason: `received ${JSON.stringify(opts.threshold)}`,
            suggestion: 'Use --threshold 0..1 (default 0.8).',
          });
        }
        threshold = parsed;
      }
      const scope = typeof opts.scope === 'string' ? opts.scope : 'all';
      if (scope !== 'public' && scope !== 'all') {
        throw nexusError('E00', 'invalid --scope value', {
          reason: `expected public or all, received ${JSON.stringify(scope)}`,
          suggestion: 'Use --scope public|all.',
        });
      }
      const data = await runAuditDuplicates({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        rootId: context.root,
        roots: context.roots,
        trustConfig: context.trustConfig,
        threshold,
        scope,
      });
      const lowThreshold = data.warnings.some((warning) => warning.message.includes('below 0.6'));
      return {
        data: { ...data, command: 'audit-duplicates' },
        exitCode: data.groups.length > 0 || lowThreshold ? 2 : 0,
      };
    });
  });

  const mcp = addExamples(
    program
      .command('mcp')
      .description('start the MCP server over stdio (8 tools; refresh is the only writer)')
      .helpGroup('Access')
      .option('--watch', 'watch files and refresh the index incrementally')
      .option('--read-only', 'never write the index; refresh is not registered')
      .option('--auto-bootstrap', 'build the index in the background when it is missing'),
    ['nex mcp', 'nex mcp --watch', 'nex mcp --read-only'],
  );
  mcp.action(async (_options, command: Command) => {
    await execute(command, async (context) => {
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      const watch = opts.watch === true;
      const readOnly = opts.readOnly === true;
      const autoBootstrap = opts.autoBootstrap === true;
      if (readOnly && watch) {
        throw nexusError('E00', '--read-only cannot be combined with --watch', {
          reason: 'watch refreshes the index and is a write path',
          suggestion: 'Use either --read-only or --watch.',
        });
      }
      if (readOnly && autoBootstrap) {
        throw nexusError('E00', '--read-only cannot be combined with --auto-bootstrap', {
          reason: 'auto-bootstrap writes an index',
          suggestion: 'Use either --read-only or --auto-bootstrap.',
        });
      }
      const self = selfInfo(context);
      const started = await startMcpServer({
        projectRoot: context.projectRoot,
        cwd: context.cwd,
        trustConfig: context.trustConfig,
        readOnly,
        watch,
        autoBootstrap,
        binaryPath: self.binaryPath,
        serverVersion: PACKAGE_VERSION,
        packageName: PACKAGE_NAME,
      });
      let closing = false;
      const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        try {
          await started.close();
        } finally {
          process.exit(0);
        }
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      return { data: {}, exitCode: 0, skipRender: true };
    });
  });

  const print = addExamples(
    program
      .command('print <asset>')
      .description(
        'print integration assets to stdout (mcp-config | agents | skill; never writes files)',
      )
      .helpGroup('Access')
      .option('--client <client>', 'mcp-config target: dsh | claude | cursor'),
    ['nex print mcp-config --client dsh', 'nex print agents', 'nex print skill'],
  );
  print.action(async (asset: string, _options, command: Command) => {
    await execute(command, async (context) => {
      if (!isPrintAsset(asset)) {
        throw nexusError('E00', 'unknown print asset', {
          reason: `expected mcp-config, agents or skill, received ${JSON.stringify(asset)}`,
          suggestion: 'Use `nex print mcp-config|agents|skill`.',
        });
      }
      const opts = command.optsWithGlobals() as Record<string, unknown>;
      return emitPrint(context, asset, opts.client);
    });
  });

  const stubs: Array<[string, string, string]> = [
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
        throw nexusError('E24', `${name} is not provided`, {
          reason: 'this capability belongs to a later phase',
          suggestion:
            'Phase 07 does not provide `nex test`; use `npm test` for the repository test suite, or `nex doctor` for diagnosis.',
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
      .option('--client <client>', 'mcp-config target: dsh | claude | cursor')
      .allowUnknownOption(true)
      .allowExcessArguments(true);
    alias.action(async (_args: string[], _options, command: Command) => {
      await execute(command, async (context) => {
        const opts = command.optsWithGlobals() as Record<string, unknown>;
        return emitPrint(context, asset, opts.client);
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

Phase 07 implements: init, build, update, status, doctor, symbol, references, search, deps, api-snapshot, api-diff, impact, preflight, postflight, verify, context, similar, audit-duplicates, print, mcp.
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
