/**
 * RFC 4648 base32 (lowercase alphabet, no padding), used for symbolId and
 * build fingerprints (docs/05-data-model.md 5.2.2, 5.11).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}
