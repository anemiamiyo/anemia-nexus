export { add, Both, Counter, overload } from './math';
export type { Numeric } from './math';
export { default as legacyAdd } from './legacy-add';
export { format } from './utils';

/**
 * @deprecated Use {@link add} instead.
 */
export function oldAdd(a: number, b: number): number {
  return a + b;
}

/**
 * @deprecated No replacement is planned; removed in 2.0.0.
 * @removal 2.0.0
 */
export function doomed(): void {
  // intentionally empty
}

export const version = '1.2.0';
