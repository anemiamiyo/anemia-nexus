<script setup lang="ts">
defineProps<{ items: string[] }>();
defineSlots<{ default(): unknown; row(props: { item: string }): unknown }>();
</script>

<template>
  <ul>
    <li v-for="item in items" :key="item">
      <slot name="row" :item="item" />
    </li>
  </ul>
  <slot />
</template>
