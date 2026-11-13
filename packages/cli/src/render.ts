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
      `root ${str(root.rootId)}  ${str(root.rootPath)}  ${str(root.state)}/${str(root.staleness)}  files=${field(root.files)} symbols=${field(root.symbols)} refs=${field(root.references)} deps=${field(root.dependencies)} calls=${field(root.calls)} tests=${field(root.tests)}  build=${str(root.buildFingerprintPrefix, '-')}  surface=${field(root.surfaceEntries)}`,
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
      `capabilities styleDependency=${field(capabilities.styleDependency)} styleSelector=${field(capabilities.styleSelector)} htmlFileRef=${field(capabilities.htmlFileRef)} vue=${field(capabilities.vue)} templateReferences=${field(capabilities.templateReferences)} apiSurface=${field(capabilities.apiSurface)} dependencyGraph=${field(capabilities.dependencyGraph)} callGraph=${field(capabilities.callGraph)} architectureRules=${field(capabilities.architectureRules)} incremental=${field(capabilities.incremental)} mcpFormats=${field(capabilities.mcpFormats)}`,
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

function depsLines(data: Row): string[] {
  const lines: string[] = [];
  for (const item of rowsOf(data)) {
    const relationClass = str(item.relationClass, 'certain');
    const prefix =
      relationClass === 'dynamic-unresolved' ? '!' : relationClass === 'heuristic' ? '?' : ' ';
    const kind = str(item.kind, 'dependency');
    if (kind === 'module-edge') {
      lines.push(
        `  module ${str(item.sourceFile)} -> ${str(item.targetFile)}  ${str(item.depType)}  edges=${field(item.edgeCount ?? 0)}  ${relationClass}  ${field(item.edgeCounts ?? {})}`,
      );
      continue;
    }
    if (kind === 'violation') {
      lines.push(
        `${prefix} violation ${str(item.ruleId)}  ${str(item.sourceFile)}:${field(item.line)}:${field(item.col)}  ${str(item.sourceModule)} -> ${str(item.targetModule)}  ${str(item.depType)}`,
      );
      continue;
    }
    if (kind === 'call') {
      const callee = str(item.calleeName) || str(item.calleeSymbolId) || '<unresolved>';
      lines.push(
        `${prefix} call ${str(item.sourceFile)}:${field(item.line)}:${field(item.col)}  ${str(item.callerName) || '<top-level>'} -> ${callee}  ${relationClass}  ${str(item.confidence)}  ${str(item.unresolvedReason, '-')}`,
      );
      continue;
    }
    const target =
      str(item.targetFile) ||
      `${str(item.specifier, '?')} (${str(item.unresolvedReason, 'unresolved')})`;
    lines.push(
      `${prefix} ${str(item.sourceFile)}:${field(item.line)}:${field(item.col)}  ${str(item.depType)} -> ${target}  ${relationClass}  ${str(item.confidence)}  ${str(item.unresolvedReason, '-')}`,
    );
  }
  const architecture = asRecord(data.architecture);
  if (architecture !== null) {
    const modules = Array.isArray(architecture.modules) ? architecture.modules.length : 0;
    const violations = Array.isArray(architecture.violations) ? architecture.violations.length : 0;
    lines.push(`architecture modules=${modules} violations=${violations}`);
  }
  const blindSpots = Array.isArray(data.blindSpots) ? data.blindSpots : [];
  if (blindSpots.length > 0) {
    for (const spot of blindSpots) {
      const record = asRecord(spot);
      if (record === null) continue;
      lines.push(
        `blindSpot ${str(record.category)}/${str(record.missReason)} files=${field(record.affectedFiles)} symbols=${field(record.potentiallyAffectedSymbols)} hint=${str(record.manualCheckHint)}`,
      );
    }
  }
  return lines;
}

