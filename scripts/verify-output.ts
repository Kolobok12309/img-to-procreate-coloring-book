// Run: bun scripts/verify-output.ts <outDir>
// Builds a synthetic lineart image, runs the full pipeline and checks both generated files.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gunzipSync, unzipSync, strFromU8 } from 'fflate'
import { decompressBlock } from 'lz4js'
import { processImage, defaultOptions } from '../app/lib/image'
import { buildColoringBook, compositeContourOnWhite, whitePixels } from '../app/lib/coloringBook'
import { TILE, encodeTiles } from '../app/lib/procreate'

const outDir = process.argv[2] ?? 'verify-out'
mkdirSync(outDir, { recursive: true })
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

const W = 700, H = 420
const data = new Uint8ClampedArray(W * H * 4).fill(255)
const fills: [number, number, number][] = [[220, 40, 40], [40, 90, 210], [60, 170, 70], [245, 200, 30]]
const set = (x: number, y: number, c: [number, number, number]) => {
  const i = (y * W + x) * 4
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255
}
const circles = [[150, 210, 110], [350, 210, 90], [540, 150, 80], [540, 320, 70]] as const
circles.forEach(([cx, cy, r], k) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy)
    if (d <= r - 3) set(x, y, fills[k]!)
    else if (d <= r + 2) set(x, y, [10, 10, 10])
  }
})
let outlinePixels = 0
for (let i = 0; i < W * H; i++) if (data[i * 4] === 10) outlinePixels++

const result = processImage({ width: W, height: H, data }, { ...defaultOptions, colors: 5, mode: 'auto' })
check('auto mode detects lineart', result.mode === 'lineart', result.mode)
check('palette size equals requested colours (4 fills + white)', result.palette.length === 5, JSON.stringify(result.palette))
check('palette has no outline-dark colour', result.palette.every(([r, g, b]) => Math.max(r, g, b) > 60))
let contourPx = 0
for (let i = 0; i < W * H; i++) if (result.contour[i * 4 + 3]! > 200) contourPx++
check('contour layer contains the outline', Math.abs(contourPx - outlinePixels) / outlinePixels < 0.05, `${contourPx} vs ${outlinePixels}`)

const withBlob = data.slice()
for (let y = 20; y < 90; y++) for (let x = 20; x < 90; x++) {
  const i = (y * W + x) * 4
  withBlob[i] = 5; withBlob[i + 1] = 5; withBlob[i + 2] = 5
}
const blob = processImage({ width: W, height: H, data: withBlob }, { ...defaultOptions, colors: 6, mode: 'lineart' })
check('thick dark fill is not contour', blob.contour[(55 * W + 55) * 4 + 3] === 0)
check('thick dark fill enters palette', blob.palette.some(([r, g, b]) => Math.max(r, g, b) < 40), JSON.stringify(blob.palette))
check('dark-ish blue fill kept as colour, not line', result.contour[(210 * W + 350) * 4 + 3] === 0)

{
  const w2 = 900, h2 = 600
  const thickLine = new Uint8ClampedArray(w2 * h2 * 4).fill(255)
  const midFills: [number, number, number][] = [[70, 120, 220], [90, 190, 90]]
  ;([[250, 300, 200], [650, 300, 180]] as const).forEach(([cx, cy, r], k) => {
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const d = Math.hypot(x - cx, y - cy)
      const c = d <= r - 4 ? midFills[k]! : d <= r + 3 ? [15, 15, 15] : null
      if (!c) continue
      const i = (y * w2 + x) * 4
      thickLine[i] = c[0]!; thickLine[i + 1] = c[1]!; thickLine[i + 2] = c[2]!
    }
  })
  const thick = processImage({ width: w2, height: h2, data: thickLine }, { ...defaultOptions, mode: 'auto' })
  check('auto detects lineart with 7px strokes around mid-dark fills', thick.mode === 'lineart', thick.mode)
}

{
  const raw = gunzipSync(readFileSync(new URL('./fixtures/photo-360.rgba.gz', import.meta.url)))
  const dv = new DataView(raw.buffer, raw.byteOffset)
  const pw = dv.getUint32(0, true), ph = dv.getUint32(4, true)
  const photo = processImage({ width: pw, height: ph, data: new Uint8ClampedArray(raw.subarray(8)) }, { ...defaultOptions, mode: 'auto' })
  check('auto picks generated contour for a photo (Unsplash via picsum)', photo.mode === 'generate', photo.mode)
}

const gen = processImage({ width: W, height: H, data }, { ...defaultOptions, colors: 5, mode: 'generate' })
let genPx = 0
for (let i = 0; i < W * H; i++) if (gen.contour[i * 4 + 3]! > 0) genPx++
check('generate mode draws region borders', genPx > 1000, `${genPx}px`)

const fakePng = new Uint8Array([0x89, 0x50, 0x4E, 0x47])
const book = buildColoringBook(result, 'Тест', fakePng)
writeFileSync(join(outDir, 'test.procreate'), book.procreate)
writeFileSync(join(outDir, 'test.swatches'), book.swatches)

