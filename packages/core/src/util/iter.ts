/**
 * Iterative helpers. Recursion is forbidden by .dsh/AGENTS.md 6.2, so all
 * graph/AST walks in this package use explicit stacks.
 */
export function walkStack<T>(root: T, children: (node: T) => readonly T[]): T[] {
  const output: T[] = [];
  const stack: T[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as T;
    output.push(node);
    const next = children(node);
    for (let index = next.length - 1; index >= 0; index -= 1) {
      stack.push(next[index] as T);
    }
  }
  return output;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
