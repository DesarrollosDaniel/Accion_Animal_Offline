import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalAuth, passwordHash, passwordMatches } from './local-auth.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const password = 'Solo-prueba-123!'
const salt = '0123456789abcdef0123456789abcdef'
const hash = await passwordHash(password, salt)
const credential = { user_id: id, email: 'prueba@example.test', password_salt: salt, password_hash: hash,
  valid_until: new Date(Date.now() + 3600000), is_active: true, role: 'veterinarian', display_name: 'Prueba' }

test('scrypt verifica la contraseña y rechaza contraseña distinta o hash corrupto', async () => {
  assert.equal(await passwordMatches(password, credential), true)
  assert.equal(await passwordMatches('incorrecta', credential), false)
  assert.equal(await passwordMatches(password, { ...credential, password_hash: 'invalid' }), false)
})

test('el acceso y la reconfirmación local no consultan internet ni permiten cambiar de cuenta', async () => {
  const authenticate = createLocalAuth({ query: async () => ({ rows: [credential] }) }, 'https://example.test', 'public-key',
    async () => { throw new Error('No debe consultar internet') })
  const result = await authenticate({ email: ' PRUEBA@example.test ', password }, 'local', id)
  assert.equal(result.userId, id)
  assert.equal(result.cloudSession, null)
  assert.equal((await authenticate({ email: credential.email, password }, 'local', id)).userId, id)
  await assert.rejects(authenticate({ email: credential.email, password }, 'local', 'otra-cuenta'), { status: 401 })
})

test('el acceso local rechaza cuentas inactivas, vencidas, inexistentes y claves incorrectas', async () => {
  for (const row of [null, { ...credential, is_active: false }, { ...credential, valid_until: new Date(0) }]) {
    const authenticate = createLocalAuth({ query: async () => ({ rows: row ? [row] : [] }) }, 'https://example.test', 'public-key')
    await assert.rejects(authenticate({ email: credential.email, password }, 'local', id), { status: 401 })
  }
  const authenticate = createLocalAuth({ query: async () => ({ rows: [credential] }) }, 'https://example.test', 'public-key')
  await assert.rejects(authenticate({ email: credential.email, password: 'incorrecta' }, 'local', id), { status: 401 })
})

test('limita intentos fallidos y valida entradas antes de consultar la base', async () => {
  let calls = 0
  const authenticate = createLocalAuth({ query: async () => { calls++; return { rows: [] } } }, 'https://example.test', 'public-key')
  await assert.rejects(authenticate({ email: 'mal', password }, 'local'), { status: 400 })
  assert.equal(calls, 0)
  for (let i = 0; i < 5; i++) await assert.rejects(authenticate({ email: credential.email, password }, 'local', id), { status: 401 })
  await assert.rejects(authenticate({ email: credential.email, password }, 'local', id), { status: 429 })
  assert.equal(calls, 5)
})

test('un rechazo de Supabase no acepta la contraseña local ni destruye las credenciales', async () => {
  const authenticate = createLocalAuth({ query: async () => { throw new Error('No debe consultar credenciales locales') } },
    'https://example.test', 'public-key', async () => new Response(JSON.stringify({ code: 'invalid_credentials', msg: 'Invalid login credentials' }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(authenticate({ email: credential.email, password }, 'local'), { status: 401 })
})

test('si Supabase no está disponible, el ingreso verifica automáticamente la clave local', async () => {
  let requests = 0
  const authenticate = createLocalAuth({ query: async () => ({ rows: [credential] }) },
    'https://example.test', 'public-key', async (_url, init) => {
      requests++
      assert.ok(init.signal instanceof AbortSignal)
      return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })
    })
  const result = await authenticate({ email: credential.email, password }, 'local')
  assert.equal(result.userId, id)
  assert.equal(result.cloudSession, null)
  assert.equal(requests, 1)
  await assert.rejects(authenticate({ email: credential.email, password: 'incorrecta' }, 'local'), { status: 401 })
})

test('un acceso online validado guarda solo el hash y renueva la misma identidad', async () => {
  const calls = []
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT') ? [credential] : [] } } }
  const authenticate = createLocalAuth(pool, 'https://example.test', 'public-key', async (url) => {
    const data = String(url).includes('/token')
      ? { access_token: 'token-test', refresh_token: 'refresh-test', token_type: 'bearer', expires_in: 3600, user: { id } }
      : { id, role: credential.role, display_name: 'Prueba', is_active: true }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  })
  const result = await authenticate({ email: credential.email, password }, 'local')
  assert.equal(result.userId, id)
  assert.equal(result.cloudSession.access_token, 'token-test')
  const insert = calls.find((call) => call.sql.includes('INSERT INTO aa_local.login_credentials'))
  assert.equal(insert.values.includes(password), false)
  assert.equal(await passwordMatches(password, { password_salt: insert.values[2], password_hash: insert.values[3] }), true)
})
