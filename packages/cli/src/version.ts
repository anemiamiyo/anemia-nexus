import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageInfo {
  name: string;
  version: string;
}

function readPackage(): PackageInfo {
  try {
    const value = require('../package.json') as unknown;
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.name === 'string' && typeof record.version === 'string') {
        return { name: record.name, version: record.version };
      }
    }
  } catch {
    // fall through to defaults
  }
  return { name: 'anemia-cli', version: '0.0.0' };
}

const packageInfo = readPackage();

export const PACKAGE_NAME = packageInfo.name;
export const PACKAGE_VERSION = packageInfo.version;

export function versionText(): string {
  return `${PACKAGE_NAME} ${PACKAGE_VERSION}\nnode ${process.versions.node}`;
}
