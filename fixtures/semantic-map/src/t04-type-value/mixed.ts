// T04: type-only vs value imports must stay distinct.
export interface Shape {
  id: string;
}

export const shape: Shape = { id: 's' };
