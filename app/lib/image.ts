export type ContourMode = 'auto' | 'lineart' | 'generate'

export interface ProcessOptions {
  colors: number
  mode: ContourMode
  /** Lineart: L* below which a pixel is fully treated as outline (0..100). */
  lineThreshold: number
  /** Generated contour: line thickness in px. */
  lineWidth: number
  /** Regions smaller than this (px) are merged into neighbours. */
  minRegion: number
  seed?: number
}

export const defaultOptions: ProcessOptions = {
  colors: 16,
  mode: 'auto',
  lineThreshold: 35,
  lineWidth: 2,
  minRegion: 30,
}

export interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface ProcessResult {
  width: number
  height: number
  /** Effective contour mode after auto-detection. */
  mode: 'lineart' | 'generate'
  /** Palette as [r,g,b] 0..255, sorted. */
  palette: [number, number, number][]
  /** Quantized colour reference, fully opaque. */
  colored: Uint8ClampedArray
  /** Black outline on transparent background. */
  contour: Uint8ClampedArray
}

function srgbToLinear(c: number) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i)

function fLab(t: number) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!, G = LIN[g]!, B = LIN[b]!
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
  const fx = fLab(x), fy = fLab(y), fz = fLab(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  let h = 0
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, max === 0 ? 0 : d / max, max]
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function flatten(img: RGBAImage) {
  const n = img.width * img.height
  const rgb = new Uint8Array(n * 3)
  const L = new Float32Array(n)
  const d = img.data
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]! / 255
    const r = Math.round(d[i * 4]! * a + 255 * (1 - a))
    const g = Math.round(d[i * 4 + 1]! * a + 255 * (1 - a))
    const b = Math.round(d[i * 4 + 2]! * a + 255 * (1 - a))
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b
    L[i] = rgbToLab(r, g, b)[0]
  }
  return { rgb, L }
}

/**
 * Heuristic: an image "has lineart" when a modest share of pixels is very dark
 * and most of those dark pixels sit next to light pixels (thin strokes, not big dark fills).
 */
export function detectLineart(width: number, height: number, L: Float32Array, threshold: number): boolean {
  const n = width * height
  let dark = 0, thin = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (L[i]! >= threshold) continue
      dark++
      let near = false
      for (let k = 1; k <= 3 && !near; k++) {
        if ((x - k >= 0 && L[i - k]! > threshold + 25)
          || (x + k < width && L[i + k]! > threshold + 25)
          || (y - k >= 0 && L[i - k * width]! > threshold + 25)
          || (y + k < height && L[i + k * width]! > threshold + 25)) near = true
      }
      if (near) thin++
    }
  }
  const ratio = dark / n
  return ratio > 0.003 && ratio < 0.35 && thin / Math.max(dark, 1) > 0.6
}

export function kmeans(samples: Float32Array, k: number, seed = 1, iterations = 16): Float32Array {
  const m = samples.length / 3
  const rand = mulberry32(seed)
  const centers = new Float32Array(k * 3)
  if (m === 0) return centers
  let first = Math.floor(rand() * m)
  centers.set(samples.subarray(first * 3, first * 3 + 3), 0)
  const dist = new Float32Array(m).fill(Infinity)
  let have = 1
  for (; have < k; have++) {
    let sum = 0
    const c = (have - 1) * 3
    for (let i = 0; i < m; i++) {
      const dl = samples[i * 3]! - centers[c]!, da = samples[i * 3 + 1]! - centers[c + 1]!, db = samples[i * 3 + 2]! - centers[c + 2]!
      const dd = dl * dl + da * da + db * db
      if (dd < dist[i]!) dist[i] = dd
      sum += dist[i]!
    }
    if (sum === 0) break
    let r = rand() * sum, pick = m - 1
    for (let i = 0; i < m; i++) { r -= dist[i]!; if (r <= 0) { pick = i; break } }
    centers.set(samples.subarray(pick * 3, pick * 3 + 3), have * 3)
  }
  const kk = have
  const assign = new Int32Array(m)
  for (let it = 0; it < iterations; it++) {
    const acc = new Float64Array(kk * 4)
    let moved = 0
    for (let i = 0; i < m; i++) {
      const best = nearest(centers, kk, samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!)
      if (best !== assign[i]) moved++
      assign[i] = best
      const o = best * 4
      acc[o] = acc[o]! + samples[i * 3]!
      acc[o + 1] = acc[o + 1]! + samples[i * 3 + 1]!
      acc[o + 2] = acc[o + 2]! + samples[i * 3 + 2]!
      acc[o + 3] = acc[o + 3]! + 1
    }
    for (let c = 0; c < kk; c++) {
      const cnt = acc[c * 4 + 3]!
      if (cnt > 0) { centers[c * 3] = acc[c * 4]! / cnt; centers[c * 3 + 1] = acc[c * 4 + 1]! / cnt; centers[c * 3 + 2] = acc[c * 4 + 2]! / cnt }
    }
    if (it > 0 && moved === 0) break
  }
  return centers.slice(0, kk * 3)
}

