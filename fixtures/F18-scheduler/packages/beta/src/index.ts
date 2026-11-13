import { alphaLabel, type AlphaModel } from '../../alpha/src/index';

export function betaLabel(model: AlphaModel): string {
  return `${alphaLabel(model.id)}:beta`;
}
