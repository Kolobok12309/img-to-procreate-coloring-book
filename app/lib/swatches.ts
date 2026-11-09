import { strToU8, zipSync } from 'fflate'
import { rgbToHsb } from './image'

export const MAX_SWATCHES = 30

export function buildSwatches(name: string, palette: [number, number, number][]): Uint8Array {
  const swatches = palette.slice(0, MAX_SWATCHES).map(([r, g, b]) => {
    const [hue, saturation, brightness] = rgbToHsb(r, g, b)
    return { hue, saturation, brightness, alpha: 1, colorSpace: 0 }
  })
  return zipSync({ 'Swatches.json': strToU8(JSON.stringify({ name, swatches })) })
}
