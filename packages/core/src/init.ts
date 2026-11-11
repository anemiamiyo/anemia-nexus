import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { NexusConfig } from './config/schema.js';
import { DEFAULT_CONFIG, configSchema } from './config/schema.js';
import { resolveRootConfig } from './config/merge.js';
import { nexusError } from './errors.js';
import { computeRootSetHash } from './index/fingerprint.js';
import { discoverRoots, type RootCandidate } from './discovery/roots.js';
import { checkTypecheck } from './discovery/typecheck.js';

export interface InitCandidateView {
  rootId: string;
  rootPath: string;
  packageName: string | null;
  tsconfig: string | null;
  indexable: boolean;
  selected: boolean;
  reasons: string[];
  typecheck: 'not-run' | 'pass' | 'fail';
}

export interface InitPlan {
  candidates: InitCandidateView[];
  selected: string[];
  config: NexusConfig | null;
  configText: string;
  exampleText: string;
  workspaceText: string;
  wouldWrite: boolean;
  existingConfig: boolean;
  messages: string[];
}

export interface InitResult extends InitPlan {
  written: boolean;
}

export interface InitOptions {
  projectRoot: string;
  roots?: string | null;
  writeConfig?: boolean;
  yes?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  /** Skip tsc verification (tests may use it; product default is to verify). */
  skipTypecheck?: boolean;
}

function isInteractive(options: InitOptions): boolean {
  return (
    options.nonInteractive !== true && process.stdin.isTTY === true && process.stdout.isTTY === true
  );
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function writeAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(temporary, filePath);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // best effort
      }
      throw error;
    }
  }
}

function parseSelection(value: string | null | undefined): 'all' | string[] | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (trimmed === 'all') return 'all';
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function candidateViews(
  candidates: readonly RootCandidate[],
  selected: ReadonlySet<string>,
): InitCandidateView[] {
  return candidates.map((candidate) => ({
    rootId: candidate.rootId,
    rootPath: candidate.rootPath,
    packageName: candidate.packageName,
    tsconfig: candidate.tsconfigRelativePath,
    indexable: candidate.indexable,
    selected: selected.has(candidate.rootId),
    reasons: candidate.reasons,
    typecheck: 'not-run',
  }));
}

function generatedConfig(selected: readonly RootCandidate[]): NexusConfig {
  const config = {
    configVersion: 1,
    defaults: DEFAULT_CONFIG.defaults,
    workspaces: {
      mode: 'prompt' as const,
      roots: [...selected.map((root) => root.rootId)],
      exclude: [],
      followTsReferences: false,
    },
    roots: {},
    style: DEFAULT_CONFIG.style,
    vue: DEFAULT_CONFIG.vue,
    commands: DEFAULT_CONFIG.commands,
  };
  return configSchema.parse(config);
}

function workspaceText(
  projectRoot: string,
  selected: readonly RootCandidate[],
  config: NexusConfig,
): string {
  const entries = selected.map((root) => {
    const effective = resolveRootConfig(config, root.rootId, config.roots[root.rootId]);
    return {
      rootId: root.rootId,
      rootPath: root.rootPath,
      packageName: root.packageName,
      tsconfig: root.tsconfigRelativePath,
      configHash: effective.configHash,
    };
  });
  const rootSetHash = computeRootSetHash(entries);
  return `${JSON.stringify({ version: 1, rootSetHash, roots: entries }, null, 2)}\n`;
}

