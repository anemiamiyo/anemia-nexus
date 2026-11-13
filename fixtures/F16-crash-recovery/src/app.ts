import { createReport } from './api';
import { normalize } from './core';

export function run(): number {
  const first = normalize({ id: ' A ', value: -3 });
  const second = normalize({ id: 'b', value: 5 });
  return createReport([first, second]).total;
}