function nearest(centers: Float32Array, k: number, l: number, a: number, b: number) {
  let best = 0, bd = Infinity
  for (let c = 0; c < k; c++) {
    const dl = l - centers[c * 3]!, da = a - centers[c * 3 + 1]!, db = b - centers[c * 3 + 2]!
    const dd = dl * dl + da * da + db * db
    if (dd < bd) { bd = dd; best = c }
  }
  return best
}

function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883
  const lin = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.2040 * y + 1.0570 * z,
  ]
  return lin.map((c) => {
    c = Math.min(1, Math.max(0, c))
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(s * 255)
  }) as [number, number, number]
}

export function mergeSmallRegions(labels: Int32Array, width: number, height: number, minArea: number, skip?: Uint8Array) {
  if (minArea <= 1) return
  const n = width * height
  const comp = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const compPixels: number[][] = []
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || (skip && skip[s])) continue
    const id = compPixels.length
    const px: number[] = []
    let sp = 0
    stack[sp++] = s; comp[s] = id
    while (sp > 0) {
      const i = stack[--sp]!
      px.push(i)
      const x = i % width
      const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]
      for (const j of nb) {
        if (j < 0 || j >= n || comp[j] !== -1 || (skip && skip[j]) || labels[j] !== labels[s]) continue
        comp[j] = id; stack[sp++] = j
      }
    }
    compPixels.push(px)
  }
  for (const px of compPixels) {
    if (px.length >= minArea) continue
    const votes = new Map<number, number>()
    const own = labels[px[0]!]!
    for (const i of px) {
      const x = i % width
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= n || (skip && skip[j])) continue
        const l = labels[j]!
        if (l !== own) votes.set(l, (votes.get(l) ?? 0) + 1)
      }
    }
    let best = own, bv = 0
    for (const [l, v] of votes) if (v > bv) { bv = v; best = l }
    for (const i of px) labels[i] = best
  }
}

/** Chessboard distance from each pixel to the nearest pixel where mask is 0 (two-pass transform). */
export function chessboardDistance(mask: Uint8Array, width: number, height: number): Int32Array {
  const big = width + height
  const d = new Int32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) { d[i] = 0; continue }
      let v = big
      if (x > 0) v = Math.min(v, d[i - 1]! + 1)
      if (y > 0) {
        v = Math.min(v, d[i - width]! + 1)
        if (x > 0) v = Math.min(v, d[i - width - 1]! + 1)
        if (x < width - 1) v = Math.min(v, d[i - width + 1]! + 1)
      }
      d[i] = v
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      let v = d[i]!
      if (v === 0) continue
      if (x < width - 1) v = Math.min(v, d[i + 1]! + 1)
      if (y < height - 1) {
        v = Math.min(v, d[i + width]! + 1)
        if (x < width - 1) v = Math.min(v, d[i + width + 1]! + 1)
        if (x > 0) v = Math.min(v, d[i + width - 1]! + 1)
      }
      d[i] = v
    }
  }
  return d
}

function dropSmallComponents(mask: Uint8Array, width: number, height: number, minArea: number) {
  const n = width * height
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue
    const px: number[] = []
    let sp = 0
    stack[sp++] = s; seen[s] = 1
    while (sp > 0) {
      const i = stack[--sp]!
      px.push(i)
      const x = i % width
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= n || seen[j] || !mask[j]) continue
        seen[j] = 1; stack[sp++] = j
      }
    }
    if (px.length < minArea) for (const i of px) mask[i] = 0
  }
}

/** Fill pixels with label -1 from nearest labelled pixel (multi-source BFS). */
function propagateLabels(labels: Int32Array, width: number, height: number) {
  const n = width * height
  const queue = new Int32Array(n)
  let qh = 0, qt = 0
  for (let i = 0; i < n; i++) if (labels[i]! >= 0) queue[qt++] = i
  while (qh < qt) {
    const i = queue[qh++]!
    const x = i % width
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j < 0 || j >= n || labels[j]! >= 0) continue
      labels[j] = labels[i]!
      queue[qt++] = j
    }
  }
}

