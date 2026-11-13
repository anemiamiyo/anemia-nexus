import { currentUser } from './user';

export function greeting(): string {
  return `hello ${currentUser()}`;
}