function impactLines(data: Row): string[] {
  const lines: string[] = [];
  const risk = asRecord(data.risk);
  const target = asRecord(data.target);
  lines.push(
    `risk ${str(risk?.level, 'Low')}  target ${str(target?.kind, 'file')} ${str(target?.filePath, str(target?.name, '-'))}  fanout=${field(data.impactFanout)}`,
  );
  for (const reason of Array.isArray(risk?.reasons) ? risk.reasons : []) {
    const record = asRecord(reason);
    if (record === null) continue;
    lines.push(`  reason ${str(record.rule)}  ${str(record.detail)}`);
  }
  const direct = asRecord(data.direct);
  const indirect = asRecord(data.indirect);
  lines.push(
    `direct ${field(direct?.count)}  indirect ${field(indirect?.count)} depth=${field(indirect?.depth)}`,
  );
  for (const [label, section] of [
    ['direct', direct],
    ['indirect', indirect],
  ] as const) {
    const items = Array.isArray(section?.items) ? section.items : [];
    for (const entry of items.slice(0, 100)) {
      const item = asRecord(entry);
      if (item === null) continue;
      const relationClass = str(item.relationClass, 'certain');
      const prefix =
        relationClass === 'dynamic-unresolved' ? '!' : relationClass === 'heuristic' ? '?' : ' ';
      lines.push(
        `${prefix} ${label} ${str(item.kind)} ${str(item.path)}:${field(item.line)}:${field(item.col)} ${str(item.name, str(item.symbolId, '-'))} ${str(item.reason)} ${relationClass} ${str(item.confidence)}`,
      );
    }
  }
  const surface = asRecord(data.surface);
  if (surface !== null) {
    lines.push(
      `surface diffLevel=${str(surface.diffLevel)} basis=${str(surface.basis)} entries=${Array.isArray(surface.affected) ? surface.affected.length : 0}`,
    );
    for (const entry of Array.isArray(surface.affected) ? surface.affected.slice(0, 20) : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(
        `  surface ${str(item.name)} evidence=${str(item.primaryEvidenceSource)} exportKind=${str(item.exportKind)}`,
      );
    }
  }
  for (const [key, label] of [
    ['components', 'component'],
    ['types', 'type'],
  ] as const) {
    const section = asRecord(data[key]);
    const items = Array.isArray(section?.affected) ? section.affected : [];
    for (const entry of items.slice(0, 20)) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(`  ${label} ${str(item.name)} ${str(item.path)}:${field(item.line)}`);
    }
  }
  const tests = asRecord(data.tests);
  if (tests !== null) {
    lines.push(`tests related=${Array.isArray(tests.related) ? tests.related.length : 0}`);
    for (const entry of Array.isArray(tests.related) ? tests.related.slice(0, 20) : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(
        `  test ${str(item.testFile)}:${field(item.line)} ${str(item.testType)} ${str(item.relationClass)}`,
      );
    }
    for (const suggestion of Array.isArray(tests.suggestedCommands)
      ? tests.suggestedCommands
      : []) {
      lines.push(`  verify ${String(suggestion)}`);
    }
  }
  const docs = asRecord(data.docs);
  if (docs !== null) {
    for (const entry of Array.isArray(docs.related) ? docs.related.slice(0, 20) : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(`  doc ${str(item.path)}:${field(item.line)} ${str(item.match)}`);
    }
  }
  for (const entry of Array.isArray(data.styleDependents) ? data.styleDependents : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `  styleDependent ${str(item.sourceFile)}:${field(item.line)} ${str(item.depType)} ${str(item.confidence)}`,
    );
  }
  for (const entry of Array.isArray(data.blindSpots) ? data.blindSpots : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `blindSpot ${str(item.category)}/${str(item.missReason)} files=${field(item.affectedFiles)} symbols=${field(item.potentiallyAffectedSymbols)}`,
    );
  }
  return lines;
}

function preflightLines(data: Row): string[] {
  const lines: string[] = [];
  const risk = asRecord(data.risk);
  lines.push(`risk ${str(risk?.level, 'Low')}  scope=${str(data.scope)}`);
  const similar = asRecord(data.similar);
  if (similar !== null) {
    lines.push(
      `similar rules=${str(similar.rulesVersion)} candidates=${Array.isArray(similar.candidates) ? similar.candidates.length : 0} noSimilarFound=${field(similar.noSimilarFound)}`,
    );
    for (const entry of Array.isArray(similar.candidates) ? similar.candidates.slice(0, 20) : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      const candidate = asRecord(item.candidate);
      const location = asRecord(item.location);
      lines.push(
        `? ${field(item.score)} ${str(candidate?.name)} ${str(location?.path)}:${field(location?.line)} suggestion=${str(item.suggestion)} basis=${Array.isArray(item.matchBasis) ? item.matchBasis.join(',') : ''}`,
      );
    }
  }
  for (const entry of Array.isArray(data.existingApis) ? data.existingApis : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `existingApi ${str(item.name)} evidence=${str(item.primaryEvidenceSource)} exportKind=${str(item.exportKind)}`,
    );
  }
  for (const entry of Array.isArray(data.sources) ? data.sources : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `source ${str(item.path)}:${field(item.line)}:${field(item.col)} ${str(item.kind)} ${str(item.nameChain)}`,
    );
  }
  const deps = asRecord(data.dependencies);
  lines.push(`dependencies direct=${field(deps?.direct)} indirect=${field(deps?.indirect)}`);
  for (const entry of Array.isArray(data.blindSpots) ? data.blindSpots : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `blindSpot ${str(item.category)}/${str(item.missReason)} files=${field(item.affectedFiles)}`,
    );
  }
  return lines;
}

