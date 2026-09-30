import { open } from 'node:fs/promises'

export async function imageMime(filePath) {
  const file = await open(filePath, 'r')
  const bytes = Buffer.alloc(12)
  let length
  try {
    const result = await file.read(bytes, 0, bytes.length, 0)
    length = result.bytesRead
  } finally {
    await file.close()
  }
  if (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  return null
}
