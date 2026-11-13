import type { SymbolRecord } from '../model.js';
import type { ReadStore } from '../store/read.js';
import { searchSymbols } from '../store/read.js';

/**
 * Deterministic similarity rules from docs/09-reuse-detection.md 9.1.1.
 * No embedding, no model, no network: every component score is explainable.
 * Similarity is always heuristic (`isHeuristic: true`) and never "equivalence".
 */
export const SIMILARITY_RULES_VERSION = '9.1.1';

export interface SignatureParts {
  parameters: Array<{ name: string; typeText: string; optional: boolean }>;
  returnType: string;
  async: boolean;
}

export interface SimilarityBreakdown {
  nameScore: number;
  nameStems: string[];
  paramCountDelta: number;
  paramCountScore: number;
  paramTypeMatches: boolean[];
  paramTypeScore: number;
  returnTypeMatch: boolean;
  returnTypeScore: number;
  sameModule: boolean;
  sameDir: boolean;
  moduleScore: number;
  surfaceScope: 'same' | 'different';
  surfaceScore: number;
  structuralTags: string[];
  structuralScore: number;
}

export interface SimilarityCandidate {
  candidate: { name: string; symbolId: string; kind: string };
  score: number;
  scoreBreakdown: SimilarityBreakdown;
  rulesVersion: string;
  isHeuristic: true;
  matchBasis: string[];
  suggestion: 'reuse' | 'extend' | 'new';
  location: { path: string; line: number; col: number; rootId: string; module: string | null };
}

const SYNONYMS: Readonly<Record<string, string>> = {
  get: 'fetch',
  fetch: 'fetch',
  load: 'fetch',
  read: 'fetch',
  create: 'make',
  make: 'make',
  build: 'make',
  construct: 'make',
  remove: 'delete',
  delete: 'delete',
  destroy: 'delete',
  update: 'set',
  set: 'set',
  write: 'set',
  list: 'all',
  all: 'all',
  find: 'search',
  search: 'search',
  query: 'search',
  open: 'show',
  show: 'show',
  use: 'use',
};

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'when',
  'then',
  'should',
  'must',
  'need',
  'add',
  'new',
  'api',
  'code',
  'file',
  'task',
  'change',
  'using',
  'make',
]);

export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function stem(word: string): string {
  const mapped = SYNONYMS[word] ?? word;
  if (mapped.length > 4 && mapped.endsWith('ing')) return mapped.slice(0, -3);
  if (mapped.length > 3 && mapped.endsWith('ed')) return mapped.slice(0, -2);
  if (mapped.length > 3 && mapped.endsWith('s')) return mapped.slice(0, -1);
  return mapped;
}

