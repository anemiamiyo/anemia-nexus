import { styleText } from 'node:util';

import type { NexusError } from 'anemia-core';
import type { OutputFormat } from './context.js';

export interface RenderInput {
  command: string;
  data: Record<string, unknown>;
}

export interface RenderOptions {
  color: boolean;
  width: number;
  explain: boolean;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return typeof value === 'object' && value !== null ? (value as Row) : null;
}

function rowsOf(data: Row, key = 'items'): Row[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asRecord(entry)).filter((entry): entry is Row => entry !== null);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function field(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function summaryFields(data: Row): string[] {
  const parts: string[] = [];
  const counts = asRecord(data.counts);
  if (counts) {
    for (const key of [
      'total',
      'returned',
      'certain',
      'heuristic',
      'dynamicUnresolved',
      'partial',
      'breaking',
      'additive',
      'internal',
      'ambiguous',
      'roots',
      'entries',
      'deprecated',
    ]) {
      const value = num(counts[key]);
      if (value !== null) parts.push(`counts.${key}=${value}`);
    }
  }
  const coverage = asRecord(data.coverage);
  if (coverage) {
    for (const key of [
      'filesCovered',
      'filesSkipped',
      'filesIgnored',
      'filesFailed',
      'resolved',
      'unresolved',
      'unmapped',
      'filteredInternal',
    ]) {
      const value = num(coverage[key]);
      if (value !== null) parts.push(`coverage.${key}=${value}`);
    }
  }
  for (const key of ['truncated', 'nextCursor', 'staleness', 'buildFingerprint']) {
    if (key in data) parts.push(`${key}=${field(data[key])}`);
  }
  const degraded = data.degraded;
  if (Array.isArray(degraded))
    parts.push(`degraded=${degraded.length === 0 ? '[]' : degraded.join(',')}`);
  return parts;
}

function footer(data: Row): string {
  const fields = summaryFields(data);
  return fields.length === 0 ? '' : `summary ${fields.join(' ')}`;
}

function referenceLines(data: Row): string[] {
  return rowsOf(data).map((item) => {
    const relationClass = str(item.relationClass, 'certain');
    const prefix =
      relationClass === 'dynamic-unresolved' ? '!' : relationClass === 'heuristic' ? '?' : ' ';
    return `${prefix} ${str(item.path)}:${field(item.line)}:${field(item.col)}  ${str(item.kind)}  ${str(item.symbolId)}  ${str(item.reason)}  ${relationClass}  ${str(item.confidence)}`;
  });
}

function symbolLines(data: Row): string[] {
  const lines: string[] = [];
  for (const item of rowsOf(data)) {
    lines.push(
      `${str(item.path)}:${field(item.startLine)}:${field(item.startCol)}  ${str(item.kind)}  ${str(item.symbolId)}  ${str(item.nameChain)}  ${str(item.identityConfidence)}  ${str(item.surface, 'unknown')}`,
    );
    const api = asRecord(item.api);
    if (api !== null) {
      lines.push(
        `  surface ${str(api.primaryEvidenceSource)} evidence=${Array.isArray(api.evidenceSources) ? api.evidenceSources.join(',') : ''} exportKind=${str(api.exportKind)} entry=${str(api.entryPath, '-')} condition=${str(api.condition, '-')} stability=${str(api.stability)}`,
      );
    }
    const component = asRecord(item.component);
    if (component !== null) {
      const coverage = asRecord(component.propsCoverage);
      const props = Array.isArray(component.props) ? component.props.length : 0;
      const emits = Array.isArray(component.emits) ? component.emits.length : 0;
      const slots = Array.isArray(component.slots) ? component.slots.length : 0;
      lines.push(
        `  component props=${props} emits=${emits} slots=${slots} propsCoverage=${field(coverage?.resolved ?? 0)}/${field(coverage?.total ?? 0)} source=${str(component.source, 'none')}`,
      );
    }
  }
  return lines;
}

function statusLines(data: Row): string[] {
  const lines: string[] = [];
  lines.push(`state ${str(data.state, 'uninitialized')}`);
  lines.push(`staleness ${str(data.staleness, 'uninitialized')}`);
  lines.push(`activeRoot ${str(data.activeRoot, '-')}`);
  for (const root of rowsOf(data, 'roots')) {
    lines.push(
      `root ${str(root.rootId)}  ${str(root.rootPath)}  ${str(root.state)}/${str(root.staleness)}  files=${field(root.files)} symbols=${field(root.symbols)} refs=${field(root.references)}  build=${str(root.buildFingerprintPrefix, '-')}  surface=${field(root.surfaceEntries)}`,
    );
    if (Array.isArray(root.staleReason) && root.staleReason.length > 0) {
      lines.push(`  staleReason ${root.staleReason.map((entry) => String(entry)).join(', ')}`);
    }
    const vue = asRecord(root.vue);
    if (vue !== null) {
      lines.push(
        `  vue files=${field(vue.files)} projected=${field(vue.projected)} components=${field(vue.components)} mapped=${field(vue.mappedSymbols)} unmapped=${field(vue.unmappedSymbols)} filteredInternal=${field(vue.filteredInternal)}`,
      );
    }
  }
  const capabilities = asRecord(data.capabilities);
  if (capabilities) {
    lines.push(
      `capabilities styleDependency=${field(capabilities.styleDependency)} styleSelector=${field(capabilities.styleSelector)} htmlFileRef=${field(capabilities.htmlFileRef)} vue=${field(capabilities.vue)} templateReferences=${field(capabilities.templateReferences)} apiSurface=${field(capabilities.apiSurface)} incremental=${field(capabilities.incremental)} mcpFormats=${field(capabilities.mcpFormats)}`,
    );
  }
  validateLineLength(lines, 0);
  return lines;
}

function doctorLines(data: Row): string[] {
  const lines = rowsOf(data, 'checks').map(
    (check) => `${str(check.status)}  ${str(check.id)}  ${str(check.detail)}`,
  );
  const summary = asRecord(data.summary);
  if (summary) {
    lines.push(
      `summary pass=${field(summary.pass)} warn=${field(summary.warn)} fail=${field(summary.fail)}`,
    );
  }
  return lines;
}

function initLines(data: Row): string[] {
  const lines: string[] = [];
  lines.push(`selected ${Array.isArray(data.selected) ? data.selected.join(',') : ''}`);
  lines.push(`written ${field(data.written)}`);
  for (const candidate of rowsOf(data, 'candidates')) {
    lines.push(
      `candidate ${str(candidate.rootId)}  ${str(candidate.rootPath)}  indexable=${field(candidate.indexable)}  typecheck=${str(candidate.typecheck, 'not-run')}`,
    );
  }
  for (const message of Array.isArray(data.messages) ? data.messages : [])
    lines.push(`message ${String(message)}`);
  return lines;
}

function apiSnapshotLines(data: Row): string[] {
  const lines: string[] = [];
  lines.push(
    `baseline ${str(data.path, '-')} hash=${str(data.surfaceHash, '-')} overwritten=${field(data.overwritten)}`,
  );
  for (const root of rowsOf(data, 'roots')) {
    lines.push(
      `root ${str(root.rootId)}  entries=${field(root.entries)} internal=${field(root.internal)} opaque=${field(root.opaque)} deprecated=${field(root.deprecated)} hash=${str(root.surfaceHash, '-')}`,
    );
  }
  return lines;
}

function apiDiffLines(data: Row): string[] {
  const lines = rowsOf(data).map((item) => {
    const before = asRecord(item.before);
    const after = asRecord(item.after);
    return `${str(item.severity)}  ${str(item.code)}  ${str(item.rootId)}  ${str(item.name)}  ${str(item.entryPath, '-')}#${str(item.condition, '-')}  ${str(item.rationale)}${before === null && after !== null ? ' [added]' : before !== null && after === null ? ' [removed]' : ''}`;
  });
  const counts = asRecord(data.counts);
  if (counts) {
    lines.push(
      `summary breaking=${field(counts.breaking)} additive=${field(counts.additive)} internal=${field(counts.internal)} ambiguous=${field(counts.ambiguous)} total=${field(counts.total)} failOn=${str(data.failOn)}`,
    );
  }
  return lines;
}

function buildLines(data: Row): string[] {
  const lines: string[] = [];
  for (const root of rowsOf(data, 'roots')) {
    if (root.ok === true) {
      lines.push(
        `root ${str(root.rootId)}  ok  files=${field(root.files)} symbols=${field(root.symbols)} refs=${field(root.references)} ms=${field(root.durationMs)} build=${str(root.buildFingerprint, '').slice(0, 12)}`,
      );
    } else {
      lines.push(
        `root ${str(root.rootId)}  failed  code=${str(root.errorCode, 'E23')}  ${str(root.errorMessage)}`,
      );
    }
  }
  const failed = Array.isArray(data.failedRoots) ? data.failedRoots : [];
  lines.push(`failedRoots ${failed.length === 0 ? '-' : failed.join(',')}`);
  lines.push(`totalMs ${field(data.totalMs)}`);
  return lines;
}

function entriesFor(command: string, data: Row): string[] {
  switch (command) {
    case 'references':
      return referenceLines(data);
    case 'symbol':
    case 'search':
      return symbolLines(data);
    case 'status':
      return statusLines(data);
    case 'doctor':
      return doctorLines(data);
    case 'init':
      return initLines(data);
    case 'build':
      return buildLines(data);
    case 'api-snapshot':
      return apiSnapshotLines(data);
    case 'api-diff':
      return apiDiffLines(data);
    default:
      return [];
  }
}

function validateLineLength(lines: string[], _width: number): void {
  void lines;
  void _width;
}

export function renderLines(input: RenderInput): string {
  const entries = entriesFor(input.command, input.data);
  const summary = footer(input.data);
  const notes = Array.isArray(input.data.notes)
    ? input.data.notes.map((entry) => `note ${String(entry)}`)
    : [];
  return [...entries, ...notes, ...(summary === '' ? [] : [summary])].join('\n');
}

function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function renderMarkdown(input: RenderInput): string {
  const { command, data } = input;
  const lines: string[] = [`# nex ${command}`, ''];
  const summary = summaryFields(data);
  if (summary.length > 0) {
    lines.push('## Summary', '', ...summary.map((entry) => `- ${entry}`), '');
  }
  if (command === 'references') {
    const rows = rowsOf(data).map((item) => [
      `${str(item.path)}:${field(item.line)}:${field(item.col)}`,
      str(item.kind),
      str(item.symbolId),
      str(item.reason),
      str(item.relationClass),
      str(item.confidence),
    ]);
    if (rows.length > 0) {
      lines.push(
        '## References',
        '',
        markdownTable(['Location', 'Kind', 'Symbol', 'Reason', 'Relation', 'Confidence'], rows),
        '',
      );
    }
  } else if (command === 'symbol' || command === 'search') {
    const rows = rowsOf(data).map((item) => [
      `${str(item.path)}:${field(item.startLine)}:${field(item.startCol)}`,
      str(item.kind),
      str(item.symbolId),
      str(item.nameChain),
      str(item.identityConfidence),
    ]);
    if (rows.length > 0) {
      lines.push(
        '## Symbols',
        '',
        markdownTable(['Location', 'Kind', 'SymbolId', 'Name', 'Identity'], rows),
        '',
      );
    }
  } else if (command === 'status') {
    const rows = rowsOf(data, 'roots').map((root) => [
      str(root.rootId),
      str(root.rootPath),
      `${str(root.state)}/${str(root.staleness)}`,
      field(root.files),
      field(root.symbols),
      field(root.references),
      str(root.buildFingerprintPrefix, '-'),
    ]);
    lines.push(
      '## Roots',
      '',
      markdownTable(
        ['Root', 'Path', 'State', 'Files', 'Symbols', 'References', 'Fingerprint'],
        rows,
      ),
      '',
    );
  } else if (command === 'doctor') {
    const rows = rowsOf(data, 'checks').map((check) => [
      str(check.status),
      str(check.id),
      str(check.detail),
    ]);
    lines.push('## Checks', '', markdownTable(['Status', 'Check', 'Detail'], rows), '');
  } else if (command === 'init') {
    const rows = rowsOf(data, 'candidates').map((candidate) => [
      str(candidate.rootId),
      str(candidate.rootPath),
      field(candidate.indexable),
      str(candidate.typecheck, 'not-run'),
    ]);
    lines.push(
      '## Candidates',
      '',
      markdownTable(['Root', 'Path', 'Indexable', 'Typecheck'], rows),
      '',
    );
  } else if (command === 'api-snapshot') {
    const rows = rowsOf(data, 'roots').map((root) => [
      str(root.rootId),
      field(root.entries),
      field(root.internal),
      field(root.opaque),
      field(root.deprecated),
      str(root.surfaceHash, '-'),
    ]);
    lines.push(
      '## Roots',
      '',
      markdownTable(['Root', 'Entries', 'Internal', 'Opaque', 'Deprecated', 'Hash'], rows),
      '',
    );
  } else if (command === 'api-diff') {
    const rows = rowsOf(data).map((item) => [
      str(item.severity),
      str(item.code),
      str(item.rootId),
      str(item.name),
      `${str(item.entryPath, '-')}#${str(item.condition, '-')}`,
      str(item.rationale),
    ]);
    if (rows.length > 0) {
      lines.push(
        '## Differences',
        '',
        markdownTable(['Severity', 'Code', 'Root', 'Name', 'Entry', 'Rationale'], rows),
        '',
      );
    }
  } else if (command === 'build') {
    const rows = rowsOf(data, 'roots').map((root) => [
      str(root.rootId),
      field(root.ok),
      field(root.symbols),
      field(root.references),
      field(root.durationMs),
      root.ok === true ? str(root.buildFingerprint).slice(0, 12) : str(root.errorCode),
    ]);
    lines.push(
      '## Roots',
      '',
      markdownTable(['Root', 'OK', 'Symbols', 'References', 'ms', 'Build/Error'], rows),
      '',
    );
  }
  const notes = Array.isArray(data.notes) ? data.notes.map((entry) => String(entry)) : [];
  if (notes.length > 0) lines.push('## Notes', '', ...notes.map((entry) => `- ${entry}`), '');
  return lines.join('\n').trimEnd();
}

function conclusion(command: string, data: Row): string {
  switch (command) {
    case 'status':
      return `Index state: ${str(data.state, 'uninitialized')} (${str(data.staleness, 'uninitialized')})`;
    case 'references':
      return `References: ${field(asRecord(data.counts)?.total ?? 0)} matches, staleness ${str(data.staleness, 'fresh')}`;
    case 'symbol':
      return `Symbol: ${str(rowsOf(data)[0]?.nameChain)}`;
    case 'search':
      return `Search: ${field(asRecord(data.counts)?.total ?? 0)} matches`;
    case 'doctor':
      return `Doctor: ${field(asRecord(data.summary)?.pass ?? 0)} pass, ${field(asRecord(data.summary)?.warn ?? 0)} warn, ${field(asRecord(data.summary)?.fail ?? 0)} fail`;
    case 'build':
      return `Build: ${Array.isArray(data.failedRoots) && data.failedRoots.length > 0 ? 'failed' : 'ok'}`;
    case 'api-snapshot':
      return `API baseline: ${str(data.path, '-')} (${field(asRecord(data.counts)?.entries ?? 0)} entries)`;
    case 'api-diff':
      return `API diff: ${field(asRecord(data.counts)?.breaking ?? 0)} breaking, ${field(asRecord(data.counts)?.additive ?? 0)} additive, ${field(asRecord(data.counts)?.ambiguous ?? 0)} ambiguous`;
    case 'init':
      return `Init: ${field(data.written) === 'true' ? 'configuration written' : 'dry run'}`;
    default:
      return command;
  }
}

export function renderPretty(input: RenderInput, options: RenderOptions): string {
  const { command, data } = input;
  const colorize = (text: string, format: 'bold' | 'green' | 'yellow' | 'red' | 'dim'): string =>
    options.color ? styleText(format, text) : text;
  const lines: string[] = [];
  lines.push(colorize(conclusion(command, data), 'bold'));
  const entries = entriesFor(command, data);
  if (entries.length > 0) {
    lines.push('');
    lines.push(...entries);
  }
  const summary = footer(data);
  if (summary !== '') {
    lines.push('');
    lines.push(colorize('Coverage & completeness', 'dim'));
    lines.push(summary);
  }
  const notes = Array.isArray(data.notes) ? data.notes.map((entry) => String(entry)) : [];
  const guidance = Array.isArray(data.guidance) ? data.guidance.map((entry) => String(entry)) : [];
  if (notes.length > 0 || guidance.length > 0) {
    lines.push('');
    lines.push(colorize('Next steps', 'dim'));
    for (const note of notes) lines.push(`  ${note}`);
    for (const step of guidance) lines.push(`  ${step}`);
  }
  if (options.explain && rowsOf(data).length > 0) {
    lines.push('');
    lines.push(colorize('Evidence', 'dim'));
    for (const item of rowsOf(data)) {
      if (typeof item.identityEvidence === 'object' && item.identityEvidence !== null) {
        lines.push(`  ${str(item.nameChain, str(item.symbolId))}: ${field(item.identityEvidence)}`);
      }
    }
  }
  void options.width;
  return lines.join('\n');
}

export function renderOutput(
  input: RenderInput,
  format: OutputFormat,
  options: RenderOptions,
): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(input.data, null, 2)}`;
    case 'markdown':
      return renderMarkdown(input);
    case 'pretty':
      return renderPretty(input, options);
    case 'lines':
    default:
      return renderLines(input);
  }
}

export interface ErrorRender {
  text: string;
  exitCode: number;
}

function relativeProjectHint(): string {
  return 'Run `nex status` to inspect Node, configuration and index state.';
}

export function renderError(error: NexusError, format: OutputFormat, exitCode: number): string {
  const payload = {
    error: {
      code: error.code,
      category: error.category,
      severity: error.severity,
      message: error.message,
      reason: error.reason,
      file: error.file,
      suggestion: error.suggestion,
      evidence: error.evidence,
    },
    exitCode,
  };
  if (format === 'json') return JSON.stringify(payload, null, 2);
  const lines = [
    error.message,
    error.suggestion === '' ? relativeProjectHint() : `Run: ${error.suggestion}`,
    `Check: node ${process.versions.node}; code ${error.code}; category ${error.category}${error.file === null ? '' : `; file ${error.file}`}`,
    'If the command is not this tool, use the backup command: anex.',
  ];
  return lines.join('\n');
}
