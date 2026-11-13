import { normalize, sum } from './core';

export function checkNormalize(): boolean {
  return normalize({ id: 'X', value: -1 }).value === 0;
}

export function checkSum(): boolean {
  return sum([1, 2, 3]) === 6;
}
