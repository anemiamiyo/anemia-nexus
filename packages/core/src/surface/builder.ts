import ts from 'typescript';

import { isInside } from '../util/paths.js';

import type { ComponentRecord, SymbolRecord } from '../model.js';
import type { SurfaceConfig } from '../config/schema.js';
import { stableStringify } from '../util/stable-json.js';
import { sha256Base32 } from '../util/hash.js';
import { parsePackageExports } from './exports.js';
import { ExportResolver, type ExportTag, type ResolvedExport } from './export-graph.js';
import type {
  DeprecatedChain,
  SurfaceEntry,
  SurfaceEvidenceSource,
  SurfaceExportKind,
  SurfaceInternalRecord,
  SurfaceKind,
  SurfaceOpaqueRecord,
  SurfacePropsCoverage,
  SurfaceRootSnapshot,
  SurfaceStability,
  SurfaceUnresolvedProp,
} from './types.js';

const EVIDENCE_PRIORITY: Record<SurfaceEvidenceSource, number> = {
  'manual-override': 0,
  'package-exports': 1,
  'explicit-entry': 2,
  'barrel-derived': 3,
  none: 4,
};

function evidenceRank(value: SurfaceEvidenceSource): number {
  return EVIDENCE_PRIORITY[value];
}

function sortedEvidence(values: Iterable<SurfaceEvidenceSource>): SurfaceEvidenceSource[] {
  return [...new Set(values)].sort((left, right) => {
    const rank = evidenceRank(left) - evidenceRank(right);
    return rank !== 0 ? rank : left < right ? -1 : left > right ? 1 : 0;
  });
}

function primaryEvidence(values: readonly SurfaceEvidenceSource[]): SurfaceEvidenceSource {
  let best: SurfaceEvidenceSource = 'none';
  for (const value of values) {
    if (evidenceRank(value) < evidenceRank(best)) best = value;
  }
  return best;
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function kindOf(symbols: readonly SymbolRecord[]): SurfaceKind {
  if (symbols.some((symbol) => symbol.kind === 'component')) return 'component';
  if (symbols.length > 0 && symbols.every((symbol) => symbol.isTypeOnly)) return 'type';
  const functions = symbols.filter((symbol) => symbol.kind === 'fn');
  if (functions.length > 0 && functions.every((symbol) => /^use[A-Z]/.test(symbol.name))) {
    return 'composable';
  }
  return 'value';
}

function exportKindOf(
  symbols: readonly SymbolRecord[],
  exportTypeOnly: boolean,
): SurfaceExportKind {
  if (exportTypeOnly) return 'type';
  const typeOnly = symbols.filter((symbol) => symbol.isTypeOnly).length;
  if (typeOnly === symbols.length && symbols.length > 0) return 'type';
  if (typeOnly > 0) return 'both';
  return 'value';
}

function tagsOf(groups: readonly EntryGroup[]): ExportTag[] {
  const output: ExportTag[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const tag of group.tags) {
      const key = `${tag.name}\u0000${tag.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(tag);
    }
  }
  return output;
}

function tagByNames(tags: readonly ExportTag[], names: readonly string[]): ExportTag | null {
  const lowered = new Set(names.map((name) => name.toLowerCase()));
  return tags.find((tag) => lowered.has(tag.name.toLowerCase())) ?? null;
}

function docLinkOf(tags: readonly ExportTag[]): string | null {
  for (const tag of tags) {
    const match = /https?:\/\/[^\s)}\]]+/.exec(tag.text);
    if (match !== null) return match[0];
  }
  return null;
}

function successorNames(tags: readonly ExportTag[]): string[] {
  const names: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim().replace(/^['"`]|['"`]$/g, '');
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) names.push(trimmed);
  };
  for (const tag of tags) {
    if (!['deprecated', 'see', 'replacement', 'successor'].includes(tag.name.toLowerCase())) {
      continue;
    }
    const linkPattern = /\{@link(?:code|plain)?\s+([^}]+)\}/g;
    for (const match of tag.text.matchAll(linkPattern)) {
      push((match[1] as string).split('|')[0] as string);
    }
    const usePattern =
      /\b(?:use|use instead|replaced by|replacement|see)\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/gi;
    for (const match of tag.text.matchAll(usePattern)) {
      push(match[1] as string);
    }
    if (tag.name.toLowerCase() === 'see') push(tag.text);
  }
  return [...new Set(names)];
}

