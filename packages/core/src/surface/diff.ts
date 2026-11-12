import { sha256Base32 } from '../util/hash.js';
import { stableStringify } from '../util/stable-json.js';
import type {
  SurfaceBaseline,
  SurfaceDiff,
  SurfaceDiffItem,
  SurfaceDiffSeverity,
  SurfaceEntry,
  SurfaceEvidenceSource,
  SurfaceInternalRecord,
  SurfaceSnapshot,
} from './types.js';

function evidenceRank(value: SurfaceEvidenceSource): number {
  switch (value) {
    case 'manual-override':
      return 0;
    case 'package-exports':
      return 1;
    case 'explicit-entry':
      return 2;
    case 'barrel-derived':
      return 3;
    default:
      return 4;
  }
}

function keyOf(entry: {
  name: string;
  entryPath: string | null;
  condition: string | null;
}): string {
  return `${entry.name}\u0000${entry.entryPath ?? ''}\u0000${entry.condition ?? ''}`;
}

function itemId(rootId: string, key: string, code: string): string {
  return `sd_${sha256Base32(stableStringify({ rootId, key, code }), 12)}`;
}

function baseItem(input: {
  severity: SurfaceDiffSeverity;
  code: string;
  rootId: string;
  key: string;
  before: SurfaceEntry | SurfaceInternalRecord | null;
  after: SurfaceEntry | SurfaceInternalRecord | null;
  rationale: string;
}): SurfaceDiffItem {
  const reference = input.after ?? input.before;
  const publicReference = reference as SurfaceEntry | null;
  const entryPath = publicReference?.entryPath ?? null;
  const condition = publicReference?.condition ?? null;
  const beforeEvidence =
    input.before !== null && 'evidenceSources' in input.before ? input.before.evidenceSources : [];
  const afterEvidence =
    input.after !== null && 'evidenceSources' in input.after ? input.after.evidenceSources : [];
  return {
    id: itemId(input.rootId, input.key, input.code),
    severity: input.severity,
    code: input.code,
    rootId: input.rootId,
    name: reference?.name ?? '',
    entryPath,
    condition,
    before: input.before,
    after: input.after,
    evidence: {
      beforeEvidenceSources: beforeEvidence,
      afterEvidenceSources: afterEvidence,
      beforeExportKind:
        input.before !== null && 'exportKind' in input.before ? input.before.exportKind : null,
      afterExportKind:
        input.after !== null && 'exportKind' in input.after ? input.after.exportKind : null,
      symbolId: reference?.symbolId ?? null,
    },
    rationale: input.rationale,
  };
}

