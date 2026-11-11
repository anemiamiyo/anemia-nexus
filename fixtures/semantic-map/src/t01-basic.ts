// T01: ordinary function / class / variable / interface / type / enum.
export function add(a: number, b: number): number {
  return a + b;
}

export class Counter {
  private value = 0;

  increment(): number {
    this.value += 1;
    return this.value;
  }
}

export interface User {
  id: string;
  name: string;
}

export const DEFAULT_USER: User = { id: 'u1', name: 'Anon' };

export type UserId = string;

export enum Role {
  Admin = 'admin',
  Member = 'member',
}
