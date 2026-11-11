import { DatabaseSync } from 'node:sqlite';

import type { IdentityConfidence, SymbolRecord } from '../model.js';

export interface ActiveHistoryRow {
  symbolId: string;
  confidence: IdentityConfidence;
  evidenceJson: string;
  locatorJson: string;
  validFromBuild: string;
}

export function readActiveHistory(db: DatabaseSync): Map<string, ActiveHistoryRow> {
  const map = new Map<string, ActiveHistoryRow>();
  const rows = db
    .prepare(
      "select symbol_id as symbolId, confidence, evidence_json as evidenceJson, locator_json as locatorJson, valid_from_build as validFromBuild from symbol_id_history where status = 'active'",
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const symbolId = typeof row.symbolId === 'string' ? row.symbolId : '';
    if (symbolId === '') continue;
    map.set(symbolId, {
      symbolId,
      confidence: (typeof row.confidence === 'string'
        ? row.confidence
        : 'high') as IdentityConfidence,
      evidenceJson: typeof row.evidenceJson === 'string' ? row.evidenceJson : '[]',
      locatorJson: typeof row.locatorJson === 'string' ? row.locatorJson : '{}',
      validFromBuild: typeof row.validFromBuild === 'string' ? row.validFromBuild : '',
    });
  }
  return map;
}

/**
 * History maintenance for one build. Active rows that survive stay active;
 * missing identities are retired (never reused); new identities get an
 * `active` row with the evidence produced by identity assignment.
 */
export function applyHistory(
  db: DatabaseSync,
  symbols: readonly SymbolRecord[],
  fingerprint: string,
): void {
  const active = readActiveHistory(db);
  const nextIds = new Set(symbols.map((symbol) => symbol.symbolId));

  const retire = db.prepare(
    "update symbol_id_history set status = 'retired', valid_to_build = ? where symbol_id = ? and status = 'active'",
  );
  for (const symbolId of active.keys()) {
    if (!nextIds.has(symbolId)) retire.run(fingerprint, symbolId);
  }

  const insert = db.prepare(
    "insert or ignore into symbol_id_history(symbol_id, valid_from_build, valid_to_build, locator_json, confidence, evidence_json, status, successor_id) values (?, ?, null, ?, ?, ?, 'active', null)",
  );
  for (const symbol of symbols) {
    if (active.has(symbol.symbolId)) continue;
    insert.run(
      symbol.symbolId,
      fingerprint,
      JSON.stringify(symbol.declarationLocator),
      symbol.identityConfidence,
      JSON.stringify(symbol.identityEvidence),
    );
  }
}

export interface HistoryRow {
  symbolId: string;
  validFromBuild: string;
  validToBuild: string | null;
  locator: unknown;
  confidence: string;
  evidence: unknown;
  status: string;
  successorId: string | null;
}

export function readHistory(db: DatabaseSync, symbolId: string): HistoryRow[] {
  const rows = db
    .prepare(
      'select symbol_id as symbolId, valid_from_build as validFromBuild, valid_to_build as validToBuild, locator_json as locatorJson, confidence, evidence_json as evidenceJson, status, successor_id as successorId from symbol_id_history where symbol_id = ? order by valid_from_build desc',
    )
    .all(symbolId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    symbolId: typeof row.symbolId === 'string' ? row.symbolId : '',
    validFromBuild: typeof row.validFromBuild === 'string' ? row.validFromBuild : '',
    validToBuild: typeof row.validToBuild === 'string' ? row.validToBuild : null,
    locator: parseJson(row.locatorJson),
    confidence: typeof row.confidence === 'string' ? row.confidence : '',
    evidence: parseJson(row.evidenceJson),
    status: typeof row.status === 'string' ? row.status : '',
    successorId: typeof row.successorId === 'string' ? row.successorId : null,
  }));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
