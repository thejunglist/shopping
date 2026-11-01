<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatPence, toPence } from '../api.js';
import { getDetector } from '../scan/decoder.js';

// A full-screen camera that ticks items off as you scan them. Known barcodes
// are ticked straight away; a barcode with no price at this shop asks for it;
// an unknown barcode lets you create the item, or link the barcode to an item
// you already have.
const props = defineProps({
  list: { type: Object, required: true },
  stores: { type: Array, required: true },
  categories: { type: Array, required: true },
  items: { type: Array, required: true },
});
const emit = defineEmits(['updated', 'close']);

const STORE_KEY = 'shopping.scanStore';
const savedStore = () => {
  try {
    return Number(localStorage.getItem(STORE_KEY)) || null;
  } catch {
    return null; // private browsing can block storage
  }
};
const rememberStore = () => {
  try {
    localStorage.setItem(STORE_KEY, String(storeId.value));
  } catch {
    // not remembered; the picker still works
  }
};

const video = ref(null);
const storeId = ref(props.stores.find((s) => s.id === savedStore())?.id ?? props.stores[0]?.id ?? null);
const cameraState = ref('starting'); // starting | live | error
const cameraError = ref('');
const torchAvailable = ref(false);
const torchOn = ref(false);
const phase = ref('scan'); // scan | busy | price | new
const status = ref({ text: '', kind: 'info' });
const manual = ref('');
const last = ref(null); // the most recent scan result
const fixing = ref(false);
const fixText = ref('');

const pending = ref(null); // known item that has no price at this shop
const priceText = ref('');
const mode = ref('create'); // create | link, on the unknown-barcode form
const draft = reactive({ ean: '', name: '', category_id: '', unit: '', lookup: '', found: false });
const linkSearch = ref('');
const linkTarget = ref(null);

const storeName = computed(() => props.stores.find((s) => s.id === storeId.value)?.name ?? null);
const say = (text, kind = 'info') => (status.value = { text, kind });

// ---- camera -----------------------------------------------------------

let stream = null;
let timer = null;
let reader = null;
let closed = false;
let lastCode = '';
let lastCodeAt = 0;

function explain(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow it for this site in your browser settings, then reopen the scanner.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app.';
    default:
      return `The camera could not start (${error?.message ?? 'unknown error'}).`;
  }
}

async function startCamera() {
  stopCamera();
  cameraState.value = 'starting';
  // Browsers only allow camera access on https (or localhost).
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    cameraError.value =
      'The camera only works on a secure address. Open the app through your https:// Tailscale address, not an http:// or IP address.';
    cameraState.value = 'error';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (error) {
    cameraError.value = explain(error);
    cameraState.value = 'error';
    return;
  }
  if (closed) return stopCamera();

  video.value.srcObject = stream;
  try {
    await video.value.play();
  } catch {
    // Autoplay can be refused; the picture appears once the person taps the screen.
  }
  torchAvailable.value = Boolean(stream.getVideoTracks()[0]?.getCapabilities?.().torch);

  try {
    reader = (await getDetector()).detector;
  } catch (error) {
    cameraError.value = `The barcode reader could not be loaded (${error.message}). You can still type a barcode.`;
    cameraState.value = 'error';
    return;
  }
  cameraState.value = 'live';
  loop();
}

function stopCamera() {
  clearTimeout(timer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  torchOn.value = false;
}

function loop() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (closed || cameraState.value !== 'live') return;
    try {
      if (phase.value === 'scan' && video.value?.readyState >= 2) {
        const found = await reader.detect(video.value);
        if (found.length > 0) await handleCode(found[0].rawValue);
      }
    } catch {
      // a frame that cannot be read is skipped
    }
    loop();
  }, 150);
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !torchOn.value }] });
    torchOn.value = !torchOn.value;
  } catch {
    torchAvailable.value = false;
  }
}

// Phones stop the camera when the screen locks or the app is backgrounded.
const onVisibility = () => {
  if (document.visibilityState === 'hidden') stopCamera();
  else if (!closed) startCamera();
};

// ---- scanning flow ----------------------------------------------------

// The camera reports the same barcode many times a second while it is in view.
// One barcode counts once: it only counts again after it has been out of view
// for a couple of seconds (so scanning two tins of beans one after the other
// counts two, and holding one tin still counts one).
const GAP_MS = 2000;

