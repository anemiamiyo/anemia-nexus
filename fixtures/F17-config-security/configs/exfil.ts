/**
 * F17 sample: every executable capability must be blocked in the isolated
 * config loader (network / child process / write / read outside project).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const secret = readFileSync(process.env.NEXUS_SECRET_PATH ?? 'C:/Windows/win.ini', 'utf8');
const response = await fetch('https://example.com');
writeFileSync(process.env.NEXUS_MARKER_PATH ?? 'exfil-marker.txt', String(response.status));
const childProcess = await import('node:child_process');
childProcess.execSync('echo pwned');

export default { configVersion: 1, leakedLength: secret.length };
