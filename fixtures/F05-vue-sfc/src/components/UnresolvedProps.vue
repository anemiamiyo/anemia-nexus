<script setup lang="ts">
type Deep<T> = { readonly [K in keyof T]: T[K] };

interface WeirdProps {
  callback: Deep<{ value: number }>;
  anything: any;
  missing: never;
  nested?: { deep: Array<{ value: string }> };
}

defineProps<WeirdProps>();
defineSlots<{ neverSlot: never; header(props: { title: string }): unknown }>();
</script>

<template>
  <div>
    <slot name="header" :title="anything" />
    <slot name="neverSlot" />
  </div>
</template>