async function handleCode(raw) {
  const now = Date.now();
  const sameAsBefore = raw === lastCode && now - lastCodeAt < GAP_MS;
  lastCode = raw;
  lastCodeAt = now; // seeing it again keeps it "still in view"
  if (!sameAsBefore) await lookUp(raw);
}

// Back to scanning. The barcode is probably still in view, so start the quiet
// period from now, whatever happened in between (slow network, a form).
function resume() {
  lastCodeAt = Date.now();
  phase.value = 'scan';
}

async function lookUp(raw) {
  phase.value = 'busy';
  fixing.value = false;
  say('Looking up…');
  try {
    const info = await api.get(`/barcode/${encodeURIComponent(raw)}`);
    if (info.item) {
      const priced = info.item.prices.some((p) => p.store_id === storeId.value);
      if (priced || storeId.value === null) return await tick(info.item);
      pending.value = info.item;
      priceText.value = '';
      say('');
      phase.value = 'price';
      return;
    }
    openNewItem(info);
  } catch (error) {
    // A misread or a network blip: say so and carry on scanning.
    say(error.message, 'bad');
    resume();
  }
}

async function lookUpManual() {
  const code = manual.value.replace(/\s/g, '');
  if (!code) return;
  manual.value = '';
  lastCode = code;
  lastCodeAt = Date.now();
  await lookUp(code);
}

async function tick(item, pricePence) {
  const body = { item_id: item.id };
  if (storeId.value !== null) body.store_id = storeId.value;
  if (pricePence !== undefined) body.price_pence = pricePence;
  const { list, scanned } = await api.post(`/lists/${props.list.id}/scan`, body);
  emit('updated', list);
  last.value = { ...scanned, item_id: item.id };
  navigator.vibrate?.(40);
  say('');
  resume();
}

function backToScanning() {
  pending.value = null;
  say('');
  resume();
}

async function savePrice(skip = false) {
  const text = priceText.value.trim();
  let pence;
  if (!skip) {
    pence = toPence(text);
    if (pence === null) return say(`"${text}" is not a valid price`, 'bad');
  }
  try {
    await tick(pending.value, pence);
    pending.value = null;
  } catch (error) {
    say(error.message, 'bad');
  }
}

function openNewItem(info) {
  draft.ean = info.ean;
  draft.name = info.product?.name ?? '';
  draft.unit = info.product?.quantity ?? '';
  draft.category_id = info.suggested_category_id ?? props.categories[0]?.id ?? '';
  draft.lookup = info.lookup;
  draft.found = Boolean(info.product);
  priceText.value = '';
  mode.value = 'create';
  linkSearch.value = '';
  linkTarget.value = null;
  say('');
  phase.value = 'new';
}

const linkMatches = computed(() => {
  const query = linkSearch.value.trim().toLowerCase();
  return props.items
    .filter((item) => !item.ean && (!query || item.name.toLowerCase().includes(query)))
    .slice(0, 6);
});

async function saveNew() {
  const text = priceText.value.trim();
  const pence = text === '' ? undefined : toPence(text);
  if (pence === null) return say(`"${text}" is not a valid price`, 'bad');
  try {
    let item;
    if (mode.value === 'link') {
      if (!linkTarget.value) return say('Choose the item this barcode belongs to', 'bad');
      item = await api.patch(`/items/${linkTarget.value.id}`, { ean: draft.ean });
    } else {
      const name = draft.name.trim();
      if (!name) return say('Give the item a name', 'bad');
      item = await api.post('/items', {
        name,
        category_id: Number(draft.category_id),
        ean: draft.ean,
        default_unit: draft.unit.trim() || null,
      });
    }
    await tick(item, storeId.value !== null ? pence : undefined);
  } catch (error) {
    say(error.message, 'bad');
  }
}

async function saveFix() {
  const pence = toPence(fixText.value);
  if (pence === null) return say(`"${fixText.value.trim()}" is not a valid price`, 'bad');
  try {
    await api.put(`/items/${last.value.item_id}/prices/${last.value.store_id}`, { price_pence: pence });
    const list = await api.patch(`/lists/${props.list.id}/items/${last.value.list_item_id}`, {
      price_paid_pence: pence,
    });
    emit('updated', list);
    last.value = { ...last.value, unit_price_pence: pence };
    fixing.value = false;
    say('');
  } catch (error) {
    say(error.message, 'bad');
  }
}

