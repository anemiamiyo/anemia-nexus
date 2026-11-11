import { registerHooks } from 'node:module';

const BLOCKED = /^(node:)?(net|http|https|http2|dns|tls|child_process|worker_threads)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BLOCKED.test(specifier)) {
      throw new Error(`BLOCKED_MODULE:${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});

globalThis.fetch = async function blockedFetch() {
  throw new Error('NETWORK_DISABLED');
};
