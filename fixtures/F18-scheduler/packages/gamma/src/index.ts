import { betaLabel } from '../../beta/src/index';

export function gammaLabel(id: string): string {
  return `${betaLabel({ id })}:gamma`;
}
