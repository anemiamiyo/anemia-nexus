import path from 'node:path';

import type { NexusError } from 'anemia-core';

export type McpFormat = 'lines' | 'json';

export interface FormatDecision {
  format: McpFormat;
  fallback: boolean;
  reason: string | null;
}

/**
 * 14.1.5: only lines/json exist. The SDK validates input before the handler,
 * so `format` is declared as a plain string and coerced here. Unknown values
 * never throw and never become isError — they fall back to lines.
 */
export function resolveFormat(value: unknown): FormatDecision {
  if (value === undefined || value === null || value === '') {
    return {
      format: 'lines',
      fallback: true,
      reason: 'missing-format: server default is lines',
    };
  }
  if (value === 'lines' || value === 'json') {
    return { format: value, fallback: false, reason: null };
  }
  return {
    format: 'lines',
    fallback: true,
    reason: `unknown-format: ${String(value)}`,
  };
}

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return typeof value === 'object' && value !== null ? (value as Row) : null;
}

function text(value: unknown, fallback = '-'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

function itemsOf(data: Row, key = 'items'): Row[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => record(entry)).filter((entry): entry is Row => entry !== null);
}

function countsLine(data: Row): string {
  const counts = record(data.counts) ?? {};
  const parts = ['total', 'returned', 'certain', 'heuristic', 'dynamicUnresolved', 'partial']
    .filter((key) => typeof counts[key] === 'number')
    .map((key) => `${key}=${String(counts[key])}`);
  return parts.length === 0 ? '' : `counts ${parts.join(' ')}`;
}

function coverageLine(data: Row): string {
  const coverage = record(data.coverage);
  if (coverage === null) return '';
  const parts = [
    'filesCovered',
    'filesIgnored',
    'filesFailed',
    'resolved',
    'unresolved',
    'unmapped',
  ]
    .filter((key) => typeof coverage[key] === 'number')
    .map((key) => `${key}=${String(coverage[key])}`);
  return parts.length === 0 ? '' : `coverage ${parts.join(' ')}`;
}

function envelopeLines(data: Row): string[] {
  const lines: string[] = [];
  const counts = countsLine(data);
  if (counts !== '') lines.push(counts);
  const coverage = coverageLine(data);
  if (coverage !== '') lines.push(coverage);
  lines.push(
    `staleness=${text(data.staleness, 'unknown')} buildFingerprint=${text(
      typeof data.buildFingerprint === 'string' ? data.buildFingerprint.slice(0, 12) : null,
      '-',
    )} truncated=${text(data.truncated, 'false')} nextCursor=${text(data.nextCursor, 'null')}`,
  );
  const degraded = Array.isArray(data.degraded) ? data.degraded : [];
  lines.push(`degraded=${degraded.length === 0 ? '[]' : degraded.join(',')}`);
  const notes = Array.isArray(data.notes) ? data.notes : [];
  for (const note of notes) lines.push(`note ${String(note)}`);
  return lines;
}

function statusLines(data: Row): string[] {
  const lines: string[] = [];
  lines.push(`state ${text(data.state, 'uninitialized')} staleness ${text(data.staleness)}`);
  lines.push(
    `rootId ${text(data.rootId, '-')} activeRoot ${text(data.activeRoot, '-')} buildFingerprint ${text(data.buildFingerprint, '-')}`,
  );
  const capabilities = record(data.capabilities) ?? {};
  lines.push(
    `capabilities styleDependency=${text(capabilities.styleDependency)} mcpFormats=${text(capabilities.mcpFormats)} relationClasses=${text(capabilities.relationClasses)}`,
  );
  const self = record(data.self) ?? {};
  lines.push(
    `self package=${text(self.packageName)} version=${text(self.serverVersion)} node=${text(self.nodeVersion)} projectRoot=${text(self.projectRoot)} binary=${text(self.binaryPath)}`,
  );
  for (const root of itemsOf(data, 'roots')) {
    lines.push(
      `root ${text(root.rootId)} ${text(root.rootPath)} ${text(root.state)}/${text(root.staleness)} files=${text(root.files)} symbols=${text(root.symbols)} refs=${text(root.references)} build=${text(root.buildFingerprintPrefix)}`,
    );
  }
  const integrity = record(data.lastIntegrityCheck);
  if (integrity !== null) {
    lines.push(`lastIntegrityCheck result=${text(integrity.result)} at=${text(integrity.at)}`);
  }
  const bootstrap = record(data.bootstrap);
  if (bootstrap !== null) {
    lines.push(
      `bootstrap state=${text(bootstrap.state)} message=${text(bootstrap.message)} percent=${text(bootstrap.percent, 'null')}`,
    );
  }
  const guidance = Array.isArray(data.guidance) ? data.guidance : [];
  for (const step of guidance) lines.push(`next ${String(step)}`);
  return lines;
}

