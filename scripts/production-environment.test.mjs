import test from 'node:test'
import assert from 'node:assert/strict'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'

test('producción exige URL, base local y almacenamiento del mismo entorno', () => {
  const env = {
    AA_MODE: 'production', AA_DB_NAME: 'accion_animal_produ', AA_STORAGE_ROOT: 'uploaded/production',
    VITE_SUPABASE_URL: `https://${productionRef}.supabase.co`, VITE_SUPABASE_PUBLISHABLE_KEY: 'clave-ficticia',
  }
  assert.doesNotThrow(() => assertProductionEnvironment(env))
  for (const [key, value] of [['AA_DB_NAME', 'accion_animal_dev'], ['VITE_SUPABASE_URL', 'https://wuenfwsjifwuupfjgubm.supabase.co'], ['AA_STORAGE_ROOT', 'uploaded']]) {
    assert.throws(() => assertProductionEnvironment({ ...env, [key]: value }), /Configuración de PRODUCCIÓN/)
  }
})
