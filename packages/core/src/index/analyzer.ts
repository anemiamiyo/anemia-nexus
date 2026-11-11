import ts from 'typescript';

export const SCIP_VERSION = '0.4.0';

/**
 * Analyzer version tuple written into the build fingerprint
 * (docs/05-data-model.md 5.11). Unused engines are `null`, not omitted, so the
 * tuple shape is stable across phases.
 */
export const ANALYZER_VERSION = {
  scip: SCIP_VERSION,
  typescript: ts.version,
  vueLanguageCore: null,
  vueTsc: null,
  tsMorph: null,
} as const;
