/**
 * Command whitelist validation (docs/18-security.md 18.4.1). Only complete
 * command + args records are accepted; destructive and remote-execution
 * commands are rejected outright. No shell is ever used.
 */
const DESTRUCTIVE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'mkfs',
  'shutdown',
  'reboot',
  'sudo',
  'su',
  'doas',
  'curl',
  'wget',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'zsh',
  'fish',
  'cscript',
  'wscript',
]);

const SHELL_META = /[|&;<>`$(){}[\]]/;

export function isDangerousCommand(cmd: string, args: readonly string[]): boolean {
  const base = cmd
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|sh)$/i, '');
  if (base === undefined) return true;
  if (DESTRUCTIVE_COMMANDS.has(base)) return true;
  if (base === 'git') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'reset' || sub === 'clean' || sub === 'checkout') return true;
  }
  for (const arg of args) {
    if (SHELL_META.test(arg)) return true;
  }
  return SHELL_META.test(cmd);
}
