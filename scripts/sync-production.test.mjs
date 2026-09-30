import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('la sincronización de producción rechaza un host ajeno antes de conectarse', () => {
  const result = spawnSync(process.execPath, ['scripts/sync-production.mjs', '--once'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: {
      ...process.env, AA_MODE: 'production', AA_DB_NAME: 'accion_animal_produ', AA_STORAGE_ROOT: 'uploaded',
      VITE_SUPABASE_URL: 'https://hvfubwyzarikudisbwfy.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'ficticia',
      AA_DB_PASSWORD: 'ficticia', AA_PROD_WORKER_PASSWORD: 'ficticia', AA_PROD_DB_HOST: 'otro.example.com',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /host de Session pooler/)
})
