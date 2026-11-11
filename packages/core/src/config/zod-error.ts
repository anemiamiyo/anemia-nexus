import type { ZodIssue } from 'zod';

export function zodIssuesToText(issues: readonly ZodIssue[]): string {
  if (issues.length === 0) return 'invalid configuration';
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