function sinceKey(
  rootId: string,
  entryPath: string | null,
  condition: string | null,
  name: string,
): string {
  return `${rootId}\u0000${entryPath ?? ''}\u0000${condition ?? ''}\u0000${name}`;
}

interface EntryGroup {
  name: string;
  entryPath: string | null;
  condition: string | null;
  symbols: SymbolRecord[];
  evidence: Set<SurfaceEvidenceSource>;
  derived: boolean;
  tags: ExportTag[];
  exportTypeOnly: boolean;
  manualOverrideConflict: boolean;
  manualReason: string | null;
}

function addSymbol(group: EntryGroup, symbol: SymbolRecord): void {
  if (!group.symbols.some((entry) => entry.symbolId === symbol.symbolId)) {
    group.symbols.push(symbol);
  }
}

function sortSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  return symbols.sort((left, right) => {
    if (left.declarationLocator.overloadOrdinal !== right.declarationLocator.overloadOrdinal) {
      return left.declarationLocator.overloadOrdinal - right.declarationLocator.overloadOrdinal;
    }
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.nameLine !== right.nameLine) return left.nameLine - right.nameLine;
    return left.nameCol - right.nameCol;
  });
}

export interface BuildSurfaceInput {
  projectRoot: string;
  rootAbs: string;
  rootId: string;
  rootPath: string;
  packageName: string | null;
  buildId: string;
  buildFingerprint: string;
  programs: ts.Program;
  files: readonly string[];
  symbols: readonly SymbolRecord[];
  components: readonly ComponentRecord[];
  config: SurfaceConfig;
  sinceByKey?: ReadonlyMap<string, string>;
}

