import { createStore, formatLabel, type Store } from './core';

export interface OverlayProps {
  title: string;
}

export class OverlayController {
  private readonly store: Store;

  constructor(title: string) {
    this.store = createStore({ name: title });
  }

  label(): string {
    return formatLabel(this.store.read());
  }
}

export function useOverlay(title: string): OverlayController {
  return new OverlayController(title);
}
