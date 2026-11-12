<script setup lang="ts">
import type { Formatter } from '../types';

interface CardProps {
  title: string;
  count?: number;
  formatter: Formatter;
  disabled?: boolean;
}

const props = withDefaults(defineProps<CardProps>(), { count: 0, disabled: false });
const emit = defineEmits<{ select: [id: number]; click: [] }>();
defineSlots<{ default(): unknown }>();

function fire(): void {
  emit('select', props.count ?? 0);
}
</script>

<template>
  <article @click="fire">
    <h2>{{ title }}</h2>
    <span>{{ count }}</span>
    <slot />
  </article>
</template>
