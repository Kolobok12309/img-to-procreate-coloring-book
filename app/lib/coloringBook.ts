import type { ProcessResult } from './image'
import { BLEND_MULTIPLY, buildProcreate, type LayerInput } from './procreate'
import { buildSwatches } from './swatches'

export interface ColoringBook {
  procreate: Uint8Array
  swatches: Uint8Array
  layerOrder: string[]
  uuids: string[]
}

export function whitePixels(n: number) {
  return new Uint8ClampedArray(n * 4).fill(255)
}

export function compositeContourOnWhite(contour: Uint8ClampedArray) {
  const out = new Uint8ClampedArray(contour.length)
  for (let i = 0; i < contour.length; i += 4) {
    const v = 255 - contour[i + 3]!
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255
  }
  return out
}

export function buildColoringBook(result: ProcessResult, name: string, thumbnailPng: Uint8Array): ColoringBook {
  const n = result.width * result.height
  const layers: LayerInput[] = [
    { name: 'Контур', pixels: result.contour, blend: BLEND_MULTIPLY, locked: true },
    { name: 'Раскраска', pixels: null },
    { name: 'Референс', pixels: result.colored, hidden: true },
    { name: 'Белый', pixels: whitePixels(n), locked: true },
  ]
  const { bytes, uuids } = buildProcreate({
    name,
    width: result.width,
    height: result.height,
    layers,
    selected: 1,
    composite: compositeContourOnWhite(result.contour),
    thumbnailPng,
  })
  return {
    procreate: bytes,
    swatches: buildSwatches(name, result.palette),
    layerOrder: layers.map(l => l.name),
    uuids,
  }
}
