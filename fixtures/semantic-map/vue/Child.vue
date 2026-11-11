<script setup lang="ts">
defineProps<{ label: string }>();
const emit = defineEmits<{ select: [] }>();
defineSlots<{ default(): unknown }>();

function fire(): void {
  emit('select');
}
</script>

<template>
  <button @click="fire">{{ label }}</button>
  <slot />
</template>
