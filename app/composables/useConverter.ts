import type { ProcessOptions } from '~/lib/image'
import type { WorkerRequest, WorkerResponse } from '~/workers/process.worker'

export type ConvertResult = Extract<WorkerResponse, { ok: true }>

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: ConvertResult) => void, reject: (e: Error) => void }>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../workers/process.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.ok) p.resolve(e.data)
    else p.reject(new Error(e.data.error))
  }
  return worker
}

export async function decodeImage(file: Blob, maxSide: number) {
  const bitmap = await createImageBitmap(file)
  const originalWidth = bitmap.width, originalHeight = bitmap.height
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return { width, height, data: ctx.getImageData(0, 0, width, height).data, originalWidth, originalHeight }
}

export function convert(image: { width: number, height: number, data: Uint8ClampedArray }, options: ProcessOptions, name: string) {
  const id = nextId++
  const req: WorkerRequest = { id, width: image.width, height: image.height, data: image.data.slice(), options: { ...options }, name }
  return new Promise<ConvertResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage(req, [req.data.buffer])
  })
}
