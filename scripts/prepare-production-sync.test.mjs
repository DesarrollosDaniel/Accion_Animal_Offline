import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('la preparación de producción rechaza un host ajeno antes de aplicar migraciones', () => {
  const result = spawnSync(process.execPath, ['scripts/prepare-production-sync.mjs', '--apply'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: {
      ...process.env, AA_MODE: 'production', AA_DB_NAME: 'accion_animal_produ', AA_STORAGE_ROOT: 'uploaded/production',
      VITE_SUPABASE_URL: 'https://hvfubwyzarikudisbwfy.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'ficticia',
      AA_PROD_DB_HOST: 'otro.example.com', AA_PROD_DB_PASSWORD: 'ficticia',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Faltan host o contraseña/)
})
