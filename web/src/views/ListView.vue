<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, formatPence, toPence } from '../api.js';
import ScanSheet from '../components/ScanSheet.vue';

const emit = defineEmits(['navigate']);

const list = ref(null);
const catalogue = ref([]);
const stores = ref([]);
const categories = ref([]);
const scanning = ref(false);
const search = ref('');
const error = ref('');
const editingBudget = ref(false);
const budgetText = ref('');
let timer;

async function load() {
  try {
    list.value = await api.get('/lists/current');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

async function loadCatalogue() {
  try {
    [catalogue.value, stores.value, categories.value] = await Promise.all([
      api.get('/items'),
      api.get('/stores'),
      api.get('/categories'),
    ]);
  } catch (err) {
    error.value = err.message;
  }
}

// Run a change; the server answers with the updated list.
async function act(change) {
  try {
    const updated = await change();
    if (updated) list.value = updated;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

const base = () => `/lists/${list.value.id}`;
const toggle = (row) => act(() => api.patch(`${base()}/items/${row.id}`, { checked: !row.checked }));
const changeQuantity = (row, delta) => {
  const quantity = row.quantity + delta;
  if (quantity >= 1 && quantity <= 99) act(() => api.patch(`${base()}/items/${row.id}`, { quantity }));
};
const remove = (row) => act(() => api.del(`${base()}/items/${row.id}`));
const changeStore = (row, value) =>
  act(() => api.patch(`${base()}/items/${row.id}`, { store_id: value === '' ? null : Number(value) }));

const matches = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return [];
  return catalogue.value.filter((item) => item.name.toLowerCase().includes(query)).slice(0, 8);
});

async function add(item) {
  await act(() => api.post(`${base()}/items`, { item_id: item.id }));
  search.value = '';
}

// The list arrives sorted by store, then category; fold it into that shape.
const groups = computed(() => {
  const result = [];
  for (const row of list.value?.items ?? []) {
    let store = result.find((s) => s.store_id === row.store_id);
    if (!store) {
      store = { store_id: row.store_id, name: row.store_name ?? 'No store chosen', categories: [] };
      result.push(store);
    }
    let category = store.categories.find((c) => c.category_id === row.category_id);
    if (!category) {
      category = { category_id: row.category_id, name: row.category_name, rows: [] };
      store.categories.push(category);
    }
    category.rows.push(row);
  }
  return result;
});

// Stores that have a price for this item, so a row can be moved between them.
const storeChoices = (row) => {
  const prices = catalogue.value.find((item) => item.id === row.item_id)?.prices ?? [];
  return prices.map((p) => ({
    id: p.store_id,
    label: `${stores.value.find((s) => s.id === p.store_id)?.name ?? 'Store'} ${formatPence(p.price_pence)}`,
  }));
};

const totals = computed(() => list.value?.totals);
const budget = computed(() => list.value?.budget_pence);
const overBudget = computed(() => totals.value?.remaining_pence != null && totals.value.remaining_pence < 0);
const barWidth = computed(() =>
  budget.value ? `${Math.min(100, (totals.value.total_pence / budget.value) * 100)}%` : '0%',
);

function editBudget() {
  budgetText.value = budget.value == null ? '' : (budget.value / 100).toFixed(2);
  editingBudget.value = true;
}

async function saveBudget() {
  const text = budgetText.value.trim();
  const pence = text === '' ? null : toPence(text);
  if (text !== '' && pence === null) {
    error.value = `"${text}" is not a valid budget`;
    return;
  }
  await act(() => api.patch(base(), { budget_pence: pence }));
  editingBudget.value = false;
}

async function finish() {
  const unticked = list.value.items.filter((row) => !row.checked).length;
  const warning = unticked > 0 ? ` ${unticked} unticked item(s) will not count as spending.` : '';
  if (!confirm(`Finish this shop?${warning}`)) return;
  try {
    await api.post(`${base()}/complete`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// Pick up changes made on the other phone. Skipped while the tab is hidden or
// while editing, so the poll never interrupts typing.
const refreshWhenVisible = () => {
  if (document.visibilityState === 'visible' && !editingBudget.value && !scanning.value && search.value === '') load();
};
const refreshCatalogue = () => {
  if (document.visibilityState === 'visible') loadCatalogue();
};

onMounted(() => {
  load();
  loadCatalogue();
  timer = setInterval(refreshWhenVisible, 5000);
  document.addEventListener('visibilitychange', refreshCatalogue);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', refreshCatalogue);
});
</script>

<template>
  <h1>{{ list?.name ?? 'Shopping list' }}</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <template v-if="list">
    <section class="card summary" aria-label="Totals">
      <div class="figures">
        <div>
          <span class="muted">Total</span>
          <strong class="big">{{ formatPence(totals.total_pence) }}</strong>
        </div>
        <div>
          <span class="muted">Ticked</span>
          <strong>{{ formatPence(totals.checked_pence) }}</strong>
        </div>
        <div>
          <span class="muted">To get</span>
          <strong>{{ formatPence(totals.unchecked_pence) }}</strong>
        </div>
      </div>

      <div v-if="editingBudget" class="budget-edit">
        <input
          v-model="budgetText"
          type="text"
          inputmode="decimal"
          placeholder="Weekly budget, e.g. 80"
          aria-label="Weekly budget in pounds"
          @keyup.enter="saveBudget"
        />
        <button class="primary" @click="saveBudget">Save</button>
        <button @click="editingBudget = false">Cancel</button>
      </div>
      <template v-else>
        <div v-if="budget != null" class="bar" :class="{ over: overBudget }" aria-hidden="true">
          <span :style="{ width: barWidth }"></span>
        </div>
        <p class="budget-line">
          <template v-if="budget != null">
            <span :class="{ bad: overBudget }">
              {{
                overBudget
                  ? `${formatPence(-totals.remaining_pence)} over budget`
                  : `${formatPence(totals.remaining_pence)} left of ${formatPence(budget)}`
              }}
            </span>
          </template>
          <span v-else class="muted">No budget set</span>
          <button class="link" @click="editBudget">{{ budget == null ? 'Set budget' : 'Change' }}</button>
        </p>
      </template>
      <p v-if="totals.unpriced_count > 0" class="warn">
        {{ totals.unpriced_count }} item{{ totals.unpriced_count === 1 ? ' has' : 's have' }} no price at
        their store, so the total is a minimum.
      </p>
    </section>

    <section class="adder">
      <div class="adder-row">
        <input
          v-model="search"
          type="search"
          placeholder="Add an item…"
          aria-label="Search items to add"
          autocomplete="off"
        />
        <button class="primary" @click="scanning = true">Scan</button>
      </div>
      <ul v-if="search.trim()" class="matches">
        <li v-for="item in matches" :key="item.id">
          <button @click="add(item)">
            <span>{{ item.name }}</span>
            <span class="muted">{{ item.category_name }}</span>
          </button>
        </li>
        <li v-if="matches.length === 0" class="muted none">
          Not in the catalogue.
          <button class="link" @click="emit('navigate', 'catalogue')">Add it there</button>
        </li>
      </ul>
    </section>

    <p v-if="list.items.length === 0" class="muted empty">
      Nothing on the list yet. Search above to add items.
    </p>

    <section v-for="store in groups" :key="store.store_id ?? 'none'" class="store">
      <h2>{{ store.name }}</h2>
      <div v-for="category in store.categories" :key="category.category_id" class="card">
        <h3>{{ category.name }}</h3>
        <ul class="rows">
          <li v-for="row in category.rows" :key="row.id" :class="{ done: row.checked }">
            <input
              type="checkbox"
              class="tick"
              :checked="row.checked"
              :aria-label="`Tick ${row.name}`"
              @change="toggle(row)"
            />
            <span class="title">{{ row.name }}</span>
            <div class="meta">
              <span class="muted small">
                {{ row.default_unit ?? '' }}
                {{ row.unit_price_pence == null ? 'no price' : formatPence(row.unit_price_pence) }}
              </span>
              <select
                v-if="storeChoices(row).length > 1 && !row.checked"
                class="store-pick"
                :value="row.store_id ?? ''"
                :aria-label="`Store for ${row.name}`"
                @change="changeStore(row, $event.target.value)"
              >
                <option v-for="choice in storeChoices(row)" :key="choice.id" :value="choice.id">
                  {{ choice.label }}
                </option>
              </select>
            </div>
            <div class="qty">
              <button :aria-label="`Fewer ${row.name}`" :disabled="row.quantity <= 1" @click="changeQuantity(row, -1)">
                −
              </button>
              <span>{{ row.quantity }}</span>
              <button :aria-label="`More ${row.name}`" @click="changeQuantity(row, 1)">+</button>
            </div>
            <strong class="line">{{ formatPence(row.line_total_pence) }}</strong>
            <button class="danger remove" :aria-label="`Remove ${row.name}`" @click="remove(row)">×</button>
          </li>
        </ul>
      </div>
    </section>

    <button v-if="list.items.length > 0" class="primary finish" @click="finish">Finish this shop</button>
  </template>
  <p v-else-if="!error" class="muted">Loading…</p>

  <ScanSheet
    v-if="scanning && list"
    :list="list"
    :stores="stores"
    :categories="categories"
    :items="catalogue"
    @updated="list = $event"
    @close="scanning = false; loadCatalogue()"
  />
</template>

<style scoped>
.figures {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.figures div {
  display: flex;
  flex-direction: column;
}
.big {
  font-size: 1.5rem;
}
.bar {
  height: 0.5rem;
  margin: 0.75rem 0 0.25rem;
  background: var(--border);
  border-radius: 1rem;
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.bar.over span {
  background: var(--bad);
}
.budget-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0.25rem 0 0;
}
.budget-edit {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.bad {
  color: var(--bad);
  font-weight: 600;
}
.warn {
  margin: 0.5rem 0 0;
  color: var(--warn);
  font-size: 0.9rem;
}
.link {
  border: 0;
  background: none;
  color: var(--accent);
  padding: 0 0.25rem;
  min-height: 2.75rem;
  text-decoration: underline;
}
.adder {
  position: relative;
  margin-bottom: 0.75rem;
}
.adder-row {
  display: flex;
  gap: 0.5rem;
}
.matches {
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}
.matches button {
  display: flex;
  justify-content: space-between;
  width: 100%;
  border: 0;
  border-radius: 0;
  text-align: left;
}
.none {
  padding: 0.5rem 0.75rem;
}
.empty {
  text-align: center;
  margin: 2rem 0;
}
h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}
.store h2 {
  margin-top: 1.25rem;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rows li {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  grid-template-areas:
    'tick title line remove'
    '. meta qty qty';
  align-items: center;
  column-gap: 0.5rem;
  row-gap: 0.25rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--border);
}
.rows li:first-child {
  border-top: 0;
}
.tick {
  grid-area: tick;
}
.title {
  grid-area: title;
  min-width: 0;
  overflow-wrap: anywhere;
}
.rows li.done .title {
  text-decoration: line-through;
  color: var(--muted);
}
.meta {
  grid-area: meta;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.small {
  font-size: 0.85rem;
}
.store-pick {
  min-height: 2.25rem;
  margin-top: 0.25rem;
  font-size: 0.9rem;
}
.qty {
  grid-area: qty;
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.qty button {
  padding: 0;
}
.qty span {
  min-width: 1.25rem;
  text-align: center;
}
.line {
  grid-area: line;
  min-width: 3.5rem;
  text-align: right;
}
.remove {
  grid-area: remove;
}
.finish {
  width: 100%;
  margin-top: 1rem;
}
</style>
