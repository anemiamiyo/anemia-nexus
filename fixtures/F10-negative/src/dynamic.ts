import { referencedOnce } from './api';

const name = 'neverReferenced';
const api = { referencedOnce };

export function viaBracket(): unknown {
  return (api as Record<string, unknown>)[name];
}

export function viaDynamicImport(): Promise<unknown> {
  return import('./api');
}
