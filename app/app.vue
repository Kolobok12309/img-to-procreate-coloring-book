<script setup lang="ts">
import { defaultOptions, type ProcessOptions } from '~/lib/image'
import { convert, decodeImage, type ConvertResult } from '~/composables/useConverter'

type View = 'result' | 'reference' | 'contour' | 'original'

interface Item {
  id: number
  name: string
  file: File
  originalUrl: string
  options: ProcessOptions
  maxSide: number
  image: { width: number, height: number, data: Uint8ClampedArray, originalWidth: number, originalHeight: number } | null
  decodedSide: number
  result: ConvertResult | null
  procreateUrl: string | null
  swatchesUrl: string | null
  busy: boolean
  error: string | null
  requestToken: number
}

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
const items = ref<Item[]>([])
const activeId = ref<number | null>(null)
const view = ref<View>('result')
const dragging = ref(false)
const canvas = ref<HTMLCanvasElement | null>(null)
let seq = 1

const active = computed(() => items.value.find(i => i.id === activeId.value) ?? null)

function baseName(file: File) {
  return file.name.replace(/\.[^.]+$/, '') || 'coloring'
}

function addFiles(files: FileList | File[] | null | undefined) {
  if (!files) return
  for (const file of Array.from(files)) {
    if (!ACCEPT.includes(file.type)) continue
    const item: Item = reactive({
      id: seq++,
      name: baseName(file),
      file,
      originalUrl: URL.createObjectURL(file),
      options: { ...defaultOptions },
      maxSide: 2048,
      image: null,
      decodedSide: 0,
      result: null,
      procreateUrl: null,
      swatchesUrl: null,
      busy: false,
      error: null,
      requestToken: 0,
    })
    items.value.push(item)
    activeId.value = item.id
    run(item)
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(input.files)
  input.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  addFiles(e.dataTransfer?.files)
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items ?? []).map(i => i.getAsFile()).filter((f): f is File => !!f)
  addFiles(files)
}

function revoke(item: Item) {
  if (item.procreateUrl) URL.revokeObjectURL(item.procreateUrl)
  if (item.swatchesUrl) URL.revokeObjectURL(item.swatchesUrl)
  item.procreateUrl = null
  item.swatchesUrl = null
}

function remove(item: Item) {
  revoke(item)
  URL.revokeObjectURL(item.originalUrl)
  items.value = items.value.filter(i => i.id !== item.id)
  if (activeId.value === item.id) activeId.value = items.value.at(-1)?.id ?? null
}

