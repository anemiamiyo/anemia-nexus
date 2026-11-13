import path from 'node:path';

import type { CommandConfig } from './schema.js';

/**
 * Command whitelist safety (docs/18-security.md 18.4.1). This is deliberately
 * conservative and pure: it is used by the Zod config schema (E17) and again by
 * the verify executor right before spawn (defence in depth).
 */
const DANGEROUS_COMMANDS = new Set([
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
  'dd',
  'chmod',
  'chown',
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'powershell',
  'pwsh',
  'sh',
  'bash',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'eval',
]);

const SHELL_META = /[;&|<>`\n\r]/;

function baseName(value: string): string {
  return path.basename(value.replaceAll('\\', '/')).toLowerCase();
}

export function commandSafetyReason(command: {
  cmd: string;
  args?: readonly string[];
  cwd?: string;
}): string | null {
  const base = baseName(command.cmd);
  if (base === '') return 'empty command';
  if (DANGEROUS_COMMANDS.has(base)) return `command "${base}" is not allowed in the whitelist`;
  if (base === 'git') {
    const subcommand = command.args?.[0]?.toLowerCase();
    if (subcommand === 'reset' || subcommand === 'clean' || subcommand === 'checkout') {
      return `git ${subcommand} is destructive and not allowed in the whitelist`;
    }
  }
  if (SHELL_META.test(command.cmd)) return 'command contains shell metacharacters';
  for (const arg of command.args ?? []) {
    if (SHELL_META.test(arg)) return `argument contains shell metacharacters: ${arg}`;
    if (
      (base === 'node' || base === 'node.exe') &&
      ['-e', '--eval', '-p', '--print'].includes(arg)
    ) {
      return 'node evaluation flags are not allowed; whitelist a script file instead';
    }
  }
  const cwd = command.cwd ?? '.';
  if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) {
    return 'cwd must stay inside the project root';
  }
  return null;
}

export function assertSafeCommand(command: CommandConfig): void {
  const reason = commandSafetyReason(command);
  if (reason !== null) {
    const error = new Error(reason);
    (error as Error & { code?: string }).code = 'E17';
    throw error;
  }
}
