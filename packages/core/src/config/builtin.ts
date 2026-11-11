/**
 * Built-in ignore baseline (docs/12-indexing.md 12.5). The baseline can only
 * be extended by configuration, never deleted or cleared.
 */
export const BUILTIN_IGNORE_DIRS: readonly string[] = [
  '.git',
  '.dsh',
  '.agent',
  '.turbo',
  '.cache',
  '.next',
  '.nexus',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
];

export const BUILTIN_IGNORE_FILES: readonly string[] = [
  '*.min.css',
  '*.map',
  '*.snap',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

export const BUILTIN_IGNORE_GLOBS: readonly string[] = ['**/generated/**'];

/**
 * Files that are never read, even if they match an extension we index
 * (docs/18-security.md 18.1, checklist J02). Extensions we index are TS/TSX,
 * so this list is a defence-in-depth guard for future formats.
 */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(?:$|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /credentials/i,
  /secret/i,
];

export function isSensitiveFile(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}
