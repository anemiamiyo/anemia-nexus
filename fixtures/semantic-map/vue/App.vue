<script setup lang="ts">
import Child from './Child.vue';

const msg = 'hello';
const count = 1;

function onClick(): void {
  msg.toUpperCase();
}
</script>

<template>
  <Child :label="msg" @select="onClick">
    <template #default>
      <span>{{ msg }}</span>
    </template>
  </Child>
  <p>{{ msg }}</p>
  <button v-if="count > 0" @click="onClick">go</button>
</template>
