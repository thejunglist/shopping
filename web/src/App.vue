<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ListView from './views/ListView.vue';
import CatalogueView from './views/CatalogueView.vue';
import ManageView from './views/ManageView.vue';

// Three screens, chosen by the URL hash so the back button and a home-screen
// shortcut both work without a router library.
const tabs = [
  { id: 'list', label: 'List' },
  { id: 'catalogue', label: 'Items' },
  { id: 'manage', label: 'Manage' },
];
const views = { list: ListView, catalogue: CatalogueView, manage: ManageView };

const read = () => {
  const id = location.hash.replace(/^#\/?/, '');
  return id in views ? id : 'list';
};
const current = ref(read());
const onHash = () => (current.value = read());
const go = (id) => (location.hash = `#/${id}`);
const view = computed(() => views[current.value]);

onMounted(() => window.addEventListener('hashchange', onHash));
onUnmounted(() => window.removeEventListener('hashchange', onHash));
</script>

<template>
  <main class="page">
    <component :is="view" @navigate="go" />
  </main>
  <nav class="tabs" aria-label="Main">
    <a
      v-for="tab in tabs"
      :key="tab.id"
      :href="`#/${tab.id}`"
      :aria-current="current === tab.id ? 'page' : undefined"
    >
      {{ tab.label }}
    </a>
  </nav>
</template>