export function buildSurface(input: BuildSurfaceInput): SurfaceRootSnapshot {
  const warnings: string[] = [];
  const resolver = new ExportResolver(input.programs, input.rootAbs);
  const packageExports = parsePackageExports(input.rootAbs, input.files);
  warnings.push(...packageExports.warnings);
  const packageVersion = packageExports.packageVersion;
  const packageName = packageExports.packageName ?? input.packageName;
  const components = new Map(input.components.map((component) => [component.symbolId, component]));

  const byPosition = new Map<string, SymbolRecord[]>();
  const byPathName = new Map<string, SymbolRecord[]>();
  for (const symbol of input.symbols) {
    const position = `${symbol.path}\u0000${symbol.nameLine}\u0000${symbol.nameCol}`;
    const positionList = byPosition.get(position) ?? [];
    positionList.push(symbol);
    byPosition.set(position, positionList);
    const name = `${symbol.path}\u0000${symbol.name}`;
    const nameList = byPathName.get(name) ?? [];
    nameList.push(symbol);
    byPathName.set(name, nameList);
  }

  const groups = new Map<string, EntryGroup>();
  const opaque = new Map<string, SurfaceOpaqueRecord>();

  const groupFor = (
    name: string,
    entryPath: string | null,
    condition: string | null,
  ): EntryGroup => {
    const key = `${name}\u0000${entryPath ?? ''}\u0000${condition ?? ''}`;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created: EntryGroup = {
      name,
      entryPath,
      condition,
      symbols: [],
      evidence: new Set(),
      derived: false,
      tags: [],
      exportTypeOnly: false,
      manualOverrideConflict: false,
      manualReason: null,
    };
    groups.set(key, created);
    return created;
  };

  const addResolved = (
    resolved: ResolvedExport,
    evidence: SurfaceEvidenceSource,
    entryPath: string,
    condition: string | null,
  ): void => {
    const positionSymbols =
      byPosition.get(
        `${resolved.declarationPath}\u0000${resolved.nameLine}\u0000${resolved.nameCol}`,
      ) ?? [];
    const symbols =
      positionSymbols.length > 0
        ? positionSymbols
        : (byPathName.get(`${resolved.declarationPath}\u0000${resolved.declarationName}`) ?? []);
    if (symbols.length === 0) {
      const key = `${resolved.exportName}\u0000${entryPath}\u0000${condition ?? ''}\u0000unmapped`;
      opaque.set(key, {
        name: resolved.exportName,
        entryPath,
        condition,
        reason: 'unmapped-declaration',
      });
      return;
    }
    const group = groupFor(
      resolved.exportName,
      evidence === 'package-exports' ? entryPath : entryPath,
      condition,
    );
    for (const symbol of symbols) addSymbol(group, symbol);
    group.evidence.add(evidence);
    if (resolved.derived) group.evidence.add('barrel-derived');
    group.derived = group.derived || resolved.derived;
    group.tags.push(...resolved.jsDocTags);
    group.exportTypeOnly = group.exportTypeOnly || resolved.exportTypeOnly;
  };

  for (const target of packageExports.targets) {
    const resolved = resolver.resolveEntry(target.file);
    if (resolved.warning !== null) warnings.push(resolved.warning);
    for (const opaqueExport of resolved.opaque) {
      const key = `${opaqueExport.name}\u0000${target.subpath}\u0000${target.condition ?? ''}\u0000${opaqueExport.reason}`;
      opaque.set(key, {
        name: opaqueExport.name,
        entryPath: target.subpath,
        condition: target.condition,
        reason: opaqueExport.reason,
      });
    }
    if (resolved.exports.length === 0 && resolved.opaque.length === 0) {
      warnings.push(
        `exports target has no resolvable exports: ${target.subpath} -> ${target.file}`,
      );
    }
    for (const entry of resolved.exports) {
      addResolved(entry, 'package-exports', target.subpath, target.condition);
    }
  }

  for (const entryFile of input.config.entries) {
    const normalized = entryFile.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!input.files.includes(normalized)) {
      warnings.push(`surface entry is not indexed: ${normalized}`);
      continue;
    }
    const resolved = resolver.resolveEntry(normalized);
    if (resolved.warning !== null) warnings.push(resolved.warning);
    for (const opaqueExport of resolved.opaque) {
      const key = `${opaqueExport.name}\u0000${normalized}\u0000\u0000${opaqueExport.reason}`;
      opaque.set(key, {
        name: opaqueExport.name,
        entryPath: normalized,
        condition: null,
        reason: opaqueExport.reason,
      });
    }
    for (const entry of resolved.exports) {
      addResolved(entry, entry.derived ? 'barrel-derived' : 'explicit-entry', normalized, null);
    }
  }

  // Explicit `export =` is an opaque boundary: it cannot be represented as a
  // named static export, so it must be surfaced for manual review.
  for (const sourceFile of input.programs.getSourceFiles()) {
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && statement.isExportEquals) {
        if (!isInside(input.rootAbs, sourceFile.fileName)) continue;
        const relative = sourceFile.fileName
          .slice(input.rootAbs.length)
          .replace(/^[\\/]/, '')
          .replaceAll('\\', '/');
        const key = `export=\u0000${relative}\u0000\u0000export-equals`;
        opaque.set(key, {
          name: 'export=',
          entryPath: relative,
          condition: null,
          reason: 'export-equals',
        });
      }
    }
  }

  // Manual overlays: match by symbolId, then nameChain, then name; the most
  // specific match wins, and conflicting exposures are reported, never guessed.
  const manualAssignments = new Map<
    string,
    { exposure: 'public' | 'internal'; reason: string | null; conflict: boolean }
  >();
  const manualUnmatched: Array<{
    manual: SurfaceConfig['manual'][number];
    symbols: SymbolRecord[];
  }> = [];
  for (const manual of input.config.manual) {
    const matches = input.symbols.filter((symbol) => {
      if (manual.symbolId !== undefined && symbol.symbolId === manual.symbolId) return true;
      if (manual.nameChain !== undefined && symbol.nameChain === manual.nameChain) return true;
      if (
        manual.name !== undefined &&
        (symbol.name === manual.name || symbol.nameChain === manual.name)
      ) {
        return true;
      }
      return false;
    });
    if (matches.length === 0) {
      manualUnmatched.push({ manual, symbols: [] });
      continue;
    }
    for (const symbol of matches) {
      const current = manualAssignments.get(symbol.symbolId);
      if (current !== undefined && current.exposure !== manual.exposure) {
        current.conflict = true;
        warnings.push(
          `manual override conflict for ${symbol.symbolId}: ${current.exposure} vs ${manual.exposure}`,
        );
        continue;
      }
      manualAssignments.set(symbol.symbolId, {
        exposure: manual.exposure,
        reason: manual.reason ?? null,
        conflict: current?.conflict ?? false,
      });
    }
  }

  const publicEntries: SurfaceEntry[] = [];
  const internalById = new Map<string, SurfaceInternalRecord>();
  const publicSymbolIds = new Set<string>();

  const entriesForGroup = (group: EntryGroup): SurfaceEntry | null => {
    if (group.symbols.length === 0) return null;
    sortSymbols(group.symbols);
    const exportKind = exportKindOf(group.symbols, group.exportTypeOnly);
    const kind = kindOf(group.symbols);
    const evidenceSources = sortedEvidence(group.evidence);
    const primary = primaryEvidence(evidenceSources);
    const tags = tagsOf([group]);
    const deprecated = tagByNames(tags, ['deprecated']) !== null;
    const component = group.symbols
      .map((symbol) => components.get(symbol.symbolId))
      .find((entry) => entry !== undefined);
    const propsCoverage: SurfacePropsCoverage | undefined =
      component === undefined
        ? undefined
        : {
            resolved: component.propsCoverage.resolved,
            total: component.propsCoverage.total,
          };
    const unresolvedProps: SurfaceUnresolvedProp[] | undefined =
      component === undefined
        ? undefined
        : component.propsCoverage.unresolved.map((entry) => ({
            name: entry.name,
            typeText: entry.typeText,
            reason: entry.reason,
          }));
    let stability: SurfaceStability = deprecated ? 'deprecated' : 'stable';
    if (
      component !== undefined &&
      (component.propsCoverage.total === 0 ||
        component.propsCoverage.resolved < component.propsCoverage.total)
    ) {
      stability = 'experimental';
    }
    if (group.symbols.some((symbol) => symbol.identityConfidence !== 'high' || symbol.volatile)) {
      if (stability === 'stable') stability = 'experimental';
    }
    const signatures = group.symbols
      .map((symbol) => normalizeSignature(symbol.signature))
      .filter((value, index, array) => value !== '' && array.indexOf(value) === index);
    const since =
      input.sinceByKey?.get(sinceKey(input.rootId, group.entryPath, group.condition, group.name)) ??
      packageVersion ??
      'unknown';
    const symbolId = (group.symbols[0] as SymbolRecord).symbolId;
    for (const symbol of group.symbols) publicSymbolIds.add(symbol.symbolId);
    const entry: SurfaceEntry = {
      name: group.name,
      normalizedSignature: signatures.join('\n'),
      signatures,
      kind,
      exportKind,
      isTypeOnly: exportKind === 'type',
      runtimePresent: exportKind !== 'type',
      entryPath: group.entryPath,
      condition: group.condition,
      evidenceSources,
      primaryEvidenceSource: primary,
      derived: group.derived,
      stability,
      since,
      ownerModule: null,
      docLink: docLinkOf(tags),
      symbolId,
      identityConfidence: group.symbols.some((symbol) => symbol.identityConfidence === 'high')
        ? 'high'
        : group.symbols.some((symbol) => symbol.identityConfidence === 'medium')
          ? 'medium'
          : 'low',
    };
    if (group.manualOverrideConflict) entry.manualOverrideConflict = true;
    if (propsCoverage !== undefined) entry.propsCoverage = propsCoverage;
    if (unresolvedProps !== undefined && unresolvedProps.length > 0) {
      entry.unresolvedProps = unresolvedProps;
    }
    return entry;
  };

  for (const group of groups.values()) {
    const manual = group.symbols
      .map((symbol) => manualAssignments.get(symbol.symbolId))
      .find((entry) => entry !== undefined);
    if (manual?.exposure === 'internal') {
      for (const symbol of group.symbols) {
        internalById.set(symbol.symbolId, internalRecordOf(symbol, ['manual-override']));
      }
      continue;
    }
    if (manual?.exposure === 'public') {
      group.evidence.add('manual-override');
      group.manualReason = manual.reason;
      if (manual.conflict) group.manualOverrideConflict = true;
    }
    const entry = entriesForGroup(group);
    if (entry !== null) publicEntries.push(entry);
  }

  for (const [symbolId, manual] of manualAssignments) {
    if (manual.exposure !== 'public') continue;
    if (publicSymbolIds.has(symbolId)) continue;
    const symbol = input.symbols.find((entry) => entry.symbolId === symbolId);
    if (symbol === undefined) continue;
    const existing = [...groups.values()].find((group) =>
      group.symbols.some((candidate) => candidate.symbolId === symbolId),
    );
    if (existing !== undefined) {
      existing.evidence.add('manual-override');
      existing.manualOverrideConflict = manual.conflict;
      continue;
    }
    const group = groupFor(symbol.name, null, null);
    addSymbol(group, symbol);
    group.evidence.add('manual-override');
    group.manualOverrideConflict = manual.conflict;
    group.manualReason = manual.reason;
    const entry = entriesForGroup(group);
    if (entry !== null) publicEntries.push(entry);
  }

  for (const { manual } of manualUnmatched) {
    if (manual.exposure === 'public') {
      warnings.push(
        `manual public override did not match any indexed symbol: ${manual.symbolId ?? manual.nameChain ?? manual.name ?? ''}`,
      );
    }
  }

  for (const symbol of input.symbols) {
    if (publicSymbolIds.has(symbol.symbolId)) continue;
    if (!symbol.isPublic) continue;
    if (symbol.nameChain.includes('.')) continue;
    if (symbol.kind === 'component' && symbol.nameChain.includes('.')) continue;
    const manual = manualAssignments.get(symbol.symbolId);
    if (manual?.exposure === 'public') continue;
    if (internalById.has(symbol.symbolId)) continue;
    internalById.set(
      symbol.symbolId,
      internalRecordOf(symbol, manual?.exposure === 'internal' ? ['manual-override'] : ['none']),
    );
  }

  // Deduplicate deprecated chains by symbolId; multiple conditions/subpaths for
  // the same declaration produce one migration record.
  const deprecatedChains = buildDeprecatedChains(
    publicEntries,
    input.symbols,
    tagsBySymbolFromGroups(groups),
  );
  const entries = publicEntries.sort(compareSurfaceEntries);
  const internal = [...internalById.values()].sort(compareInternal);
  const opaqueRecords = [...opaque.values()].sort(compareOpaque);
  const surfaceHash = `sh_${sha256Base32(
    stableStringify({
      rootId: input.rootId,
      entries: entries.map((entry) => ({
        name: entry.name,
        normalizedSignature: entry.normalizedSignature,
        kind: entry.kind,
        exportKind: entry.exportKind,
        isTypeOnly: entry.isTypeOnly,
        runtimePresent: entry.runtimePresent,
        entryPath: entry.entryPath,
        condition: entry.condition,
        evidenceSources: entry.evidenceSources,
        primaryEvidenceSource: entry.primaryEvidenceSource,
        derived: entry.derived,
        stability: entry.stability,
        symbolId: entry.symbolId,
        propsCoverage: entry.propsCoverage ?? null,
        unresolvedProps: entry.unresolvedProps ?? [],
      })),
    }),
    16,
  )}`;

  return {
    surfaceVersion: 1,
    rootId: input.rootId,
    rootPath: input.rootPath,
    packageName,
    buildId: input.buildId,
    buildFingerprint: input.buildFingerprint,
    packageVersion,
    surfaceHash,
    entries,
    internal,
    opaque: opaqueRecords,
    deprecated: deprecatedChains,
    warnings: [...new Set(warnings)].sort(),
  };
}

