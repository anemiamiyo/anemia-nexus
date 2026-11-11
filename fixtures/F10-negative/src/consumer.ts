import { dynamicTarget, referencedOnce, typeOnlyUsed } from './api';
import type { OnlyType } from './api';

export function consume(input: OnlyType): string {
  return referencedOnce() + typeOnlyUsed(input.value) + String(dynamicTarget);
}
