import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('la importación de producción rechaza un host ajeno antes de conectarse', () => {
  const result = spawnSync(process.execPath, ['scripts/import-test-data.mjs', '--production', '--apply'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, AA_DB_PASSWORD: 'local-ficticia', AA_PROD_DB_PASSWORD: 'remota-ficticia', AA_PROD_DB_HOST: 'otro.example.com' },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AA_PROD_DB_HOST debe ser el host Session pooler/)
})