function internalRecordOf(
  symbol: SymbolRecord,
  evidence: SurfaceEvidenceSource[],
): SurfaceInternalRecord {
  return {
    name: symbol.name,
    normalizedSignature: normalizeSignature(symbol.signature),
    kind: kindOf([symbol]),
    exportKind: symbol.isTypeOnly ? 'type' : 'value',
    isTypeOnly: symbol.isTypeOnly,
    runtimePresent: !symbol.isTypeOnly,
    symbolId: symbol.symbolId,
    evidenceSources: sortedEvidence(evidence),
    primaryEvidenceSource: primaryEvidence(evidence),
  };
}

function tagsBySymbolFromGroups(groups: Map<string, EntryGroup>): Map<string, ExportTag[]> {
  const result = new Map<string, ExportTag[]>();
  for (const group of groups.values()) {
    const tags = tagsOf([group]);
    for (const symbol of group.symbols) result.set(symbol.symbolId, tags);
  }
  return result;
}

function buildDeprecatedChains(
  entries: readonly SurfaceEntry[],
  symbols: readonly SymbolRecord[],
  tagsBySymbol: ReadonlyMap<string, readonly ExportTag[]>,
): DeprecatedChain[] {
  const chains = new Map<string, DeprecatedChain>();
  for (const entry of entries) {
    const tags = tagsBySymbol.get(entry.symbolId) ?? [];
    const deprecatedTag = tagByNames(tags, ['deprecated']);
    if (deprecatedTag === null) continue;
    if (chains.has(entry.symbolId)) continue;
    const candidates: DeprecatedChain['candidates'] = [];
    for (const name of successorNames(tags)) {
      for (const symbol of symbols) {
        if (symbol.name !== name && symbol.nameChain !== name) continue;
        if (candidates.some((candidate) => candidate.symbolId === symbol.symbolId)) continue;
        candidates.push({
          symbolId: symbol.symbolId,
          name: symbol.name,
          nameChain: symbol.nameChain,
        });
      }
    }
    candidates.sort((left, right) =>
      left.nameChain < right.nameChain ? -1 : left.nameChain > right.nameChain ? 1 : 0,
    );
    const successor =
      candidates.length === 1 ? (candidates[0] as DeprecatedChain['candidates'][number]) : null;
    const status: DeprecatedChain['status'] =
      candidates.length === 0 ? 'no-successor' : candidates.length === 1 ? 'resolved' : 'ambiguous';
    const removalTag = tagByNames(tags, ['removal', 'removalversion']);
    const suggestion =
      status === 'resolved' && successor !== null
        ? `nex references ${entry.name} --include-heuristic && nex symbol ${successor.nameChain}`
        : `nex references ${entry.name} --include-heuristic`;
    chains.set(entry.symbolId, {
      symbolId: entry.symbolId,
      name: entry.name,
      successorId: successor?.symbolId ?? null,
      successorName: successor?.nameChain ?? null,
      candidates,
      status,
      reason: deprecatedTag.text.trim(),
      removalVersion: removalTag?.text.trim() ?? null,
      deprecatedAt: null,
      suggestion,
    });
  }
  return [...chains.values()].sort((left, right) =>
    left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0,
  );
}

function compareSurfaceEntries(left: SurfaceEntry, right: SurfaceEntry): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if ((left.entryPath ?? '') !== (right.entryPath ?? '')) {
    return (left.entryPath ?? '') < (right.entryPath ?? '') ? -1 : 1;
  }
  if ((left.condition ?? '') !== (right.condition ?? '')) {
    return (left.condition ?? '') < (right.condition ?? '') ? -1 : 1;
  }
  return left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0;
}

function compareInternal(left: SurfaceInternalRecord, right: SurfaceInternalRecord): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0;
}

function compareOpaque(left: SurfaceOpaqueRecord, right: SurfaceOpaqueRecord): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if ((left.entryPath ?? '') !== (right.entryPath ?? '')) {
    return (left.entryPath ?? '') < (right.entryPath ?? '') ? -1 : 1;
  }
  if ((left.condition ?? '') !== (right.condition ?? '')) {
    return (left.condition ?? '') < (right.condition ?? '') ? -1 : 1;
  }
  return 0;
}
