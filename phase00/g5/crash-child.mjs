import { runProtocol } from '../lib/sqlite-protocol.mjs';

const [dbPath, buildId, fingerprint, crashAt] = process.argv.slice(2);
runProtocol({ dbPath, buildId, fingerprint, crashAt });
