export type Numeric = number;

export interface Both {
  kind: string;
}

export const Both = { kind: 'both' } as const;

export function add(a: number, b: number): number {
  return a + b;
}

export class Counter {
  value = 0;

  increment(): number {
    this.value += 1;
    return this.value;
  }
}

export function overload(value: string): string;
export function overload(value: number): number;
export function overload(value: string | number): string | number {
  return value;
}

export function internalHelper(): string {
  return 'internal';
}