export function processImage(img: RGBAImage, opts: ProcessOptions): ProcessResult {
  const { width, height } = img
  const n = width * height
  const { rgb, L } = flatten(img)
  const k = Math.max(2, Math.min(30, Math.round(opts.colors)))
  const thr = opts.lineThreshold
  const mode = opts.mode === 'auto' ? (detectLineart(width, height, L, thr) ? 'lineart' : 'generate') : opts.mode

  const soft = 15
  const isLine = new Uint8Array(n)
  const lineAlpha = new Uint8Array(n)
  if (mode === 'lineart') {
    for (let i = 0; i < n; i++) if (L[i]! < thr) isLine[i] = 1
    // Morphological opening: dark areas thicker than a stroke are fills (e.g. black hair), not lines.
    const k = Math.max(3, Math.round(Math.min(width, height) / 150))
    const depth = chessboardDistance(isLine, width, height)
    const thick = new Uint8Array(n)
    for (let i = 0; i < n; i++) thick[i] = depth[i]! > k ? 1 : 0
    dropSmallComponents(thick, width, height, (6 * k) ** 2)
    const notThick = new Uint8Array(n)
    for (let i = 0; i < n; i++) notThick[i] = thick[i] ? 0 : 1
    const nearCore = chessboardDistance(notThick, width, height)
    for (let i = 0; i < n; i++) if (isLine[i] && nearCore[i]! <= k) isLine[i] = 0
    const notLine = new Uint8Array(n)
    for (let i = 0; i < n; i++) notLine[i] = isLine[i] ? 0 : 1
    const toLine = chessboardDistance(notLine, width, height)
    for (let i = 0; i < n; i++) {
      const l = L[i]!
      if (isLine[i]) lineAlpha[i] = 255
      else if (l < thr + soft && toLine[i]! <= 2) lineAlpha[i] = Math.round(255 * Math.min(1, (thr + soft - l) / soft))
    }
  }

  // Sample non-outline pixels for k-means (outline colours never enter the palette).
  const rand = mulberry32((opts.seed ?? 1) * 7919)
  const maxSamples = 40000
  let candidates = 0
  for (let i = 0; i < n; i++) if (!isLine[i] && lineAlpha[i]! < 128) candidates++
  const stride = Math.max(1, candidates / maxSamples)
  const samples: number[] = []
  let acc = 0
  for (let i = 0; i < n; i++) {
    if (isLine[i] || lineAlpha[i]! >= 128) continue
    acc += 1
    if (acc >= stride) {
      acc -= stride
      if (rand() < 0.999) samples.push(...rgbToLab(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!))
    }
  }
  const centers = kmeans(Float32Array.from(samples), k, opts.seed ?? 1)
  const kk = centers.length / 3

  const cache = new Int16Array(1 << 18).fill(-1)
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (isLine[i]) { labels[i] = -1; continue }
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
    let c = cache[key]!
    if (c < 0) {
      const lab = rgbToLab(r, g, b)
      c = nearest(centers, kk, lab[0], lab[1], lab[2])
      cache[key] = c
    }
    labels[i] = c
  }
  // Anti-aliased line edges should take the colour of the region, not a muddy average.
  if (mode === 'lineart') for (let i = 0; i < n; i++) if (lineAlpha[i]! >= 128) labels[i] = -1
  propagateLabels(labels, width, height)
  mergeSmallRegions(labels, width, height, opts.minRegion)

  const used = new Uint32Array(kk)
  for (let i = 0; i < n; i++) used[labels[i]!]!++
  const entries: { idx: number, rgb: [number, number, number], hsb: [number, number, number] }[] = []
  for (let c = 0; c < kk; c++) {
    if (!used[c]) continue
    const col = labToRgb(centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!)
    entries.push({ idx: c, rgb: col, hsb: rgbToHsb(...col) })
  }
  entries.sort((a, b) => {
    const ga = a.hsb[1] < 0.12 ? 1 : 0, gb = b.hsb[1] < 0.12 ? 1 : 0
    if (ga !== gb) return ga - gb
    if (ga) return b.hsb[2] - a.hsb[2]
    return a.hsb[0] - b.hsb[0] || b.hsb[2] - a.hsb[2]
  })
  const remap = new Int32Array(kk).fill(-1)
  entries.forEach((e, i) => { remap[e.idx] = i })
  const palette = entries.map(e => e.rgb)

  const colored = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const p = palette[remap[labels[i]!]!]!
    colored[i * 4] = p[0]; colored[i * 4 + 1] = p[1]; colored[i * 4 + 2] = p[2]; colored[i * 4 + 3] = 255
  }

  const contour = new Uint8ClampedArray(n * 4)
  if (mode === 'lineart') {
    for (let i = 0; i < n; i++) contour[i * 4 + 3] = lineAlpha[i]!
  }
  else {
    const edge = new Uint8Array(n)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if ((x + 1 < width && labels[i + 1] !== labels[i]) || (y + 1 < height && labels[i + width] !== labels[i])) edge[i] = 1
      }
    }
    const w = Math.max(1, Math.round(opts.lineWidth))
    const r0 = Math.floor((w - 1) / 2), r1 = w - 1 - r0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!edge[y * width + x]) continue
        for (let dy = -r0; dy <= r1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -r0; dx <= r1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= width) continue
            contour[(yy * width + xx) * 4 + 3] = 255
          }
        }
      }
    }
  }
  return { width, height, mode, palette, colored, contour }
}
