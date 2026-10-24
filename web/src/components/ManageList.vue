<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

// Add, rename, reorder and delete the rows of a simple lookup table
// (categories or stores). The order here is the order lists are shown in.
const props = defineProps({
  title: { type: String, required: true },
  noun: { type: String, required: true },
  path: { type: String, required: true },
  rows: { type: Array, required: true },
  hint: { type: String, default: '' },
});
const emit = defineEmits(['changed']);

const newName = ref('');
const error = ref('');
// Bumped after a failed change so inputs go back to the stored names.
const renderKey = ref(0);

async function run(change) {
  try {
    await change();
    error.value = '';
  } catch (err) {
    error.value = err.message;
    renderKey.value += 1;
  }
  emit('changed');
}

const add = () => {
  const name = newName.value.trim();
  if (!name) return;
  return run(async () => {
    await api.post(props.path, { name });
    newName.value = '';
  });
};

const rename = (row, value) => {
  const name = value.trim();
  if (name && name !== row.name) return run(() => api.patch(`${props.path}/${row.id}`, { name }));
  renderKey.value += 1;
};

const remove = (row) => {
  if (confirm(`Delete ${props.noun} "${row.name}"?`)) return run(() => api.del(`${props.path}/${row.id}`));
};

// Renumber by position, so moves work even if two rows share a sort order.
const move = (index, delta) => {
  const order = props.rows.map((row) => row.id);
  const target = index + delta;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  return run(() =>
    Promise.all(order.map((id, position) => api.patch(`${props.path}/${id}`, { sort_order: (position + 1) * 10 }))),
  );
};
</script>

<template>
  <section>
    <h2>{{ title }}</h2>
    <p v-if="hint" class="muted hint">{{ hint }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="card">
      <ul :key="renderKey" class="rows">
        <li v-for="(row, index) in rows" :key="row.id">
          <input
            type="text"
            :value="row.name"
            :aria-label="`Name of ${noun} ${row.name}`"
            @change="rename(row, $event.target.value)"
          />
          <button :disabled="index === 0" :aria-label="`Move ${row.name} up`" @click="move(index, -1)">↑</button>
          <button
            :disabled="index === rows.length - 1"
            :aria-label="`Move ${row.name} down`"
            @click="move(index, 1)"
          >
            ↓
          </button>
          <button class="danger" :aria-label="`Delete ${row.name}`" @click="remove(row)">×</button>
        </li>
      </ul>
      <form class="add" @submit.prevent="add">
        <input v-model="newName" type="text" :placeholder="`New ${noun}`" :aria-label="`New ${noun} name`" />
        <button class="primary" type="submit" :disabled="!newName.trim()">Add</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
.hint {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}
.rows {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.rows li {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 0.25rem;
}
.rows button {
  padding: 0;
}
.add {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
}
</style>
