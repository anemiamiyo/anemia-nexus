import { add, Counter } from './barrel';
import type { Shape } from './barrel';
import { plus } from './alias';
import { pad, trimText } from './utils';
import describeCore from './default-export';

export function useAll(shape: Shape): number {
  const counter = new Counter({ start: add(1, 2) });
  counter.increment();
  const total = plus(counter.increment(), shape.area());
  return total + trimText(pad('x')).length + describeCore('f01').length;
}