function symbolLines(data: Row): string[] {
  const lines: string[] = [];
  const symbols = itemsOf(data, 'items');
  const single = record(data.symbol);
  const all = single !== null && symbols.length === 0 ? [single] : symbols;
  for (const item of all) {
    lines.push(
      `${text(item.path)}:${text(item.startLine)}:${text(item.startCol)}  ${text(item.kind)}  ${text(item.symbolId)}  ${text(item.nameChain)}  ${text(item.identityConfidence)}  ${text(item.surface)}`,
    );
  }
  return lines;
}

function referenceLines(data: Row): string[] {
  return itemsOf(data).map((item) => {
    const relationClass = text(item.relationClass, 'certain');
    const prefix =
      relationClass === 'dynamic-unresolved' ? '!' : relationClass === 'heuristic' ? '?' : ' ';
    return `${prefix}${text(item.path)}:${text(item.line)}:${text(item.col)}  ${text(item.kind)}  ${text(item.symbolId)}  ${text(item.reason)}  ${relationClass}  ${text(item.confidence)}`;
  });
}

function depsLines(data: Row): string[] {
  const lines: string[] = [];
  for (const item of itemsOf(data)) {
    const kind = text(item.kind, 'dependency');
    if (kind === 'call') {
      lines.push(
        `call ${text(item.sourceFile)}:${text(item.line)}:${text(item.col)} ${text(item.callerName)} -> ${text(item.calleeName, text(item.calleeSymbolId, '<unresolved>'))} ${text(item.relationClass)} ${text(item.confidence)}`,
      );
      continue;
    }
    lines.push(
      `${kind} ${text(item.sourceFile)}:${text(item.line)}:${text(item.col)} -> ${text(item.targetFile, text(item.specifier))} ${text(item.depType)} ${text(item.relationClass)} ${text(item.confidence)}`,
    );
  }
  const architecture = record(data.architecture);
  if (architecture !== null) {
    lines.push(
      `architecture modules=${Array.isArray(architecture.modules) ? architecture.modules.length : 0} violations=${Array.isArray(architecture.violations) ? architecture.violations.length : 0}`,
    );
  }
  const blindSpots = Array.isArray(data.blindSpots) ? data.blindSpots : [];
  for (const entry of blindSpots) {
    const spot = record(entry);
    if (spot === null) continue;
    lines.push(
      `blindSpot ${text(spot.category)}/${text(spot.missReason)} files=${text(spot.affectedFiles)} hint=${text(spot.manualCheckHint)}`,
    );
  }
  return lines;
}

function impactLines(data: Row): string[] {
  const lines: string[] = [];
  const risk = record(data.risk) ?? {};
  const target = record(data.target) ?? {};
  lines.push(
    `risk ${text(risk.level, 'Low')} target ${text(target.kind, 'file')} ${text(target.filePath, text(target.name, '-'))} fanout=${text(data.impactFanout)}`,
  );
  const direct = record(data.direct) ?? {};
  const indirect = record(data.indirect) ?? {};
  lines.push(
    `direct=${text(direct.count)} indirect=${text(indirect.count)} depth=${text(indirect.depth)}`,
  );
  for (const item of itemsOf(direct, 'items')) {
    lines.push(
      `direct ${text(item.path)}:${text(item.line)}:${text(item.col)} ${text(item.name, text(item.symbolId))} ${text(item.reason)} ${text(item.relationClass)}`,
    );
  }
  for (const item of itemsOf(indirect, 'items')) {
    lines.push(
      `indirect ${text(item.path)}:${text(item.line)}:${text(item.col)} ${text(item.name, text(item.symbolId))} ${text(item.reason)} ${text(item.relationClass)}`,
    );
  }
  const tests = record(data.tests) ?? {};
  const related = Array.isArray(tests.related) ? tests.related : [];
  for (const entry of related) {
    const item = record(entry);
    if (item === null) continue;
    lines.push(`test ${text(item.testFile)}:${text(item.line)}`);
  }
  const blindSpots = Array.isArray(data.blindSpots) ? data.blindSpots : [];
  for (const entry of blindSpots) {
    const spot = record(entry);
    if (spot === null) continue;
    lines.push(
      `blindSpot ${text(spot.category)}/${text(spot.missReason)} files=${text(spot.affectedFiles)}`,
    );
  }
  return lines;
}

