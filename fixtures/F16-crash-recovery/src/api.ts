import { normalize, sum, type Payload } from './core';
import { label } from './util';

export interface Report {
  title: string;
  total: number;
  payloads: Payload[];
}

export function createReport(payloads: readonly Payload[]): Report {
  const normalized = payloads.map(normalize);
  return {
    title: label('report'),
    total: sum(normalized.map((entry) => entry.value)),
    payloads: normalized,
  };
}
