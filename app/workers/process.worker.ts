import { processImage, type ProcessOptions } from '../lib/image'
import { buildColoringBook, compositeContourOnWhite } from '../lib/coloringBook'

export interface WorkerRequest {
  id: number
  width: number
  height: number
  data: Uint8ClampedArray
  options: ProcessOptions
  name: string
}

export type WorkerResponse =
  | {
    id: number
    ok: true
    mode: 'lineart' | 'generate'
    width: number
    height: number
    palette: [number, number, number][]
    colored: Uint8ClampedArray
    contour: Uint8ClampedArray
    procreate: Uint8Array
    swatches: Uint8Array
  }
  | { id: number, ok: false, error: string }

async function thumbnail(pixels: Uint8ClampedArray, width: number, height: number) {
  const full = new OffscreenCanvas(width, height)
  full.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
  const scale = Math.min(1, 1024 / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * scale)), th = Math.max(1, Math.round(height * scale))
  const small = new OffscreenCanvas(tw, th)
  const ctx = small.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(full, 0, 0, tw, th)
  const blob = await small.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, width, height, data, options, name } = e.data
  try {
    const result = processImage({ width, height, data }, options)
    const thumb = await thumbnail(compositeContourOnWhite(result.contour), width, height)
    const book = buildColoringBook(result, name, thumb)
    const msg: WorkerResponse = {
      id,
      ok: true,
      mode: result.mode,
      width,
      height,
      palette: result.palette,
      colored: result.colored,
      contour: result.contour,
      procreate: book.procreate,
      swatches: book.swatches,
    }
    ;(self as unknown as Worker).postMessage(msg, [
      result.colored.buffer,
      result.contour.buffer,
      book.procreate.buffer,
      book.swatches.buffer,
    ])
  }
  catch (err) {
    const msg: WorkerResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
