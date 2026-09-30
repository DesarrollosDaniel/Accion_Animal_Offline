import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { imageMime } from './image-mime.mjs'

test('reconoce una foto histórica sin extensión por su contenido', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aa-image-mime-'))
  const file = path.join(directory, '1725386818')
  try {
    await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    assert.equal(await imageMime(file), 'image/jpeg')
    await writeFile(file, 'texto')
    assert.equal(await imageMime(file), null)
  } finally {
    await unlink(file).catch(() => {})
    await rmdir(directory)
  }
})
