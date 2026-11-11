import { createHash } from 'node:crypto';

import { base32Encode } from './base32.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Base32(text: string, length: number): string {
  return base32Encode(createHash('sha256').update(text, 'utf8').digest()).slice(0, length);
}

/** Hash of file content after LF normalization (docs/05-data-model.md 5.4). */
export function normalizeText(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export function contentHash(text: string): string {
  return sha256Hex(normalizeText(text));
}
