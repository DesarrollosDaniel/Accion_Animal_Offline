import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalAuth, passwordHash, passwordMatches } from './local-auth.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const password = 'Solo-prueba-123!'
const salt = '0123456789abcdef0123456789abcdef'
const credential = { user_id: id, email: 'prueba@example.test', password_salt: salt,
  password_hash: await passwordHash(password, salt), valid_until: new Date(0),
  is_active: true, role: 'owner', display_name: 'Prueba' }

test('el ingreso local acepta credenciales antiguamente vencidas sin consultar Supabase', async () => {
  const authenticate = createLocalAuth({ query: async () => ({ rows: [credential] }) })
  assert.equal((await authenticate({ email: ' PRUEBA@example.test ', password }, 'local')).userId, id)
  assert.equal((await authenticate({ email: credential.email, password }, 'local', id)).userId, id)
  await assert.rejects(authenticate({ email: credential.email, password }, 'local', 'otro-id'), { status: 401 })
})

test('rechaza cuentas inactivas y contraseñas incorrectas', async () => {
  const inactive = createLocalAuth({ query: async () => ({ rows: [{ ...credential, is_active: false }] }) })
  await assert.rejects(inactive({ email: credential.email, password }, 'local'), { status: 401 })
  const active = createLocalAuth({ query: async () => ({ rows: [credential] }) })
  await assert.rejects(active({ email: credential.email, password: 'incorrecta' }, 'local'), { status: 401 })
  assert.equal(await passwordMatches(password, credential), true)
  assert.equal(await passwordMatches(password, { ...credential, password_hash: 'invalid' }), false)
})

test('limita intentos y valida entradas antes de consultar la base', async () => {
  let calls = 0
  const authenticate = createLocalAuth({ query: async () => { calls++; return { rows: [] } } })
  await assert.rejects(authenticate({ email: 'mal', password }, 'local'), { status: 400 })
  assert.equal(calls, 0)
  for (let i = 0; i < 5; i++) await assert.rejects(authenticate({ email: credential.email, password }, 'local'), { status: 401 })
  await assert.rejects(authenticate({ email: credential.email, password }, 'local'), { status: 429 })
  assert.equal(calls, 5)
})