async function run(item: Item) {
  const token = ++item.requestToken
  item.busy = true
  item.error = null
  try {
    if (!item.image || item.decodedSide !== item.maxSide) {
      item.image = markRaw(await decodeImage(item.file, item.maxSide))
      item.decodedSide = item.maxSide
    }
    const result = await convert(item.image, item.options, item.name)
    if (token !== item.requestToken) return
    revoke(item)
    item.result = markRaw(result)
    item.procreateUrl = URL.createObjectURL(new Blob([result.procreate as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
    item.swatchesUrl = URL.createObjectURL(new Blob([result.swatches as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
  }
  catch (err) {
    if (token === item.requestToken) item.error = err instanceof Error ? err.message : String(err)
  }
  finally {
    if (token === item.requestToken) item.busy = false
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => active.value && [JSON.stringify(active.value.options), active.value.maxSide],
  (now, before) => {
    if (!now || !before || !active.value) return
    const item = active.value
    clearTimeout(timer)
    timer = setTimeout(() => run(item), 350)
  },
)
watch(activeId, () => clearTimeout(timer))

function draw() {
  const el = canvas.value
  const r = active.value?.result
  if (!el || !r) return
  el.width = r.width
  el.height = r.height
  const ctx = el.getContext('2d')!
  const n = r.width * r.height
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const keep = view.value === 'reference' ? 1 : 1 - r.contour[i * 4 + 3]! / 255
    const white = view.value === 'contour'
    out[i * 4] = (white ? 255 : r.colored[i * 4]!) * keep
    out[i * 4 + 1] = (white ? 255 : r.colored[i * 4 + 1]!) * keep
    out[i * 4 + 2] = (white ? 255 : r.colored[i * 4 + 2]!) * keep
    out[i * 4 + 3] = 255
  }
  ctx.putImageData(new ImageData(out, r.width, r.height), 0, 0)
}
watch([() => active.value?.result, view, canvas], () => nextTick(draw))

const hex = (c: [number, number, number]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

const modeLabel: Record<string, string> = { lineart: 'есть контур на картинке', generate: 'контур строится по границам цветов' }

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`
}

onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))
</script>

<template>
  <div class="page">
    <header class="top">
      <div>
        <h1>Раскраска для Procreate</h1>
        <p class="lead">
          Загрузите PNG, JPG или WEBP — получите <b>.procreate</b> со слоями «Контур / Раскраска / Референс / Белый»
          и палитру <b>.swatches</b>. Всё считается в браузере, файлы никуда не отправляются и живут только в этой вкладке.
        </p>
      </div>
    </header>

    <label
      class="drop"
      :class="{ over: dragging, compact: items.length > 0 }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-testid="file-input" @change="onPick">
      <span class="drop-title">Перетащите картинку сюда, вставьте из буфера или нажмите для выбора</span>
      <span class="drop-sub">PNG · JPG · WEBP</span>
    </label>

    <nav v-if="items.length > 1" class="tabs-files">
      <button
        v-for="it in items"
        :key="it.id"
        class="file-chip"
        :class="{ on: it.id === activeId }"
        @click="activeId = it.id"
      >
        <img :src="it.originalUrl" alt="">
        <span>{{ it.name }}</span>
      </button>
    </nav>

    <main v-if="active" class="work">
      <aside class="panel">
        <label class="field">
          <span>Название</span>
          <input v-model.lazy="active.name" type="text" @change="run(active)">
        </label>

        <div class="field">
          <span>Цветов в палитре: <b>{{ active.options.colors }}</b></span>
          <input v-model.number="active.options.colors" type="range" min="2" max="30" data-testid="colors">
        </div>

        <fieldset class="field">
          <legend>Контур</legend>
          <label class="radio"><input v-model="active.options.mode" type="radio" value="auto"> Авто</label>
          <label class="radio"><input v-model="active.options.mode" type="radio" value="lineart"> Взять из картинки (тёмные линии)</label>
          <label class="radio"><input v-model="active.options.mode" type="radio" value="generate"> Построить по границам цветов</label>
          <small v-if="active.result" class="hint" data-testid="mode">Сейчас: {{ modeLabel[active.result.mode] }}</small>
        </fieldset>

        <div v-if="active.result?.mode !== 'generate'" class="field">
          <span>Порог тёмной линии: <b>{{ active.options.lineThreshold }}</b></span>
          <input v-model.number="active.options.lineThreshold" type="range" min="10" max="70">
          <small class="hint">Выше — больше тёмных пикселей попадает в контур</small>
        </div>

        <div v-if="active.result?.mode === 'generate'" class="field">
          <span>Толщина линии: <b>{{ active.options.lineWidth }} px</b></span>
          <input v-model.number="active.options.lineWidth" type="range" min="1" max="8">
        </div>

        <div class="field">
          <span>Убирать области меньше: <b>{{ active.options.minRegion }} px</b></span>
          <input v-model.number="active.options.minRegion" type="range" min="1" max="400" step="1">
        </div>

        <label class="field">
          <span>Макс. сторона холста</span>
          <select v-model.number="active.maxSide">
            <option :value="1024">1024 px</option>
            <option :value="2048">2048 px</option>
            <option :value="3072">3072 px</option>
            <option :value="4096">4096 px</option>
          </select>
          <small v-if="active.image" class="hint">
            Исходник {{ active.image.originalWidth }}×{{ active.image.originalHeight }} → холст {{ active.image.width }}×{{ active.image.height }}
          </small>
        </label>

        <div class="downloads">
          <a
            class="btn primary"
            :class="{ disabled: !active.procreateUrl || active.busy }"
            :href="active.procreateUrl ?? undefined"
            :download="`${active.name}.procreate`"
            data-testid="dl-procreate"
          >Скачать .procreate<small v-if="active.result"> · {{ formatSize(active.result.procreate.byteLength) }}</small></a>
          <a
            class="btn"
            :class="{ disabled: !active.swatchesUrl || active.busy }"
            :href="active.swatchesUrl ?? undefined"
            :download="`${active.name}.swatches`"
            data-testid="dl-swatches"
          >Скачать .swatches</a>
          <button class="btn ghost" @click="remove(active)">Убрать картинку</button>
        </div>
      </aside>

      <section class="preview">
        <div class="views">
          <button v-for="v in (['result', 'reference', 'contour', 'original'] as View[])" :key="v" :class="{ on: view === v }" @click="view = v">
            {{ { result: 'Итог', reference: 'Референс', contour: 'Контур', original: 'Оригинал' }[v] }}
          </button>
          <span v-if="active.busy" class="busy" data-testid="busy">Обработка…</span>
        </div>
        <p v-if="active.error" class="error">Ошибка: {{ active.error }}</p>
        <div class="stage">
          <img v-if="view === 'original'" :src="active.originalUrl" alt="Оригинал">
          <canvas v-else ref="canvas" />
        </div>
        <div v-if="active.result" class="palette" data-testid="palette">
          <div v-for="(c, i) in active.result.palette" :key="i" class="swatch" :title="hex(c)">
            <span :style="{ background: hex(c) }" />
            <code>{{ hex(c) }}</code>
          </div>
        </div>
      </section>
    </main>

    <footer class="foot">
      Слои в файле сверху вниз: <b>Контур</b> (Умножение, закреплён), <b>Раскраска</b> (пустой, выбран), <b>Референс</b> (скрыт), <b>Белый</b>.
      Откройте .procreate и .swatches через «Файлы» на iPad или AirDrop.
    </footer>
  </div>
</template>
