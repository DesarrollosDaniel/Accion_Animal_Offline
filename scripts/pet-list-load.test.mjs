import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const helper = source.slice(source.indexOf('async function localPets()'), source.indexOf('const roleLabels'))
const load = new Function('localData', `${stripTypeScriptTypes(helper)}; return localPets()`)
const sortPets = (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)

test('carga tres páginas en paralelo y conserva las primeras 200 mascotas de cada vista', async () => {
  const all = ['active', 'inactive', 'deceased'].flatMap((status) =>
    Array.from({ length: 350 }, (_, index) => ({ id: `${status}-${String(index).padStart(3, '0')}`, status, created_at: `2026-09-${String(1 + index % 28).padStart(2, '0')}` })))
  const calls = []
  const pets = await load(async (path) => {
    calls.push(path)
    await Promise.resolve()
    assert.equal(calls.length, 3, 'Las tres consultas deben iniciar antes de esperar las respuestas')
    const params = new URL(path, 'http://localhost').searchParams
    assert.equal(params.get('limit'), '200')
    assert.equal(params.has('offset'), false)
    return all.filter((pet) => pet.status === params.get('status')).sort(sortPets).slice(0, 200)
  })
  assert.equal(pets.length, 600)
  for (const inactive of [false, true]) {
    const inView = (pet) => inactive ? pet.status !== 'active' : pet.status === 'active'
    assert.deepEqual(pets.filter(inView).slice(0, 200), all.filter(inView).sort(sortPets).slice(0, 200))
  }
})

test('maneja listas vacías y propaga errores sin mostrar una carga parcial', async () => {
  assert.deepEqual(await load(async () => []), [])
  await assert.rejects(load(async (path) => {
    if (path.includes('status=inactive')) throw new Error('Consulta fallida')
    return []
  }), /Consulta fallida/)
})