function postflightLines(data: Row): string[] {
  const lines: string[] = [];
  lines.push(
    `base ${str(data.base)} staleness=${str(data.staleness)} confidence=${str(data.confidence)} scope=${str(data.scope)}`,
  );
  const changed = asRecord(data.changed);
  const files = Array.isArray(changed?.files) ? changed.files : [];
  const symbols = Array.isArray(changed?.symbols) ? changed.symbols : [];
  lines.push(
    `changed files=${files.length} symbols=${symbols.length} unidentified=${Array.isArray(changed?.unidentified) ? changed.unidentified.length : 0}`,
  );
  for (const entry of files.slice(0, 50)) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `${str(item.status)} ${str(item.path)} symbols=${field(item.symbols)} lines=${field(item.lines)}`,
    );
  }
  for (const entry of symbols.slice(0, 100)) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `${str(item.change)} ${str(item.kind)} ${str(item.path)}:${field(item.line)} ${str(item.nameChain ?? item.name)} ${str(item.symbolId, '-')}`,
    );
  }
  for (const entry of Array.isArray(data.findings) ? data.findings : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `${str(item.severity)} ${str(item.code)} ${str(item.origin)} ${str(item.file)}:${field(item.line)} ${str(item.suggestion)}`,
    );
  }
  const surface = asRecord(data.surfaceDiff);
  if (surface !== null) {
    lines.push(
      `surface breaking=${Array.isArray(surface.breaking) ? surface.breaking.length : 0} additive=${Array.isArray(surface.additive) ? surface.additive.length : 0} ambiguous=${Array.isArray(surface.ambiguous) ? surface.ambiguous.length : 0} internal=${Array.isArray(surface.internal) ? surface.internal.length : 0}`,
    );
  }
  for (const entry of Array.isArray(data.dependencyChanges) ? data.dependencyChanges : []) {
    const item = asRecord(entry);
    if (item === null) continue;
    lines.push(
      `deps ${str(item.file)} +${Array.isArray(item.added) ? item.added.join(',') : ''} -${Array.isArray(item.removed) ? item.removed.join(',') : ''}`,
    );
  }
  const verification = asRecord(data.verification);
  if (verification !== null) {
    for (const entry of Array.isArray(verification.commands) ? verification.commands : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(
        `verify ${str(item.id)} ${str(item.status)} exit=${field(item.exitCode)} ${field(item.durationMs)}ms ${str(item.cmd)} ${Array.isArray(item.args) ? item.args.join(' ') : ''}`,
      );
    }
    for (const entry of Array.isArray(verification.skipped) ? verification.skipped : []) {
      const item = asRecord(entry);
      if (item === null) continue;
      lines.push(`verify ${str(item.id)} skipped ${str(item.reason)}`);
    }
  }
  const exit = asRecord(data.exit);
  lines.push(
    `exit code=${field(exit?.code)} blocking=${field(exit?.blocking)} warnings=${field(exit?.warnings)} failOn=${str(exit?.failOn)}`,
  );
  return lines;
}

function verifyLines(data: Row): string[] {
  return (Array.isArray(data.commands) ? data.commands : []).map((entry) => {
    const item = asRecord(entry) ?? {};
    return `${str(item.status)} ${str(item.id)} exit=${field(item.exitCode)} ${field(item.durationMs)}ms ${str(item.cmd)} ${Array.isArray(item.args) ? item.args.join(' ') : ''} cwd=${str(item.cwd)} timeout=${field(item.timeoutMs)}ms auth=${str(item.authorization)}`;
  });
}

