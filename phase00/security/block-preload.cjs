const Module = require('node:module');
const originalLoad = Module._load;
const BLOCKED = /^(node:)?(net|http|https|http2|dns|tls|child_process|worker_threads)$/;

Module._load = function (request, parent, isMain) {
  if (BLOCKED.test(request)) {
    throw new Error(`BLOCKED_MODULE:${request}`);
  }
  return originalLoad.apply(this, arguments);
};

globalThis.fetch = async function blockedFetch() {
  throw new Error('NETWORK_DISABLED');
};
