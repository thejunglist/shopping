<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import ManageList from '../components/ManageList.vue';

const categories = ref([]);
const stores = ref([]);
const health = ref(null);
const user = ref(null);
const error = ref('');

async function load() {
  try {
    [categories.value, stores.value] = await Promise.all([api.get('/categories'), api.get('/stores')]);
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(async () => {
  load();
  // The release and who the server thinks you are: handy for checking a deploy.
  try {
    const [h, me] = await Promise.all([fetch('/healthz').then((r) => r.json()), api.get('/me')]);
    health.value = h;
    user.value = me.user;
  } catch {
    health.value = null;
  }
});
</script>

<template>
  <h1>Manage</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>


  <ManageList
    title="Shops"
    noun="shop"
    path="/stores"
    :rows="stores"
    hint="Lists are grouped by shop, in this order."
    @changed="load"
  />

  <ManageList
    title="Categories"
    noun="category"
    path="/categories"
    :rows="categories"
    hint="Within each shop, items are listed in this order. Arrange it like the aisles in your usual shop."
    @changed="load"
  />

  <section>
    <h2>ATest</h2>
    <dl class="card about">
      <dt>Signed in as</dt>
      <dd>{{ user ?? 'unknown (not via Tailscale)' }}</dd>
      <template v-if="health">
        <dt>Release</dt>
        <dd>{{ health.version }}</dd>
        <dt>Database schema</dt>
        <dd>{{ health.schema }}</dd>
      </template>
      <template v-else>
        <dt>Server</dt>
        <dd>Can't reach it</dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.about {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
