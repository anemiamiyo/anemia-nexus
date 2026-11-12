import ts from 'typescript';

export const SCIP_VERSION = '0.4.0';

/**
 * Vue toolchain versions are locked as a family (docs/04-architecture.md
 * 4.1.6). They are repeated here as constants so the fingerprint does not
 * depend on reading node_modules at runtime; `vue.test.ts` asserts they match
 * the installed packages.
 */
export const VUE_LANGUAGE_CORE_VERSION = '3.3.14';
export const VUE_TSC_VERSION = '3.3.14';
export const VUE_COMPILER_SFC_VERSION = '3.5.45';

/** Version of the SFC projector implementation (docs/04-architecture.md 4.1.1). */
export const VUE_PROJECTOR_VERSION = 'vue-projector@1';

/**
 * Analyzer version tuple written into the build fingerprint
 * (docs/05-data-model.md 5.11). Unused engines are `null`, not omitted, so the
 * tuple shape is stable across phases.
 */
export const ANALYZER_VERSION = {
  scip: SCIP_VERSION,
  typescript: ts.version,
  vueLanguageCore: VUE_LANGUAGE_CORE_VERSION,
  vueTsc: VUE_TSC_VERSION,
  tsMorph: null,
} as const;
