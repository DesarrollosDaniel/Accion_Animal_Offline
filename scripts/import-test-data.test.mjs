import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('rechaza un origen que no sea el proyecto Supabase de pruebas', () => {
  const script = fileURLToPath(new URL('./import-test-data.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--apply'], {
    env: {
      ...process.env,
      AA_TEST_DB_URL: 'postgresql://postgres@db.proyecto-real.supabase.co/postgres',
      AA_DB_PASSWORD: 'contraseña-ficticia',
    },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /El origen debe ser el proyecto Supabase de pruebas/)
})

test('identifica la URI directa que no resuelve en esta PC', () => {
  const script = fileURLToPath(new URL('./import-test-data.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--check'], {
    env: {
      ...process.env,
      AA_TEST_DB_URL: 'postgresql://postgres@db.wuenfwsjifwuupfjgubm.supabase.co:5432/postgres',
      AA_DB_PASSWORD: 'contraseña-ficticia',
    },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /elige Session pooler/)
})
