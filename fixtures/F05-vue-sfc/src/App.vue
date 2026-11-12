<script setup lang="ts">
import ChildCard from './components/ChildCard.vue';
import ListPanel from './components/ListPanel.vue';
import EdgeCase from './components/EdgeCase.vue';
import UnresolvedProps from './components/UnresolvedProps.vue';
import { useCounter } from './composables/useCounter';
import type { Formatter } from './types';

const { count, increment } = useCounter();
const formatter: Formatter = { save: (value: number) => String(value), label: 'n' };
const key = 'title';
const payload = { id: 1 };
const title = 'hello';

function handleSelect(id: number): void {
  formatter.save(id);
  increment();
}
</script>

<template>
  <ChildCard
    :title="title"
    :count="count"
    :formatter="formatter"
    @select="handleSelect"
    @click="increment"
  >
    <template #default>
      <span>{{ title }}</span>
    </template>
  </ChildCard>

  <ListPanel :items="[title]" v-if="count > 0">
    <template #row="{ item }">
      <span>{{ item }}</span>
    </template>
  </ListPanel>

  <EdgeCase v-bind:[key]="payload" :value="count" />
  <p>{{ formatter.save(count) }}</p>
</template>
