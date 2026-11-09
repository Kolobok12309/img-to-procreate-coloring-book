import { zipSync, type Zippable } from 'fflate'
import { lzo1xCompress } from 'lzo1x'
import { KeyedArchive, Real, type UID } from './bplist'
import { SRGB_ICC_BASE64 } from './srgbIcc'

export const TILE = 256

export const BLEND_NORMAL = 0
export const BLEND_MULTIPLY = 1

export interface LayerInput {
  name: string
  /** Straight-alpha RGBA, top-down rows; null for an empty layer. */
  pixels: Uint8ClampedArray | null
  hidden?: boolean
  locked?: boolean
  blend?: number
  opacity?: number
}

export interface ProcreateInput {
  name: string
  width: number
  height: number
  /** Top-most layer first, the same order Procreate shows in the Layers panel. */
  layers: LayerInput[]
  /** Index into `layers` of the layer selected when the file opens. */
  selected: number
  /** Straight-alpha RGBA of the flattened visible image, top-down. */
  composite: Uint8ClampedArray
  thumbnailPng: Uint8Array
}

interface EncodedLayer {
  files: Record<string, Uint8Array>
  rect: [number, number, number, number] | null
}

export function tileGrid(width: number, height: number) {
  return { cols: Math.ceil(width / TILE), rows: Math.ceil(height / TILE) }
}

/**
 * Procreate stores tiles bottom-up: tile row 0 and the first pixel row of each tile are the
 * bottom of the image. Pixels are premultiplied RGBA; fully transparent tiles are omitted.
 */
export function encodeTiles(pixels: Uint8ClampedArray, width: number, height: number): EncodedLayer {
  const { cols, rows } = tileGrid(width, height)
  const files: Record<string, Uint8Array> = {}
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * TILE, yb0 = row * TILE
      const tw = Math.min(TILE, width - x0), th = Math.min(TILE, height - yb0)
      const tile = new Uint8Array(tw * th * 4)
      let any = false
      for (let ty = 0; ty < th; ty++) {
        const srcRow = height - 1 - (yb0 + ty)
        for (let tx = 0; tx < tw; tx++) {
          const s = (srcRow * width + x0 + tx) * 4
          const a = pixels[s + 3]!
          if (a === 0) continue
          any = true
          const d = (ty * tw + tx) * 4
          tile[d] = Math.round(pixels[s]! * a / 255)
          tile[d + 1] = Math.round(pixels[s + 1]! * a / 255)
          tile[d + 2] = Math.round(pixels[s + 2]! * a / 255)
          tile[d + 3] = a
          const x = x0 + tx, y = yb0 + ty
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      if (any) files[`${col}~${row}.chunk`] = lzo1xCompress(tile)
    }
  }
  return { files, rect: maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1] }
}

function f64(values: number[]) {
  const dv = new DataView(new ArrayBuffer(values.length * 8))
  values.forEach((v, i) => dv.setFloat64(i * 8, v, true))
  return new Uint8Array(dv.buffer)
}

function f32(values: number[]) {
  const dv = new DataView(new ArrayBuffer(values.length * 4))
  values.forEach((v, i) => dv.setFloat32(i * 4, v, true))
  return new Uint8Array(dv.buffer)
}

