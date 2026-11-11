// T05: declaration merging (interface + namespace).
export interface Box {
  a: string;
}

export interface Box {
  b: number;
}

export namespace Box {
  export const tag = 'box';
}
