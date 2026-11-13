import { buildWorkspace, loadConfig } from '../src/index.js';

/**
 * Child entry used by F16 crash tests. `NEXUS_CRASH_AT` is inherited from the
 * parent; the child intentionally dies without cleanup, exactly like a killed
 * build process.
 */
const projectRoot = process.cwd();
const loaded = await loadConfig({ projectRoot, trustConfig: false });
if (loaded.config === null) {
  console.error('no config');
  process.exit(2);
}
const result = await buildWorkspace({ projectRoot, loadedConfig: loaded });
process.exit(result.failedRoots.length > 0 ? 1 : 0);