const IDENTITY = f64([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function base64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function newUUID() {
  return crypto.randomUUID().toUpperCase()
}

export function buildProcreate(input: ProcreateInput): { bytes: Uint8Array, uuids: string[] } {
  const { width, height } = input
  const ar = new KeyedArchive()
  const docUid = ar.reserve()
  const layerCls = ar.cls(['SilicaLayer', 'ValkyrieLayer', 'NSObject'])
  const dictCls = ar.cls(['NSDictionary', 'NSObject'])
  const keyUids = ['flags', 'value', 'timescale', 'epoch'].map(k => ar.add(k))
  const zero = ar.add(0)

  const zip: Zippable = {}

  const silicaLayer = (opts: {
    type: number
    uuid: string
    name: string | null
    rect: [number, number, number, number] | null
    rectValidWhenEmpty?: boolean
    hidden?: boolean
    locked?: boolean
    blend?: number
    opacity?: number
  }): UID => {
    const uid = ar.reserve()
    const blend = opts.blend ?? BLEND_NORMAL
    ar.set(uid, {
      $class: layerCls,
      animationHeldLength: 0,
      blend,
      bundledImagePath: KeyedArchive.NULL,
      bundledMaskPath: KeyedArchive.NULL,
      bundledVideoPath: KeyedArchive.NULL,
      clipped: false,
      contentsRect: ar.add(f64(opts.rect ?? [0, 0, 0, 0])),
      contentsRectValid: opts.rect ? true : (opts.rectValidWhenEmpty ?? false),
      document: docUid,
      extendedBlend: blend,
      extendedBlend2: blend,
      hidden: opts.hidden ?? false,
      locked: opts.locked ?? false,
      mask: KeyedArchive.NULL,
      name: opts.name === null ? KeyedArchive.NULL : ar.add(opts.name),
      opacity: new Real(opts.opacity ?? 1),
      perspectiveAssisted: false,
      preserve: false,
      private: false,
      sizeHeight: height,
      sizeWidth: width,
      text: KeyedArchive.NULL,
      textPDF: KeyedArchive.NULL,
      textureSet: KeyedArchive.NULL,
      transform: ar.add(IDENTITY),
      type: opts.type,
      UUID: ar.add(opts.uuid),
      version: 4,
      videoTime: ar.add({ '$class': dictCls, 'NS.keys': keyUids, 'NS.objects': [zero, zero, zero, zero] }),
    })
    return uid
  }

  const uuids = input.layers.map(() => newUUID())
  const layerUids = input.layers.map((layer, i) => {
    const uuid = uuids[i]!
    let rect: EncodedLayer['rect'] = null
    if (layer.pixels) {
      const enc = encodeTiles(layer.pixels, width, height)
      rect = enc.rect
      for (const [file, data] of Object.entries(enc.files)) zip[`${uuid}/${file}`] = data
    }
    return silicaLayer({ type: 0, uuid, name: layer.name, rect, hidden: layer.hidden, locked: layer.locked, blend: layer.blend, opacity: layer.opacity })
  })

  const arrayCls = ar.cls(['NSArray', 'NSObject'])
  const mutableArrayCls = ar.cls(['NSMutableArray', 'NSArray', 'NSObject'])
  const unwrapped = ar.add({ '$class': arrayCls, 'NS.objects': layerUids })
  const layers = ar.add({ '$class': mutableArrayCls, 'NS.objects': layerUids })

  const compositeUuid = newUUID()
  const compositeEnc = encodeTiles(input.composite, width, height)
  for (const [file, data] of Object.entries(compositeEnc.files)) zip[`${compositeUuid}/${file}`] = data
  const composite = silicaLayer({ type: 1, uuid: compositeUuid, name: null, rect: null })
  const docMask = silicaLayer({ type: 2, uuid: newUUID(), name: null, rect: null, rectValidWhenEmpty: true })

  const savedMasks = ar.add({ '$class': mutableArrayCls, 'NS.objects': [] })
  const bgColor = ar.add(f32([1, 1, 1, 1]))
  const bgHsba = ar.add(f32([0, 0, 1, 1]))
  const colorProfile = ar.add({
    $class: ar.cls(['ValkyrieColorProfile', 'NSObject']),
    SiColorProfileArchiveICCDataKey: base64ToBytes(SRGB_ICC_BASE64),
    SiColorProfileArchiveICCNameKey: ar.add('sRGB IEC61966-2.1'),
  })
  const animation = ar.add({
    $class: ar.cls(['ValkyrieDocumentAnimation', 'NSObject']),
    animationMode: 0,
    frameRate: 15,
    onionSkinCount: 12,
    onionSkinOpacity: new Real(0.6),
    playbackDirection: 0,
    playbackMode: 1,
    primaryMixed: false,
  })
  const quality = ar.add('pro50.vqGood')
  const resolution = ar.add('pro50.vr1080')
  const videoInfo = ar.add({
    $class: ar.cls(['VideoSegmentInfo', 'NSObject']),
    bitrate: ar.add(3240000),
    codec: 1,
    codec2020: 1,
    colorSpace: 1,
    frameSize: ar.add('{1080, 1080}'),
    framesPerSecond: 30,
    qualityPreferenceKey: quality,
    resolutionPreferenceKey: resolution,
    sourceOrientation: 1,
  })
  const selected = layerUids[input.selected] ?? layerUids[0]!

  ar.set(docUid, {
    $class: ar.cls(['SilicaDocument', 'ValkyrieDocument', 'NSObject']),
    animation,
    authorName: KeyedArchive.NULL,
    backgroundColor: bgColor,
    backgroundColorHSBA: bgHsba,
    backgroundHidden: false,
    colorProfile,
    composite,
    drawingguide: KeyedArchive.NULL,
    faceBackgroundHidden: false,
    featureSet: 1,
    flippedHorizontally: false,
    flippedVertically: false,
    isFirstItemAnimationForeground: false,
    isLastItemAnimationBackground: false,
    layers,
    mask: docMask,
    name: ar.add(input.name),
    orientation: 1,
    primaryItem: selected,
    reference3D: false,
    referenceAnchor: 0,
    referenceCorner: 0,
    referenceDocked: false,
    referenceOrientation: 0,
    referenceSize: ar.add('{0, 0}'),
    referenceVisibility: false,
    selectedLayer: selected,
    selectedSamplerLayer: KeyedArchive.NULL,
    SilicaDocumentArchiveDPIKey: new Real(300),
    SilicaDocumentArchiveUnitKey: 0,
    SilicaDocumentTrackedTimeKey: new Real(0),
    SilicaDocumentVideoPurgedKey: false,
    SilicaDocumentVideoSegmentInfoKey: videoInfo,
    size: ar.add(`{${width}, ${height}}`),
    solo: KeyedArchive.NULL,
    strokeCount: ar.add(0),
    tileSize: TILE,
    unwrappedLayers: unwrapped,
    userSavedSelectionMasks: savedMasks,
    version: 2,
    videoCodec2020Key: 1,
    videoCodecKey: 1,
    videoEnabled: false,
    videoQualityKey: quality,
    videoResolutionKey: resolution,
  })

  zip['Document.archive'] = ar.encode(docUid)
  zip['QuickLook/Thumbnail.png'] = [input.thumbnailPng, { level: 0 }]
  return { bytes: zipSync(zip, { level: 6 }), uuids }
}
