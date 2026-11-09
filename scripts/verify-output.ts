// Run: bun scripts/verify-output.ts <outDir>
// Builds a synthetic lineart image, runs the full pipeline and checks both generated files.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { unzipSync, strFromU8 } from 'fflate'
import { lzo1xDecompress } from 'lzo1x'
import { processImage, defaultOptions } from '../app/lib/image'
import { buildColoringBook } from '../app/lib/coloringBook'
import { TILE } from '../app/lib/procreate'

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
  const m = n.match(/^([0-9A-F-]{36})\/(\d+)~(\d+)\.chunk$/)
  if (m) layerDirs.set(m[1]!, [...(layerDirs.get(m[1]!) ?? []), n])
}
check('tile dirs: contour, reference, white, composite', layerDirs.size === 4, `${layerDirs.size}`)

const colsN = Math.ceil(W / TILE), rowsN = Math.ceil(H / TILE)
const refIdx = book.layerOrder.indexOf('Референс')
const refUuid = book.uuids[refIdx]!
let mismatches = 0, tiles = 0
for (let row = 0; row < rowsN; row++) for (let col = 0; col < colsN; col++) {
  const tw = Math.min(TILE, W - col * TILE), th = Math.min(TILE, H - row * TILE)
  const raw = lzo1xDecompress(files[`${refUuid}/${col}~${row}.chunk`]!, tw * th * 4)
  tiles++
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const src = ((H - 1 - (row * TILE + ty)) * W + col * TILE + tx) * 4
    const d = (ty * tw + tx) * 4
    for (let c = 0; c < 4; c++) if (raw[d + c] !== result.colored[src + c]) mismatches++
  }
}
check('reference tiles round-trip through LZO to exact pixels', mismatches === 0 && tiles === colsN * rowsN, `${tiles} tiles, ${mismatches} mismatched bytes`)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
