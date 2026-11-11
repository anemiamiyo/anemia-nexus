const BLOCKED = /^(node:)?(net|http|https|http2|dns|tls|child_process|worker_threads)$/;

export async function resolve(specifier, context, nextResolve) {
  if (BLOCKED.test(specifier)) {
    throw new Error(`BLOCKED_MODULE:${specifier}`);
  }
  return nextResolve(specifier, context);
}
