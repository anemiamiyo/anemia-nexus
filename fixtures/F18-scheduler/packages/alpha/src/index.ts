export interface AlphaModel {
  id: string;
}

export function alphaValue(model: AlphaModel): number {
  return model.id.length;
}

export function alphaLabel(id: string): string {
  return `alpha:${id}`;
}