function contextLines(data: Row): string[] {
  const lines: string[] = [];
  const layers = record(data.layers) ?? {};
  for (const layer of ['summary', 'relations', 'source'] as const) {
    const items = Array.isArray(layers[layer]) ? (layers[layer] as unknown[]) : [];
    if (items.length === 0) continue;
    lines.push(`layer ${layer} items=${items.length}`);
    for (const entry of items) {
      const item = record(entry);
      if (item === null) continue;
      lines.push(
        `  ${text(item.kind)} ${text(item.path)}:${text(item.line)} ${text(item.symbolId)} ${text(item.name)} ${text(item.reason)} ${text(item.relationClass)}`,
      );
      if (typeof item.excerpt === 'string') {
        for (const excerptLine of item.excerpt.split('\n')) lines.push(`    | ${excerptLine}`);
      }
    }
  }
  return lines;
}

function similarLines(data: Row): string[] {
  const lines: string[] = [];
  const target = record(data.target);
  if (target !== null) {
    lines.push(
      `target ${text(target.path)}:${text(target.line)}:${text(target.col)} ${text(target.symbolId)} ${text(target.nameChain)}`,
    );
  }
  lines.push(
    `rules=${text(data.rulesVersion)} noSimilarFound=${text(data.noSimilarFound)} scope=${text(data.scope)}`,
  );
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  for (const entry of candidates) {
    const candidate = record(entry);
    if (candidate === null) continue;
    const symbol = record(candidate.candidate) ?? {};
    const location = record(candidate.location) ?? {};
    lines.push(
      `${text(location.path)}:${text(location.line)}:${text(location.col)} ${text(symbol.symbolId)} ${text(symbol.name)} score=${text(candidate.score)} ${text(candidate.suggestion)}`,
    );
  }
  return lines;
}

function refreshLines(data: Row): string[] {
  return [
    `refresh changed=${text(data.changed)} filesUpdated=${text(data.filesUpdated)} noop=${text(data.noop, 'false')} indexMutation=${text(data.indexMutation, 'true')} buildFingerprint=${text(data.buildFingerprint)} staleness=${text(data.staleness)} degraded=${text(data.degraded)}`,
  ];
}

/** Compact text track for the MCP `content` field. No ANSI, no absolute paths. */
export function renderCompact(tool: string, data: Row): string {
  const lines: string[] = [];
  switch (tool) {
    case 'status':
      lines.push(...statusLines(data));
      break;
    case 'symbol':
      lines.push(...symbolLines(data));
      break;
    case 'references':
      lines.push(...referenceLines(data));
      break;
    case 'search':
      lines.push(...symbolLines(data));
      break;
    case 'deps':
      lines.push(...depsLines(data));
      break;
    case 'impact':
      lines.push(...impactLines(data));
      break;
    case 'context':
      lines.push(...contextLines(data));
      break;
    case 'similar':
      lines.push(...similarLines(data));
      break;
    case 'refresh':
      lines.push(...refreshLines(data));
      break;
    default:
      lines.push(JSON.stringify(data));
      break;
  }
  lines.push(...envelopeLines(data));
  return lines.join('\n');
}

function relativeFile(projectRoot: string, file: string | null): string | null {
  if (file === null || file === '') return null;
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(file);
  return relative.replaceAll('\\', '/');
}

/**
 * 16.4: four-line human layer, machine layer on the JSON track. Errors are
 * returned as `isError: true` content, never thrown into the protocol.
 */
export function renderErrorText(error: NexusError, format: McpFormat, projectRoot: string): string {
  const file = relativeFile(projectRoot, error.file);
  if (format === 'json') {
    return JSON.stringify({
      code: error.code,
      category: error.category,
      severity: error.severity,
      message: error.message,
      reason: error.reason,
      file,
      suggestion: error.suggestion,
      evidence: error.evidence,
      coverage: null,
    });
  }
  const suggestion =
    error.suggestion === '' ? 'Run `nex doctor` for diagnostics.' : error.suggestion;
  const command = suggestion.includes('nex ')
    ? suggestion
    : `Run \`nex doctor\` and retry. ${suggestion}`;
  const prerequisites = `Node ${process.versions.node} (requires >=22.16.0); configuration: .nexus/nexus.config.json; git and tsconfig are checked by \`nex init\`.`;
  const pitfalls =
    'If a command name collides with another package, use the fallback command `anex`; an unapproved TypeScript config is never executed.';
  const conclusion = `${error.message} — ${error.reason} (${error.code})`;
  return [conclusion, command, prerequisites, pitfalls].join('\n');
}