function nameScore(
  target: SymbolRecord,
  candidate: SymbolRecord,
): { score: number; stems: string[] } {
  const targetTokens = splitIdentifier(target.name).map(stem);
  const candidateTokens = splitIdentifier(candidate.name).map(stem);
  const targetSet = new Set(targetTokens);
  const candidateSet = new Set(candidateTokens);
  const intersection = [...targetSet].filter((token) => candidateSet.has(token));
  const union = new Set([...targetSet, ...candidateSet]);
  const jaccard = union.size === 0 ? 0 : intersection.length / union.size;
  const distance = editDistance(target.name.toLowerCase(), candidate.name.toLowerCase());
  const maxLength = Math.max(target.name.length, candidate.name.length, 1);
  const editScore = 1 - distance / maxLength;
  return {
    score: Math.max(0, Math.min(1, 0.6 * jaccard + 0.4 * Math.max(0, editScore))),
    stems: intersection,
  };
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const rows = left.length + 1;
  const cols = right.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let col = 1; col < cols; col += 1) {
      const substitution = (previous[col - 1] ?? 0) + (left[row - 1] === right[col - 1] ? 0 : 1);
      current[col] = Math.min((previous[col] ?? 0) + 1, (current[col - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[cols - 1] ?? Math.max(left.length, right.length);
}

export function parseSignature(signature: string): SignatureParts {
  const open = signature.indexOf('(');
  if (open === -1) return { parameters: [], returnType: '', async: signature.includes('async ') };
  let depth = 0;
  let close = -1;
  for (let index = open; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return { parameters: [], returnType: '', async: signature.includes('async ') };
  const body = signature.slice(open + 1, close).trim();
  const parameters: SignatureParts['parameters'] = [];
  if (body !== '') {
    let current = '';
    let nesting = 0;
    const push = (): void => {
      const text = current.trim();
      current = '';
      if (text === '') return;
      const optional = text.includes('?') || text.includes('=') || text.startsWith('...');
      const [head, ...rest] = text.split(':');
      parameters.push({
        name: (head ?? '')
          .replace(/[?=]/g, '')
          .replace(/^\.\.\./, '')
          .trim(),
        typeText: rest.join(':').replace(/=.+$/, '').trim(),
        optional,
      });
    };
    for (const char of body) {
      if (char === '(' || char === '<' || char === '[' || char === '{') nesting += 1;
      if (char === ')' || char === '>' || char === ']' || char === '}') nesting -= 1;
      if (char === ',' && nesting === 0) {
        push();
        continue;
      }
      current += char;
    }
    push();
  }
  const tail = signature.slice(close + 1).trim();
  const arrow = tail.indexOf('=>');
  const colon = tail.indexOf(':');
  const returnType =
    arrow >= 0 ? tail.slice(arrow + 2).trim() : colon >= 0 ? tail.slice(colon + 1).trim() : '';
  return { parameters, returnType, async: signature.includes('async ') };
}

export function normalizeType(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*([<>{}[\]|&:,])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

export interface SimilarityContext {
  rootId: string;
  moduleOf: (path: string) => string | null;
  listCandidates: (terms: readonly string[]) => SymbolRecord[];
}

export function scoreCandidate(
  target: SymbolRecord,
  candidate: SymbolRecord,
  targetModule: string | null,
  candidateModule: string | null,
): SimilarityCandidate {
  const name = nameScore(target, candidate);
  const targetSignature = parseSignature(target.signature);
  const candidateSignature = parseSignature(candidate.signature);
  const paramDelta = Math.abs(
    targetSignature.parameters.length - candidateSignature.parameters.length,
  );
  const paramCountScore = paramDelta === 0 ? 1 : paramDelta === 1 ? 0.5 : 0;
  const pairCount = Math.min(
    targetSignature.parameters.length,
    candidateSignature.parameters.length,
  );
  const paramTypeMatches = Array.from(
    { length: pairCount },
    (_, index) =>
      normalizeType(targetSignature.parameters[index]?.typeText ?? '') ===
      normalizeType(candidateSignature.parameters[index]?.typeText ?? ''),
  );
  const paramTypeScore =
    pairCount === 0
      ? 1
      : paramTypeMatches.filter(Boolean).length /
        Math.max(targetSignature.parameters.length, candidateSignature.parameters.length);
  const returnTypeMatch =
    normalizeType(targetSignature.returnType) === normalizeType(candidateSignature.returnType);
  const sameDir = target.path.includes('/')
    ? target.path.slice(0, target.path.lastIndexOf('/')) ===
      candidate.path.slice(0, candidate.path.lastIndexOf('/'))
    : false;
  const sameModule = targetModule !== null && targetModule === candidateModule;
  const moduleScore = sameModule ? 1 : sameDir ? 0.5 : 0;
  const surfaceScore = target.isPublic === candidate.isPublic ? 1 : 0;
  const tags: string[] = [];
  if (/^use[A-Z]/.test(candidate.name)) tags.push('hook');
  if (candidate.kind === 'component') tags.push('component');
  if (candidateSignature.async) tags.push('async');
  const structuralScore = tags.length > 0 ? Math.min(1, tags.length / 2) : 0;
  const score =
    0.3 * name.score +
    0.15 * paramCountScore +
    0.2 * paramTypeScore +
    0.15 * (returnTypeMatch ? 1 : 0) +
    0.1 * moduleScore +
    0.05 * surfaceScore +
    0.05 * structuralScore;
  const matchBasis: string[] = [];
  if (name.score > 0) matchBasis.push('name-stem');
  if (paramCountScore > 0) matchBasis.push('param-count');
  if (paramTypeMatches.some(Boolean)) matchBasis.push('param-types');
  if (returnTypeMatch) matchBasis.push('return-type');
  if (moduleScore > 0) matchBasis.push(sameModule ? 'same-module' : 'same-dir');
  if (surfaceScore > 0) matchBasis.push('surface-scope');
  if (tags.length > 0) matchBasis.push('structure');
  const rounded = Math.round(score * 100) / 100;
  return {
    candidate: { name: candidate.name, symbolId: candidate.symbolId, kind: candidate.kind },
    score: rounded,
    scoreBreakdown: {
      nameScore: round(name.score),
      nameStems: name.stems,
      paramCountDelta: paramDelta,
      paramCountScore,
      paramTypeMatches,
      paramTypeScore: round(paramTypeScore),
      returnTypeMatch,
      returnTypeScore: returnTypeMatch ? 1 : 0,
      sameModule,
      sameDir,
      moduleScore,
      surfaceScope: target.isPublic === candidate.isPublic ? 'same' : 'different',
      surfaceScore,
      structuralTags: tags,
      structuralScore,
    },
    rulesVersion: SIMILARITY_RULES_VERSION,
    isHeuristic: true,
    matchBasis,
    suggestion: rounded >= 0.8 ? 'reuse' : rounded >= 0.55 ? 'extend' : 'new',
    location: {
      path: candidate.path,
      line: candidate.declarationLocator.startLine,
      col: candidate.declarationLocator.startCol,
      rootId: candidate.rootId,
      module: candidateModule,
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function findSimilar(
  store: ReadStore,
  context: SimilarityContext,
  target: SymbolRecord,
  options: { top?: number; scope?: 'public' | 'all'; terms?: readonly string[] } = {},
): SimilarityCandidate[] {
  const tokens = options.terms ?? splitIdentifier(target.name);
  const candidates = context
    .listCandidates(tokens)
    .filter((candidate) => candidate.symbolId !== target.symbolId);
  const targetModule = context.moduleOf(target.path);
  const scored: SimilarityCandidate[] = [];
  for (const candidate of candidates) {
    if (options.scope === 'public' && !candidate.isPublic) continue;
    const module = context.moduleOf(candidate.path);
    const result = scoreCandidate(target, candidate, targetModule, module);
    if (result.score < 0.55) continue;
    scored.push(result);
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.name.localeCompare(right.candidate.name) ||
      left.location.path.localeCompare(right.location.path) ||
      left.candidate.symbolId.localeCompare(right.candidate.symbolId),
  );
  return scored.slice(0, Math.min(Math.max(options.top ?? 10, 1), 50));
}

export interface ExtractedNames {
  attempted: boolean;
  failed: boolean;
  terms: string[];
  message: string;
}

/** Explainable keyword extraction; no model. */
export function extractSymbolNames(
  task: string | null,
  lookup: (term: string) => SymbolRecord[],
): { names: ExtractedNames; symbols: SymbolRecord[] } {
  if (task === null || task.trim() === '') {
    return {
      names: { attempted: false, failed: true, terms: [], message: 'no task text was provided' },
      symbols: [],
    };
  }
  const rawTokens = task.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const tokens = [...new Set(rawTokens)]
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token.toLowerCase()))
    .slice(0, 40);
  const symbols = new Map<string, SymbolRecord>();
  for (const token of tokens) {
    for (const symbol of lookup(token)) symbols.set(symbol.symbolId, symbol);
    if (symbols.size >= 20) break;
  }
  return {
    names: {
      attempted: true,
      failed: symbols.size === 0,
      terms: tokens,
      message:
        symbols.size === 0
          ? 'could not extract a symbol name from the task description; provide a target symbol'
          : `extracted ${symbols.size} candidate symbol(s) from ${tokens.length} token(s)`,
    },
    symbols: [...symbols.values()],
  };
}

export function defaultCandidateLister(
  store: ReadStore,
): (terms: readonly string[]) => SymbolRecord[] {
  return (terms) => {
    const found = new Map<string, SymbolRecord>();
    for (const term of terms.length === 0 ? [''] : terms) {
      for (const symbol of searchSymbols(store, { name: term, limit: 200 })) {
        found.set(symbol.symbolId, symbol);
      }
    }
    return [...found.values()].sort((left, right) => left.symbolId.localeCompare(right.symbolId));
  };
}