function paramStats(signature: string): { count: number; required: number } | null {
  const open = signature.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < signature.length; index += 1) {
    const character = signature[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return null;
  const body = signature.slice(open + 1, close).trim();
  if (body === '') return { count: 0, required: 0 };
  const params: string[] = [];
  let current = '';
  let nesting = 0;
  for (const character of body) {
    if (character === '(' || character === '<' || character === '[' || character === '{')
      nesting += 1;
    if (character === ')' || character === '>' || character === ']' || character === '}')
      nesting -= 1;
    if (character === ',' && nesting === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') params.push(current.trim());
  const required = params.filter(
    (param) => !param.includes('?') && !param.includes('=') && !param.startsWith('...'),
  ).length;
  return { count: params.length, required };
}

function signatureChange(before: SurfaceEntry, after: SurfaceEntry): SurfaceDiffItem['severity'] {
  if (before.normalizedSignature === after.normalizedSignature) return 'internal';
  const beforeParams = paramStats(before.normalizedSignature);
  const afterParams = paramStats(after.normalizedSignature);
  if (beforeParams !== null && afterParams !== null) {
    if (afterParams.required > beforeParams.required) return 'breaking';
    if (afterParams.count > beforeParams.count && afterParams.required === beforeParams.required) {
      return 'additive';
    }
  }
  return 'ambiguous';
}

function comparePublic(
  before: SurfaceEntry,
  after: SurfaceEntry,
): {
  severity: SurfaceDiffSeverity;
  code: string;
  rationale: string;
} | null {
  if (before.normalizedSignature !== after.normalizedSignature) {
    const severity = signatureChange(before, after);
    return {
      severity,
      code:
        severity === 'breaking'
          ? 'signature-narrowed'
          : severity === 'additive'
            ? 'signature-widened'
            : 'signature-changed',
      rationale:
        severity === 'breaking'
          ? 'a required parameter was added or the exported shape became narrower'
          : severity === 'additive'
            ? 'an optional parameter or overload was added'
            : 'the normalized signatures differ but cannot be ordered safely; human review is required',
    };
  }
  if (before.exportKind !== after.exportKind) {
    if (before.exportKind === 'type' && after.exportKind !== 'type') {
      return {
        severity: 'breaking',
        code: 'type-export-removed',
        rationale: 'the entry was a pure type export and now exposes only runtime values',
      };
    }
    if (before.exportKind !== 'type' && after.exportKind === 'type') {
      return {
        severity: 'breaking',
        code: 'runtime-export-removed',
        rationale: 'the runtime export disappeared and only a type export remains',
      };
    }
    if (before.exportKind === 'both' && after.exportKind === 'value') {
      return {
        severity: 'breaking',
        code: 'type-level-export-removed',
        rationale: 'the type-level half of a both-kind export was removed',
      };
    }
    return {
      severity: 'additive',
      code: 'export-kind-widened',
      rationale: 'the export now covers an additional type/runtime dimension',
    };
  }
  const beforeRank = evidenceRank(before.primaryEvidenceSource);
  const afterRank = evidenceRank(after.primaryEvidenceSource);
  if (afterRank < beforeRank) {
    return {
      severity: 'additive',
      code: 'evidence-upgraded',
      rationale: `exposure evidence strengthened from ${before.primaryEvidenceSource} to ${after.primaryEvidenceSource}`,
    };
  }
  if (afterRank > beforeRank) {
    return {
      severity: 'ambiguous',
      code: 'evidence-downgraded',
      rationale: `exposure evidence weakened from ${before.primaryEvidenceSource} to ${after.primaryEvidenceSource}; confirm external consumers manually`,
    };
  }
  if (before.stability !== after.stability) {
    return {
      severity: 'ambiguous',
      code: 'stability-changed',
      rationale: `stability changed from ${before.stability} to ${after.stability}`,
    };
  }
  const beforeProps = before.propsCoverage;
  const afterProps = after.propsCoverage;
  if (beforeProps !== undefined && afterProps !== undefined) {
    if (afterProps.total < beforeProps.total) {
      return {
        severity: 'breaking',
        code: 'props-removed',
        rationale: 'component props were removed or became unresolvable',
      };
    }
    if (afterProps.total > beforeProps.total) {
      return {
        severity: 'additive',
        code: 'props-added',
        rationale: 'component props were added',
      };
    }
  }
  return null;
}

function compareInternal(
  before: SurfaceInternalRecord,
  after: SurfaceInternalRecord,
): SurfaceDiffItem['severity'] {
  if (before.normalizedSignature !== after.normalizedSignature) return 'internal';
  if (before.exportKind !== after.exportKind) return 'internal';
  return 'internal';
}

export function diffSnapshots(current: SurfaceSnapshot, baseline: SurfaceBaseline): SurfaceDiff {
  const items: SurfaceDiffItem[] = [];
  const rootIds = [
    ...new Set([...Object.keys(current.roots), ...Object.keys(baseline.roots)]),
  ].sort();

  for (const rootId of rootIds) {
    const currentRoot = current.roots[rootId];
    const baselineRoot = baseline.roots[rootId];
    if (currentRoot === undefined || baselineRoot === undefined) {
      const exists = currentRoot ?? baselineRoot;
      if (exists === undefined) continue;
      for (const entry of currentRoot?.entries ?? baselineRoot?.entries ?? []) {
        items.push(
          baseItem({
            severity: currentRoot === undefined ? 'breaking' : 'additive',
            code: currentRoot === undefined ? 'root-removed' : 'root-added',
            rootId,
            key: keyOf(entry),
            before: currentRoot === undefined ? entry : null,
            after: currentRoot === undefined ? null : entry,
            rationale:
              currentRoot === undefined
                ? `root ${rootId} disappeared from the current surface`
                : `root ${rootId} is new in the current surface`,
          }),
        );
      }
      continue;
    }

    const beforeMap = new Map(baselineRoot.entries.map((entry) => [keyOf(entry), entry]));
    const afterMap = new Map(currentRoot.entries.map((entry) => [keyOf(entry), entry]));
    const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
    for (const key of keys) {
      const before = beforeMap.get(key) ?? null;
      const after = afterMap.get(key) ?? null;
      if (before === null && after !== null) {
        items.push(
          baseItem({
            severity: 'additive',
            code: 'surface-added',
            rootId,
            key,
            before: null,
            after,
            rationale: 'a new public export entered the Surface',
          }),
        );
        continue;
      }
      if (before !== null && after === null) {
        items.push(
          baseItem({
            severity: 'breaking',
            code: 'surface-removed',
            rootId,
            key,
            before,
            after: null,
            rationale: before.isTypeOnly
              ? 'a pure type export was removed; TypeScript consumers break at the type level'
              : 'a public export was removed or renamed',
          }),
        );
        continue;
      }
      if (before === null || after === null) continue;
      const change = comparePublic(before, after);
      if (change !== null) {
        items.push(
          baseItem({
            severity: change.severity,
            code: change.code,
            rootId,
            key,
            before,
            after,
            rationale: change.rationale,
          }),
        );
      }
    }

    const beforeInternal = new Map(
      baselineRoot.internal.map((entry) => [`${entry.name}\u0000${entry.symbolId}`, entry]),
    );
    const afterInternal = new Map(
      currentRoot.internal.map((entry) => [`${entry.name}\u0000${entry.symbolId}`, entry]),
    );
    const internalKeys = [...new Set([...beforeInternal.keys(), ...afterInternal.keys()])].sort();
    for (const key of internalKeys) {
      const before = beforeInternal.get(key) ?? null;
      const after = afterInternal.get(key) ?? null;
      if (before !== null && after !== null) {
        if (compareInternal(before, after) === 'internal') {
          if (
            before.normalizedSignature !== after.normalizedSignature ||
            before.exportKind !== after.exportKind
          ) {
            items.push(
              baseItem({
                severity: 'internal',
                code: 'internal-changed',
                rootId,
                key,
                before,
                after,
                rationale: 'only the internal layer changed; no public Surface entry was affected',
              }),
            );
          }
        }
        continue;
      }
      items.push(
        baseItem({
          severity: 'internal',
          code: before === null ? 'internal-added' : 'internal-removed',
          rootId,
          key,
          before,
          after,
          rationale: 'internal symbol set changed; public Surface is unaffected',
        }),
      );
    }
  }

  items.sort((left, right) => {
    if (left.rootId !== right.rootId) return left.rootId < right.rootId ? -1 : 1;
    if (left.severity !== right.severity) return left.severity < right.severity ? -1 : 1;
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  return {
    command: 'api-diff',
    base: '',
    buildFingerprint: current.roots[Object.keys(current.roots)[0] ?? '']?.buildFingerprint ?? null,
    counts: {
      total: items.length,
      breaking: items.filter((item) => item.severity === 'breaking').length,
      additive: items.filter((item) => item.severity === 'additive').length,
      internal: items.filter((item) => item.severity === 'internal').length,
      ambiguous: items.filter((item) => item.severity === 'ambiguous').length,
    },
    surfaceHash: current.surfaceHash,
    baselineSurfaceHash: baseline.surfaceHash,
    items,
    warnings: [],
    notes: [],
  };
}
