export interface StoreOptions {
  name: string;
}

export interface Store {
  name: string;
  read(): string;
}

export function createStore(options: StoreOptions): Store {
  return {
    name: options.name,
    read() {
      return options.name;
    },
  };
}

export function formatLabel(value: string): string {
  return value.toUpperCase();
}
