/**
 * Deterministic JSON serialization: object keys are sorted recursively so the
 * same logical value always produces the same bytes. Arrays keep their order.
 * Iterative implementation (no recursion, AGENTS.md 6.2).
 */
export function stableStringify(value: unknown): string {
  type Frame = { value: unknown; out?: () => string };
  const chunks: string[] = [];
  const stack: Frame[] = [{ value }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const current = frame.value;

    if (frame.out) {
      // Composite frame: emitted after all children are serialized.
      chunks.push(frame.out());
      continue;
    }

    if (current === null || typeof current === 'number' || typeof current === 'boolean') {
      chunks.push(JSON.stringify(current));
      continue;
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current));
      continue;
    }
    if (Array.isArray(current)) {
      chunks.push('[');
      stack.push({ value: null, out: () => ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) {
          stack.push({ value: null, out: () => ',' });
        }
        stack.push({ value: current[index] });
      }
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      chunks.push('{');
      stack.push({ value: null, out: () => '}' });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index] as string;
        stack.push({ value: record[key] });
        stack.push({ value: null, out: () => `${JSON.stringify(key)}:` });
        if (index > 0) {
          stack.push({ value: null, out: () => ',' });
        }
      }
      continue;
    }
    // undefined, function, symbol, bigint are not part of canonical config input.
    chunks.push('null');
  }

  return chunks.join('');
}
