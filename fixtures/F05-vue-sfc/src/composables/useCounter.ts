import { ref } from 'vue';

export function useCounter(initial = 0) {
  const count = ref(initial);
  function increment(): void {
    count.value += 1;
  }
  return { count, increment };
}
