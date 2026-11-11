import { sha256Base32, sha256Hex } from '../util/hash.js';

export type SymbolKind =
  'fn' | 'class' | 'var' | 'interface' | 'type' | 'enum' | 'ns' | 'component' | 'composable';

export interface SymbolIdInput {
  rootId: string;
  kind: SymbolKind;
  nameChain: string;
  structuralFingerprint: string;
}

/** `symbolId = "s_" + base32(sha256(canonical))[0..16]` (docs/05-data-model.md 5.2.2). */
export function computeSymbolId(input: SymbolIdInput): string {
  const canonical = [input.rootId, input.kind, input.nameChain, input.structuralFingerprint].join(
    '\u0000',
  );
  return `s_${sha256Base32(canonical, 16)}`;
}

/** Position-anchored identity for anonymous declarations; always volatile. */
export function computeAnonymousSymbolId(input: {
  rootId: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  startCol: number;
  syntaxContextHash: string;
}): string {
  const canonical = [
    'anonymous',
    input.rootId,
    input.kind,
    input.path,
    String(input.startLine),
    String(input.startCol),
    input.syntaxContextHash,
  ].join('\u0000');
  return `s_${sha256Base32(canonical, 16)}`;
}

/** Collision suffix is the only permitted path dependency (5.2.2 rule 2). */
export function collisionSuffix(locatorKey: string): string {
  return `#${sha256Hex(locatorKey).slice(0, 7)}`;
}
