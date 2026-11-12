export function known(): string {
  return 'known';
}

export function caller(obj: Record<string, () => void>): void {
  known();
  obj.known();
  const key = String(Date.now());
  obj[key]();
  eval('1 + 1');
}

export async function run(): Promise<unknown> {
  return import('./lazy');
}
