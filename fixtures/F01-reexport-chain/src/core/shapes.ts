export interface Shape {
  id: string;
  area(): number;
}

export type ID = string;

export const UNIT: Shape = {
  id: 'unit',
  area(): number {
    return 1;
  },
};
