import { inflateRawSync } from 'node:zlib'

// Just enough of a .zip reader to unpack a skill (.zip or .skill): stored and
// deflated files, read from the central directory.

export function unzip(buf: Buffer, maxBytes = 50 * 1024 * 1024): { name: string; data: Buffer }[] {
  // the end-of-central-directory record sits in the last 64 KB
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('That isn’t a zip file')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const out: { name: string; data: Buffer }[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip file is damaged')
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`${name} is packed in a way this can’t unpack`)
    total += data.length
    if (total > maxBytes) throw new Error('The zip is too big to be a skill')
    out.push({ name, data })
  }
  return out
}