function startFix() {
  fixText.value = last.value.unit_price_pence == null ? '' : (last.value.unit_price_pence / 100).toFixed(2);
  fixing.value = true;
}

const resultText = computed(() => {
  const r = last.value;
  if (!r) return '';
  const where = r.store_name ? ` at ${r.store_name}` : '';
  return r.status === 'again' ? `Another ${r.name} (now ${r.quantity})` : `${r.name} ticked${where}`;
});

function close() {
  closed = true;
  stopCamera();
  emit('close');
}

onMounted(() => {
  startCamera();
  document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
  closed = true;
  stopCamera();
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Scan barcodes">
    <video ref="video" playsinline muted autoplay></video>
    <div v-if="cameraState === 'live' && phase === 'scan'" class="reticle" aria-hidden="true"></div>

    <header class="top">
      <button @click="close">Done</button>
      <label class="where">
        <span>Shopping at</span>
        <select
          v-model.number="storeId"
          :disabled="phase === 'busy'"
          aria-label="Shop you are in"
          @change="rememberStore"
        >
          <option v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</option>
          <option v-if="stores.length === 0" :value="null">No shops yet</option>
        </select>
      </label>
      <button v-if="torchAvailable" :aria-pressed="torchOn" @click="toggleTorch">
        {{ torchOn ? 'Light off' : 'Light' }}
      </button>
    </header>

    <section class="panel">
      <p v-if="status.text" class="note" :class="status.kind" role="status">{{ status.text }}</p>

      <!-- Scanning -->
      <template v-if="phase === 'scan' || phase === 'busy'">
        <p v-if="cameraState === 'starting'" class="muted">Starting the camera…</p>
        <p v-else-if="cameraState === 'error'" class="note bad">{{ cameraError }}</p>
        <p v-else-if="phase === 'scan' && !last" class="muted">
          Point the camera at a barcode.
          <template v-if="storeName">Prices are saved for {{ storeName }}.</template>
          <template v-else>Add your shops on the Manage screen to save prices.</template>
        </p>

        <div v-if="last" class="result" :class="{ again: last.status === 'again' }">
          <div>
            <strong>{{ resultText }}</strong>
            <span class="muted">{{ formatPence(last.unit_price_pence) }}</span>
          </div>
          <template v-if="fixing">
            <div class="row">
              <input
                v-model="fixText"
                type="text"
                inputmode="decimal"
                aria-label="Correct price in pounds"
                @keyup.enter="saveFix"
              />
              <button class="primary" @click="saveFix">Save</button>
              <button @click="fixing = false">Cancel</button>
            </div>
          </template>
          <button v-else-if="last.store_id" class="link" @click="startFix">Wrong price?</button>
        </div>

        <form class="row manual" @submit.prevent="lookUpManual">
          <input
            v-model="manual"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="Or type the barcode number"
            aria-label="Barcode number"
          />
          <button type="submit" :disabled="!manual.trim() || phase === 'busy'">Look up</button>
        </form>
      </template>

      <!-- A known item with no price at this shop -->
      <template v-else-if="phase === 'price'">
        <h2>{{ pending.name }}</h2>
        <p class="muted">
          No price yet at {{ storeName }}.
          <template v-if="pending.prices.length">
            Elsewhere:
            {{ pending.prices.map((p) => `${stores.find((s) => s.id === p.store_id)?.name} ${formatPence(p.price_pence)}`).join(', ') }}.
          </template>
        </p>
        <label class="field">
          <span>Shelf price (£)</span>
          <input
            v-model="priceText"
            type="text"
            inputmode="decimal"
            placeholder="e.g. 1.45"
            @keyup.enter="savePrice()"
          />
        </label>
        <div class="row">
          <button class="primary" @click="savePrice()">Save price and tick</button>
          <button @click="savePrice(true)">Tick without a price</button>
          <button @click="backToScanning">Cancel</button>
        </div>
      </template>

      <!-- A barcode not in the catalogue -->
      <template v-else-if="phase === 'new'">
        <h2>New barcode <span class="muted">{{ draft.ean }}</span></h2>
        <p v-if="draft.lookup === 'unavailable'" class="muted">
          Couldn't reach Open Food Facts, so type the name yourself.
        </p>
        <p v-else-if="!draft.found" class="muted">Open Food Facts doesn't know this one. Type the name yourself.</p>
        <p v-else class="muted small">Name suggested by Open Food Facts. Check it before saving.</p>

        <div class="tabs2" role="tablist">
          <button role="tab" :aria-selected="mode === 'create'" @click="mode = 'create'">New item</button>
          <button role="tab" :aria-selected="mode === 'link'" @click="mode = 'link'">An item I have</button>
        </div>

        <template v-if="mode === 'create'">
          <label class="field">
            <span>Name</span>
            <input v-model="draft.name" type="text" autocomplete="off" />
          </label>
          <div class="row">
            <label class="field grow">
              <span>Category</span>
              <select v-model="draft.category_id">
                <option v-for="category in categories" :key="category.id" :value="category.id">
                  {{ category.name }}
                </option>
              </select>
            </label>
            <label class="field grow">
              <span>Size</span>
              <input v-model="draft.unit" type="text" placeholder="e.g. 2L" />
            </label>
          </div>
        </template>
        <template v-else>
          <label class="field">
            <span>Find the item</span>
            <input v-model="linkSearch" type="search" placeholder="Search your items" autocomplete="off" />
          </label>
          <ul class="links">
            <li v-for="item in linkMatches" :key="item.id">
              <button :aria-pressed="linkTarget?.id === item.id" @click="linkTarget = item">
                {{ item.name }} <span class="muted">{{ item.category_name }}</span>
              </button>
            </li>
            <li v-if="linkMatches.length === 0" class="muted">No items without a barcode match.</li>
          </ul>
        </template>

        <label v-if="storeId !== null" class="field">
          <span>Shelf price at {{ storeName }} (£, optional)</span>
          <input v-model="priceText" type="text" inputmode="decimal" placeholder="e.g. 1.45" />
        </label>
        <div class="row">
          <button class="primary" @click="saveNew">Save and tick</button>
          <button @click="backToScanning">Cancel</button>
        </div>
        <p v-if="draft.found" class="muted small">Product data from Open Food Facts (Open Database Licence).</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.sheet {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: #000;
}
video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.reticle {
  position: absolute;
  top: 28%;
  left: 12%;
  width: 76%;
  height: 22%;
  border: 2px solid rgb(255 255 255 / 0.85);
  border-radius: 0.75rem;
  box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.35);
  pointer-events: none;
}
.top {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: calc(0.5rem + env(safe-area-inset-top)) 0.75rem 0.5rem;
  background: linear-gradient(rgb(0 0 0 / 0.6), transparent);
}
.top button {
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  border-color: rgb(255 255 255 / 0.4);
}
.where {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #fff;
  font-size: 0.9rem;
  min-width: 0;
}
.where select {
  min-width: 0;
  /* The header text is white, but the picker has a light background. */
  color: var(--text);
}
.panel {
  position: relative;
  max-height: 65vh;
  overflow-y: auto;
  padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom));
  background: var(--surface);
  color: var(--text);
  border-radius: 1rem 1rem 0 0;
}
h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text);
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
.note {
  margin: 0 0 0.5rem;
}
.note.bad {
  color: var(--bad);
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.row > input {
  flex: 1;
  min-width: 0;
}
.manual {
  margin-top: 0.75rem;
}
.field {
  display: grid;
  gap: 0.25rem;
  margin-top: 0.5rem;
  font-size: 0.9rem;
}
.grow {
  flex: 1;
  min-width: 8rem;
}
.result {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.25rem;
  border: 1px solid var(--accent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.result > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.link {
  justify-self: start;
  border: 0;
  background: none;
  padding: 0;
  min-height: 2.25rem;
  color: var(--accent);
  text-decoration: underline;
}
.tabs2 {
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem 0;
}
.tabs2 button {
  flex: 1;
}
.tabs2 button[aria-selected='true'] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  font-weight: 600;
}
.links {
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
}
.links button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  text-align: left;
}
.links button[aria-pressed='true'] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
