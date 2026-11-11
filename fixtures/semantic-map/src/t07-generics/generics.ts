// T07: generic declarations and instantiations.
export interface Repository<T> {
  get(id: string): T;
  put(value: T): void;
}

export function identity<T>(value: T): T {
  return value;
}

export const numberRepo: Repository<number> = {
  get: () => 1,
  put: () => {},
};

export const one = identity(1);
