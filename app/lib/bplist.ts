export class UID { constructor(public readonly value: number) {} }
export class Real { constructor(public readonly value: number) {} }

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Real
  | UID
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue }

type Flat =
  | { kind: 'bool', v: boolean }
  | { kind: 'int', v: number }
  | { kind: 'real', v: number }
  | { kind: 'str', v: string }
  | { kind: 'data', v: Uint8Array }
  | { kind: 'uid', v: number }
  | { kind: 'array', refs: number[] }
  | { kind: 'dict', keys: number[], vals: number[] }

class ByteWriter {
  private buf = new Uint8Array(1024)
  length = 0
  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }

  byte(b: number) { this.ensure(1); this.buf[this.length++] = b & 0xFF }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.length); this.length += b.length }
  uintBE(v: number, size: number) {
    for (let i = size - 1; i >= 0; i--) this.byte(Number((BigInt(v) >> BigInt(i * 8)) & 0xFFn))
  }

  result() { return this.buf.slice(0, this.length) }
}

function intSize(v: number) {
  if (v < 0) return 8
  if (v <= 0xFF) return 1
  if (v <= 0xFFFF) return 2
  if (v <= 0xFFFFFFFF) return 4
  return 8
}

export function encodeBplist(root: PlistValue): Uint8Array {
  const objects: Flat[] = []
  const flatten = (v: PlistValue): number => {
    const idx = objects.length
    if (v === null) throw new Error('bplist: null is not representable; use "$null" in archives')
    if (typeof v === 'boolean') objects.push({ kind: 'bool', v })
    else if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error(`bplist: non-integer ${v} must be wrapped in Real`)
      objects.push({ kind: 'int', v })
    }
    else if (typeof v === 'string') objects.push({ kind: 'str', v })
    else if (v instanceof Real) objects.push({ kind: 'real', v: v.value })
    else if (v instanceof UID) objects.push({ kind: 'uid', v: v.value })
    else if (v instanceof Uint8Array) objects.push({ kind: 'data', v })
    else if (Array.isArray(v)) {
      const node: Flat = { kind: 'array', refs: [] }
      objects.push(node)
      for (const item of v) node.refs.push(flatten(item))
    }
    else {
      const node: Flat = { kind: 'dict', keys: [], vals: [] }
      objects.push(node)
      const entries = Object.entries(v)
      for (const [k] of entries) node.keys.push(flatten(k))
      for (const [, val] of entries) node.vals.push(flatten(val))
    }
    return idx
  }
  flatten(root)

  const refSize = intSize(objects.length)
  const w = new ByteWriter()
  for (const c of 'bplist00') w.byte(c.charCodeAt(0))
  const offsets: number[] = []

  const marker = (type: number, count: number) => {
    if (count < 15) { w.byte(type | count); return }
    w.byte(type | 0x0F)
    const s = intSize(count)
    w.byte(0x10 | Math.log2(s))
    w.uintBE(count, s)
  }

  for (const o of objects) {
    offsets.push(w.length)
    switch (o.kind) {
      case 'bool': w.byte(o.v ? 0x09 : 0x08); break
      case 'int': {
        const s = intSize(o.v)
        w.byte(0x10 | Math.log2(s))
        if (o.v < 0) {
          const dv = new DataView(new ArrayBuffer(8))
          dv.setBigInt64(0, BigInt(o.v))
          w.bytes(new Uint8Array(dv.buffer))
        }
        else w.uintBE(o.v, s)
        break
      }
      case 'real': {
        w.byte(0x23)
        const dv = new DataView(new ArrayBuffer(8))
        dv.setFloat64(0, o.v)
        w.bytes(new Uint8Array(dv.buffer))
        break
      }
      case 'str': {
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7F]*$/.test(o.v)) {
          marker(0x50, o.v.length)
          for (let i = 0; i < o.v.length; i++) w.byte(o.v.charCodeAt(i))
        }
        else {
          marker(0x60, o.v.length)
          for (let i = 0; i < o.v.length; i++) w.uintBE(o.v.charCodeAt(i), 2)
        }
        break
      }
      case 'data': marker(0x40, o.v.length); w.bytes(o.v); break
      case 'uid': {
        const s = intSize(o.v)
        w.byte(0x80 | (s - 1))
        w.uintBE(o.v, s)
        break
      }
      case 'array':
        marker(0xA0, o.refs.length)
        for (const r of o.refs) w.uintBE(r, refSize)
        break
      case 'dict':
        marker(0xD0, o.keys.length)
        for (const r of o.keys) w.uintBE(r, refSize)
        for (const r of o.vals) w.uintBE(r, refSize)
        break
    }
  }

  const tableOffset = w.length
  const offSize = intSize(tableOffset)
  for (const off of offsets) w.uintBE(off, offSize)
  for (let i = 0; i < 6; i++) w.byte(0)
  w.byte(offSize)
  w.byte(refSize)
  w.uintBE(objects.length, 8)
  w.uintBE(0, 8)
  w.uintBE(tableOffset, 8)
  return w.result()
}

export class KeyedArchive {
  readonly objects: PlistValue[] = ['$null']
  private classes = new Map<string, UID>()

  static readonly NULL = new UID(0)

  add(value: PlistValue): UID {
    this.objects.push(value)
    return new UID(this.objects.length - 1)
  }

  reserve(): UID { return this.add('$null') }

  set(uid: UID, value: PlistValue) { this.objects[uid.value] = value }

  cls(chain: string[]): UID {
    const key = chain.join('/')
    let uid = this.classes.get(key)
    if (!uid) {
      uid = this.add({ $classes: chain, $classname: chain[0]! })
      this.classes.set(key, uid)
    }
    return uid
  }

  encode(root: UID): Uint8Array {
    return encodeBplist({
      $archiver: 'NSKeyedArchiver',
      $objects: this.objects,
      $top: { root },
      $version: 100000,
    })
  }
}
