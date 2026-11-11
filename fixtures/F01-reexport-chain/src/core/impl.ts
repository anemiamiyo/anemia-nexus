export interface CounterOptions {
  start: number;
}

export class Counter {
  private value: number;

  constructor(options: CounterOptions) {
    this.value = options.start;
  }

  increment(): number {
    this.value += 1;
    return this.value;
  }
}

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export const VERSION = '1.0.0';

export type Operation = 'add' | 'multiply';

export default function describe(): string {
  return 'core';
}
