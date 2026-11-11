// This package is reachable via tsconfig paths but is NOT declared in
// packages/app/package.json dependencies. The cross-package policy must reject it.
import { secret } from '@fixture/private-lib';

export const leaked = secret();
