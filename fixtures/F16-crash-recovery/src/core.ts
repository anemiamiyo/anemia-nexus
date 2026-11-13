export interface Payload {
  id: string;
  value: number;
}

export function normalize(payload: Payload): Payload {
  return { id: payload.id.trim().toLowerCase(), value: Math.max(0, payload.value) };
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
