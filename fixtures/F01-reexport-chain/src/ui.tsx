import { Counter } from './barrel';

export function CounterView(props: { start: number }): null {
  const counter = new Counter({ start: props.start });
  counter.increment();
  return null;
}