const sw = unzipSync(book.swatches)
const swJson = JSON.parse(strFromU8(sw['Swatches.json']!))
check('swatches json has palette', swJson.swatches.length === result.palette.length && swJson.swatches.length <= 30, `${swJson.swatches.length}`)

const files = unzipSync(book.procreate)
const names = Object.keys(files)
check('zip has Document.archive + thumbnail', !!files['Document.archive'] && !!files['QuickLook/Thumbnail.png'])
writeFileSync(join(outDir, 'Document.archive'), files['Document.archive']!)
const plutil = spawnSync('plutil', ['-p', join(outDir, 'Document.archive')], { encoding: 'utf8' })
check('plutil parses Document.archive', plutil.status === 0, plutil.stderr)
writeFileSync(join(outDir, 'Document.plist.txt'), plutil.stdout)
for (const n of ['Контур', 'Раскраска', 'Референс', 'Белый']) check(`layer "${n}" present`, plutil.stdout.includes(`"${n}"`))
check('SilicaDocument class present', plutil.stdout.includes('"SilicaDocument"'))
check('size string', plutil.stdout.includes(`"{${W}, ${H}}"`))
check('one layer hidden (reference)', (plutil.stdout.match(/"hidden" => true/g) ?? []).length === 1)

const layerDirs = new Map<string, string[]>()
for (const n of names) {
  const m = n.match(/^([0-9A-F-]{36})\/(\d+)~(\d+)\.lz4$/)
  if (m) layerDirs.set(m[1]!, [...(layerDirs.get(m[1]!) ?? []), n])
}
check('tile dirs: contour, reference, white, composite', layerDirs.size === 4, `${layerDirs.size}`)
check('coloring layer starts empty', !names.some(n => n.startsWith(`${book.uuids[1]}/`)))

function decodeAppleLz4(frame: Uint8Array): Uint8Array {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const blocks: Uint8Array[] = []
  let offset = 0, total = 0
  while (offset < frame.length) {
    const magic = String.fromCharCode(...frame.subarray(offset, offset + 4))
    if (magic === 'bv4$') {
      if (offset + 4 !== frame.length) throw new Error('trailing bytes after LZ4 terminator')
      const decoded = new Uint8Array(total)
      let start = 0
      for (const block of blocks) { decoded.set(block, start); start += block.length }
      return decoded
    }
    if (magic !== 'bv41') throw new Error(`unexpected LZ4 block ${magic}`)
    const rawSize = view.getUint32(offset + 4, true)
    const compressedSize = view.getUint32(offset + 8, true)
    const block = new Uint8Array(rawSize)
    const written = decompressBlock(frame, block, offset + 12, compressedSize, 0)
    if (written !== rawSize) throw new Error(`LZ4 block decoded ${written} of ${rawSize} bytes`)
    blocks.push(block)
    total += rawSize
    offset += 12 + compressedSize
  }
  throw new Error('LZ4 terminator missing')
}

const smallTile = encodeTiles(new Uint8ClampedArray([35, 70, 105, 255]), 1, 1).files['0~0.lz4']
check('single-pixel fallback is a valid Apple LZ4 frame',
  !!smallTile && decodeAppleLz4(smallTile).every((value, index) => value === [35, 70, 105, 255][index]))

const colsN = Math.ceil(W / TILE), rowsN = Math.ceil(H / TILE)
const expectedLayers = [
  result.contour,
  null,
  result.colored,
  whitePixels(W * H),
  compositeContourOnWhite(result.contour),
] as const
let mismatches = 0, tiles = 0, missing = 0
for (let layer = 0; layer < expectedLayers.length; layer++) {
  const expected = expectedLayers[layer]
  if (!expected) continue
  const folder = layer === 4 ? [...layerDirs.keys()].find(id => !book.uuids.includes(id)) : book.uuids[layer]
  for (let row = 0; row < rowsN; row++) for (let col = 0; col < colsN; col++) {
    const tw = Math.min(TILE, W - col * TILE), th = Math.min(TILE, H - row * TILE)
    const entry = files[`${folder}/${col}~${row}.lz4`]
    let hasPixels = false
    for (let ty = 0; ty < th && !hasPixels; ty++) for (let tx = 0; tx < tw; tx++) {
      if (expected[((H - 1 - (row * TILE + ty)) * W + col * TILE + tx) * 4 + 3]) {
        hasPixels = true
        break
      }
    }
    if (!entry) { if (hasPixels) missing++; continue }
    const raw = decodeAppleLz4(entry)
    tiles++
    if (raw.length !== tw * th * 4) { mismatches++; continue }
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const src = ((H - 1 - (row * TILE + ty)) * W + col * TILE + tx) * 4
      const d = (ty * tw + tx) * 4
      const alpha = expected[src + 3]!
      for (let c = 0; c < 3; c++) if (raw[d + c] !== Math.round(expected[src + c]! * alpha / 255)) mismatches++
      if (raw[d + 3] !== alpha) mismatches++
    }
  }
}
check('all populated layers decode with Apple LZ4 to exact pixels', mismatches === 0 && tiles > colsN * rowsN * 3 && missing === 0, `${tiles} tiles, ${missing} missing, ${mismatches} mismatched bytes`)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
