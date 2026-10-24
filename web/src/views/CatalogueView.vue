<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, formatPence, toPence } from '../api.js';

const emit = defineEmits(['navigate']);

const items = ref([]);
const categories = ref([]);
const stores = ref([]);
const query = ref('');
const openId = ref(null);
const error = ref('');
const form = reactive({ name: '', category_id: '', default_unit: '' });

async function load() {
  try {
    [items.value, categories.value, stores.value] = await Promise.all([
      api.get('/items'),
      api.get('/categories'),
      api.get('/stores'),
    ]);
    if (!form.category_id && categories.value.length > 0) form.category_id = categories.value[0].id;
  } catch (err) {
    error.value = err.message;
  }
}

// Run a change, then reload so the screen shows what the server now holds.
async function act(change) {
  try {
    await change();
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
  await load();
}

// Items arrive ordered by category; fold them into sections.
const sections = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const result = [];
  for (const item of items.value) {
    if (needle && !item.name.toLowerCase().includes(needle)) continue;
    let section = result.at(-1);
    if (!section || section.id !== item.category_id) {
      section = { id: item.category_id, name: item.category_name, items: [] };
      result.push(section);
    }
    section.items.push(item);
  }
  return result;
});

const priceSummary = (item) =>
  item.prices.length === 0
    ? 'no prices yet'
    : item.prices
        .map((p) => `${stores.value.find((s) => s.id === p.store_id)?.name ?? '?'} ${formatPence(p.price_pence)}`)
        .join(' · ');

const priceText = (item, storeId) => {
  const price = item.prices.find((p) => p.store_id === storeId);
  return price ? (price.price_pence / 100).toFixed(2) : '';
};

function savePrice(item, store, text) {
  const value = text.trim();
  if (value === priceText(item, store.id)) return;
  if (value === '') return act(() => api.del(`/items/${item.id}/prices/${store.id}`));
  const pence = toPence(value);
  if (pence === null) {
    error.value = `"${value}" is not a valid price`;
    return;
  }
  return act(() => api.put(`/items/${item.id}/prices/${store.id}`, { price_pence: pence }));
}

const setPreferred = (item, value) =>
  act(() => api.patch(`/items/${item.id}`, { preferred_store_id: value === '' ? null : Number(value) }));

async function addItem() {
  const name = form.name.trim();
  if (!name) return;
  try {
    const created = await api.post('/items', {
      name,
      category_id: Number(form.category_id),
      default_unit: form.default_unit.trim() || null,
    });
    form.name = '';
    form.default_unit = '';
    error.value = '';
    await load();
    openId.value = created.id;
  } catch (err) {
    error.value = err.message;
  }
}

function removeItem(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  act(() => api.del(`/items/${item.id}`));
  openId.value = null;
}

onMounted(load);
</script>

<template>
  <h1>Items</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <form class="card add" @submit.prevent="addItem">
    <input v-model="form.name" type="text" placeholder="New item name" aria-label="New item name" />
    <div class="add-row">
      <select v-model="form.category_id" aria-label="Category">
        <option v-for="category in categories" :key="category.id" :value="category.id">
          {{ category.name }}
        </option>
      </select>
      <input v-model="form.default_unit" type="text" placeholder="Unit (e.g. 2L)" aria-label="Unit" />
    </div>
    <button class="primary" type="submit" :disabled="!form.name.trim()">Add item</button>
  </form>

  <p v-if="stores.length === 0" class="card muted">
    Add your shops on the
    <a href="#/manage" @click.prevent="emit('navigate', 'manage')">Manage</a>
    screen first, so you can set a price at each one.
  </p>

  <input v-model="query" type="search" placeholder="Search items" aria-label="Search items" />

  <p v-if="items.length === 0" class="muted empty">No items yet. Add one above, or import a CSV.</p>

  <section v-for="section in sections" :key="section.id">
    <h2>{{ section.name }}</h2>
    <div class="card">
      <ul class="items">
        <li v-for="item in section.items" :key="item.id">
          <button
            class="head"
            :aria-expanded="openId === item.id"
            @click="openId = openId === item.id ? null : item.id"
          >
            <span class="title">{{ item.name }} <span class="muted">{{ item.default_unit }}</span></span>
            <span class="muted small">{{ priceSummary(item) }}</span>
          </button>

          <div v-if="openId === item.id" class="detail">
            <label v-for="store in stores" :key="store.id" class="price">
              <span>{{ store.name }}</span>
              <span class="pound">
                £
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="–"
                  :value="priceText(item, store.id)"
                  :aria-label="`${item.name} price at ${store.name}`"
                  @change="savePrice(item, store, $event.target.value)"
                />
              </span>
            </label>

            <label v-if="item.prices.length > 1" class="price">
              <span>Usual store</span>
              <select :value="item.preferred_store_id ?? ''" @change="setPreferred(item, $event.target.value)">
                <option value="">Cheapest</option>
                <option v-for="p in item.prices" :key="p.store_id" :value="p.store_id">
                  {{ stores.find((s) => s.id === p.store_id)?.name }}
                </option>
              </select>
            </label>

            <button class="danger" @click="removeItem(item)">Delete item</button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.add {
  display: grid;
  gap: 0.5rem;
}
.add-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.empty {
  text-align: center;
  margin: 2rem 0;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.items li {
  border-top: 1px solid var(--border);
}
.items li:first-child {
  border-top: 0;
}
.head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  border: 0;
  background: none;
  text-align: left;
  padding: 0.5rem 0;
}
.small {
  font-size: 0.85rem;
}
.detail {
  display: grid;
  gap: 0.5rem;
  padding: 0.25rem 0 0.75rem;
}
.price {
  display: grid;
  grid-template-columns: 1fr 8rem;
  align-items: center;
  gap: 0.5rem;
}
.pound {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
</style>