function entriesFor(command: string, data: Row): string[] {
  switch (command) {
    case 'references':
      return referenceLines(data);
    case 'deps':
      return depsLines(data);
    case 'impact':
      return impactLines(data);
    case 'preflight':
      return preflightLines(data);
    case 'postflight':
      return postflightLines(data);
    case 'verify':
      return verifyLines(data);
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
  const groups = Array.isArray(input.data.byRoot) ? input.data.byRoot : [];
  const entries =
    groups.length > 1
      ? groups.flatMap((group) => {
          const record = asRecord(group) ?? {};
          const rootId = str(record.rootId);
          const groupData = {
            ...input.data,
            ...record,
            counts: record.counts,
            coverage: record.coverage,
            items: record.items,
          };
          return entriesFor(input.command, groupData).map((line) => `[${rootId}] ${line}`);
        })
      : entriesFor(input.command, input.data);
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
  const groups = Array.isArray(data.byRoot) ? data.byRoot : [];
  if (groups.length > 1) {
    const sections: string[] = [`# nex ${command}`, ''];
    for (const group of groups) {
      const record = asRecord(group) ?? {};
      const groupData = {
        ...data,
        ...record,
        counts: record.counts,
        coverage: record.coverage,
        items: record.items,
        byRoot: undefined,
        notes: record.notes,
      };
      const rendered = renderMarkdown({ command, data: groupData }).split('\n');
      const body = rendered.slice(1).join('\n').replace(/^\n+/, '');
      sections.push(`## Root ${str(record.rootId)} (${str(record.staleness)})`, '', body, '');
    }
    const notes = Array.isArray(data.notes) ? data.notes.map((entry) => String(entry)) : [];
    if (notes.length > 0) sections.push('## Notes', '', ...notes.map((entry) => `- ${entry}`), '');
    return sections.join('\n').trimEnd();
  }
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
  } else if (command === 'deps') {
    const rows = rowsOf(data).map((item) => [
      str(item.kind, 'dependency'),
      `${str(item.sourceFile)}:${field(item.line)}:${field(item.col)}`,
      str(item.depType),
      str(item.targetFile) || str(item.specifier, '-'),
      str(item.relationClass),
      str(item.confidence),
      str(item.unresolvedReason, '-'),
    ]);
    if (rows.length > 0) {
      lines.push(
        '## Relations',
        '',
        markdownTable(
          ['Kind', 'Source', 'Type', 'Target', 'Relation', 'Confidence', 'Reason'],
          rows,
        ),
        '',
      );
    }
    const blindSpots = Array.isArray(data.blindSpots) ? data.blindSpots : [];
    if (blindSpots.length > 0) {
      lines.push(
        '## Blind spots',
        '',
        markdownTable(
          ['Category', 'Reason', 'Files', 'Symbols', 'Hint'],
          blindSpots.map((entry) => {
            const spot = asRecord(entry) ?? {};
            return [
              str(spot.category),
              str(spot.missReason),
              field(spot.affectedFiles),
              field(spot.potentiallyAffectedSymbols),
              str(spot.manualCheckHint),
            ];
          }),
        ),
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
  } else if (['impact', 'preflight', 'postflight', 'verify'].includes(command)) {
    const details = entriesFor(command, data);
    if (details.length > 0) {
      lines.push('## Details', '', '```text', ...details.slice(0, 500), '```', '');
    }
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
    case 'deps':
      return `Dependencies (${str(data.type, 'file')}): ${field(asRecord(data.counts)?.total ?? 0)} relations, ${field(asRecord(data.counts)?.certain ?? 0)} certain, ${field(asRecord(data.counts)?.heuristic ?? 0)} heuristic, ${field(asRecord(data.counts)?.dynamicUnresolved ?? 0)} unresolved`;
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
    case 'impact':
      return `Impact: risk ${str(asRecord(data.risk)?.level, 'Low')}, ${field(asRecord(data.direct)?.count ?? 0)} direct / ${field(asRecord(data.indirect)?.count ?? 0)} indirect, staleness ${str(data.staleness, 'fresh')}`;
    case 'preflight':
      return `Preflight: risk ${str(asRecord(data.risk)?.level, 'Low')}, ${Array.isArray(asRecord(data.similar)?.candidates) ? (asRecord(data.similar)?.candidates as unknown[]).length : 0} similar candidate(s)`;
    case 'postflight':
      return `Postflight: ${field(asRecord(data.counts)?.total ?? 0)} changed symbol(s), confidence ${str(data.confidence)}, exit ${field(asRecord(data.exit)?.code ?? 0)}`;
    case 'verify':
      return `Verify: ${field(asRecord(data.counts)?.total ?? 0)} command(s), ${field(data.failed ?? 0)} failed`;
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
  const groups = Array.isArray(data.byRoot) ? data.byRoot : [];
  if (groups.length > 1) {
    for (const group of groups) {
      const record = asRecord(group) ?? {};
      lines.push('');
      lines.push(colorize(`root ${str(record.rootId)} (${str(record.staleness)})`, 'bold'));
      const groupData = {
        ...data,
        ...record,
        counts: record.counts,
        coverage: record.coverage,
        items: record.items,
      };
      lines.push(...entriesFor(command, groupData));
    }
  } else {
    const entries = entriesFor(command, data);
    if (entries.length > 0) {
      lines.push('');
      lines.push(...entries);
    }
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
      if (command === 'deps') {
        lines.push(
          `  ${str(item.sourceFile)}:${field(item.line)}:${field(item.col)} ${str(item.depType)} ${field(item.evidence)}`,
        );
        continue;
      }
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
