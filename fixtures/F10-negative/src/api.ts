export function neverReferenced(): string {
  return 'never';
}

export function referencedOnce(): string {
  return 'once';
}

export function stringNamed(): string {
  return 'string';
}

export function typeOnlyUsed(value: string): string {
  return value;
}

export const dynamicTarget = 42;

export interface OnlyType {
  value: string;
}
