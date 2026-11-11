// T06: function overloads; each overload has its own ordinal.
export function pick(x: string): string;
export function pick(x: number): number;
export function pick(x: string | number): string | number {
  return x;
}

export const pickedString = pick('a');
export const pickedNumber = pick(1);