/**
 * `init` discovers roots, prints candidates, and writes only with explicit
 * confirmation (docs/11-cli.md 11.6, docs/05-data-model.md 5.8.2). It never
 * writes AGENTS.md, MCP config or .gitignore.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const discovery = discoverRoots({ projectRoot, allowAmbiguous: true });
  const requested = parseSelection(options.roots);
  const interactive = isInteractive(options);
  const messages: string[] = [];

  let selectedCandidates: RootCandidate[];
  if (requested === 'all') {
    selectedCandidates = discovery.candidates.filter((candidate) => candidate.indexable);
    if (selectedCandidates.length === 0) {
      throw nexusError('E15', 'no indexable root found', {
        reason: 'none of the discovered candidates has a valid tsconfig.json',
        suggestion: 'Add tsconfig.json or select roots explicitly.',
        evidence: { candidates: discovery.candidates.map((candidate) => candidate.rootPath) },
      });
    }
  } else if (Array.isArray(requested)) {
    const byId = new Map(discovery.candidates.map((candidate) => [candidate.rootId, candidate]));
    selectedCandidates = [];
    for (const rootId of requested) {
      const candidate = byId.get(rootId);
      if (candidate === undefined) {
        throw nexusError('E15', 'unknown root id', {
          reason: `root not found: ${rootId}`,
          suggestion: 'Choose ids from the candidate table.',
          evidence: { candidates: discovery.candidates.map((candidate) => candidate.rootId) },
        });
      }
      if (!candidate.indexable) {
        throw nexusError('E15', 'selected root is not indexable', {
          reason: `${rootId}: ${candidate.reasons.join('; ')}`,
          suggestion: 'Fix tsconfig.json or choose another root.',
          evidence: { rootId, reasons: candidate.reasons },
        });
      }
      selectedCandidates.push(candidate);
    }
  } else if (interactive) {
    const rows = discovery.candidates
      .map((candidate) => {
        const indexable = candidate.indexable ? 'yes' : 'no';
        return `${candidate.rootId}\t${candidate.rootPath}\t${candidate.packageName ?? '-'}\t${candidate.tsconfigRelativePath ?? '-'}\t${indexable}`;
      })
      .join('\n');
    process.stderr.write(`Candidates (rootId, path, package, tsconfig, indexable):\n${rows}\n`);
    const answer = await ask('Select roots: [a]ll, comma-separated ids, or empty to skip: ');
    if (answer === '' || answer === 's' || answer === 'skip') {
      messages.push('No roots selected; nothing written.');
      return {
        candidates: candidateViews(discovery.candidates, new Set()),
        selected: [],
        config: null,
        configText: '',
        exampleText: '',
        workspaceText: '',
        wouldWrite: false,
        existingConfig: fs.existsSync(path.join(projectRoot, '.nexus', 'nexus.config.json')),
        messages,
        written: false,
      };
    }
    const chosen = answer === 'a' || answer === 'all' ? 'all' : answer;
    const selectedIds =
      chosen === 'all'
        ? discovery.candidates
            .filter((candidate) => candidate.indexable)
            .map((candidate) => candidate.rootId)
        : chosen.split(',');
    const byId = new Map(discovery.candidates.map((candidate) => [candidate.rootId, candidate]));
    selectedCandidates = [];
    for (const id of selectedIds) {
      const candidate = byId.get(id.trim());
      if (candidate === undefined || !candidate.indexable) {
        throw nexusError('E15', 'invalid root selection', {
          reason: `unknown or non-indexable root: ${id.trim()}`,
          suggestion: 'Choose ids from the candidate table.',
          evidence: { candidates: discovery.candidates.map((candidate) => candidate.rootId) },
        });
      }
      selectedCandidates.push(candidate);
    }
  } else {
    throw nexusError('E15', 'non-interactive init requires --roots', {
      reason: 'no --roots selection was provided',
      suggestion:
        'Pass --roots all or --roots <id,id>; candidates are listed in the error evidence.',
      evidence: {
        candidates: discovery.candidates.map((candidate) => ({
          rootId: candidate.rootId,
          rootPath: candidate.rootPath,
          indexable: candidate.indexable,
          reasons: candidate.reasons,
        })),
      },
    });
  }

  const views = candidateViews(
    discovery.candidates,
    new Set(selectedCandidates.map((candidate) => candidate.rootId)),
  );
  if (options.skipTypecheck !== true) {
    for (const candidate of selectedCandidates) {
      const view = views.find((entry) => entry.rootId === candidate.rootId);
      const result = await checkTypecheck(
        candidate.absolutePath,
        candidate.tsconfig?.tsconfigPath ?? path.join(candidate.absolutePath, 'tsconfig.json'),
      );
      if (view !== undefined) view.typecheck = result.ok ? 'pass' : 'fail';
      if (!result.ok) {
        throw nexusError('E15', 'selected root does not typecheck independently', {
          reason: `${candidate.rootId}: ${result.outputSummary || 'tsc failed'}`,
          suggestion: 'Fix the project errors; a root must typecheck independently to be indexed.',
          file: candidate.tsconfigRelativePath,
          evidence: { rootId: candidate.rootId, timedOut: result.timedOut },
        });
      }
    }
  }

  const config = generatedConfig(selectedCandidates);
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const exampleText = configText;
  const workspace = workspaceText(projectRoot, selectedCandidates, config);
  const configPath = path.join(projectRoot, '.nexus', 'nexus.config.json');
  const tsConfigPath = path.join(projectRoot, '.nexus', 'nexus.config.ts');
  const existingTsConfig = fs.existsSync(tsConfigPath);
  const existingConfig = fs.existsSync(configPath) || existingTsConfig;
  const wouldWrite = options.writeConfig === true;

  const plan: InitPlan = {
    candidates: views,
    selected: selectedCandidates.map((candidate) => candidate.rootId),
    config,
    configText,
    exampleText,
    workspaceText: workspace,
    wouldWrite,
    existingConfig,
    messages,
  };

  if (!wouldWrite) {
    messages.push(
      'Dry run: pass --write-config (and --yes in non-interactive mode) to write .nexus/.',
    );
    return { ...plan, written: false };
  }

  if (existingTsConfig) {
    throw nexusError('E17', 'a TypeScript configuration is present', {
      reason: '.nexus/nexus.config.ts exists; init must not create a second source',
      suggestion: 'Remove or rename nexus.config.ts before running init.',
    });
  }
  if (existingConfig && options.force !== true) {
    throw nexusError('E17', 'configuration already exists', {
      reason: 'refusing to overwrite an existing .nexus configuration',
      suggestion: 'Pass --force (and --yes) to overwrite.',
      evidence: { existing: true },
    });
  }
  if (existingConfig && options.force === true && !interactive && options.yes !== true) {
    throw nexusError('E00', 'forcing an overwrite requires --yes in non-interactive mode', {
      reason: '--force without --yes',
      suggestion: 'nex init --write-config --force --yes',
    });
  }
  if (!interactive && options.yes !== true) {
    throw nexusError('E00', 'writing configuration requires --yes in non-interactive mode', {
      reason: '--write-config without --yes',
      suggestion: 'nex init --write-config --yes',
    });
  }
  if (interactive && options.yes !== true) {
    const answer = await ask(
      `Write .nexus/ configuration for ${selectedCandidates.length} root(s)? [y/N] `,
    );
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      messages.push('Aborted; nothing written.');
      return { ...plan, written: false };
    }
  }

  const nexusDir = path.join(projectRoot, '.nexus');
  writeAtomic(path.join(nexusDir, 'nexus.config.json'), configText);
  writeAtomic(path.join(nexusDir, 'nexus.config.example.json'), exampleText);
  writeAtomic(path.join(nexusDir, 'workspace.json'), workspace);
  for (const root of selectedCandidates) {
    fs.mkdirSync(path.join(nexusDir, 'roots', root.rootId), { recursive: true });
  }
  messages.push('Wrote .nexus/nexus.config.json');
  messages.push('Wrote .nexus/workspace.json');
  messages.push(`Add \`.nexus/\` to .gitignore (this tool does not edit .gitignore).`);
  return { ...plan, written: true };
}
