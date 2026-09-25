import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalPool, handleLocalApi, saveVerifiedProfile } from './local-api.mjs'

const userId = '11111111-1111-4111-8111-111111111111'
const petId = '22222222-2222-4222-8222-222222222222'

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
}

async function request(path, { session = { userId, role: 'veterinarian' }, rows = [], method = 'GET', origin } = {}) {
  const calls = []
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('FROM aa_local.profiles')) return { rows: rows.profile || [{ role: 'veterinarian', is_active: true }] }
      if (sql.includes('SELECT id FROM aa_local.pets')) return { rows: rows.pet || [{ id: petId }] }
      if (sql.includes('FROM aa_local.pets')) return { rows: rows.pets || [] }
      return { rows: rows.children || [] }
    },
  }
  const res = response()
  await handleLocalApi({ method, headers: { host: 'localhost', origin } }, res, new URL(path, 'http://localhost'), pool, () => session)
  return { res, calls }
}

test('rechaza consultas sin sesión antes de tocar PostgreSQL', async () => {
  const { res, calls } = await request('/api/local/pets', { session: null })
  assert.equal(res.status, 401)
  assert.equal(calls.length, 0)
})

test('rechaza perfiles locales inactivos', async () => {
  const { res, calls } = await request('/api/local/pets', { rows: { profile: [{ role: 'veterinarian', is_active: false }] } })
  assert.equal(res.status, 403)
  assert.equal(calls.length, 1)
})

test('consulta mascotas con valores parametrizados y paginación acotada', async () => {
  const { res, calls } = await request('/api/local/pets?status=active&limit=20&offset=5', { rows: { pets: [{ id: petId }] } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data, [{ id: petId }])
  assert.deepEqual(calls[1].values, ['active', 20, 5])
  assert.equal(calls[1].sql.includes('aa_local.pets'), true)
})

test('rechaza identificadores y límites inválidos', async () => {
  assert.equal((await request('/api/local/pets/not-a-uuid')).res.status, 400)
  assert.equal((await request('/api/local/pets?limit=201')).res.status, 400)
  assert.equal((await request('/api/local/pets?status=active%27%20OR%201=1')).res.status, 400)
})

test('rechaza escrituras de recepción y de otro origen', async () => {
  const reception = await request('/api/local/pets', {
    method: 'POST', session: { userId, role: 'reception' },
    rows: { profile: [{ role: 'reception', is_active: true }] },
  })
  assert.equal(reception.res.status, 403)
  const crossOrigin = await request('/api/local/pets', { method: 'POST', origin: 'https://otro.example' })
  assert.equal(crossOrigin.res.status, 403)
  assert.equal(crossOrigin.calls.length, 1)
  const badPetId = await request('/api/local/pets/not-a-uuid/clinical-records', {
    method: 'POST', origin: 'http://localhost',
  })
  assert.equal(badPetId.res.status, 400)
  const badRecordId = await request('/api/local/clinical-records/not-a-uuid/files', {
    method: 'POST', origin: 'http://localhost',
  })
  assert.equal(badRecordId.res.status, 400)
  const badUpdateId = await request('/api/local/pets/not-a-uuid', {
    method: 'PATCH', origin: 'http://localhost',
  })
  assert.equal(badUpdateId.res.status, 400)
  const receptionUpdate = await request(`/api/local/pets/${petId}`, {
    method: 'PATCH', origin: 'http://localhost',
    session: { userId, role: 'reception' },
    rows: { profile: [{ role: 'reception', is_active: true }] },
  })
  assert.equal(receptionUpdate.res.status, 403)
  const badVaccinationId = await request('/api/local/vaccinations/not-a-uuid', {
    method: 'DELETE', origin: 'http://localhost',
  })
  assert.equal(badVaccinationId.res.status, 400)
  const badFileId = await request('/api/local/clinical-files/not-a-uuid', {
    method: 'DELETE', origin: 'http://localhost',
  })
  assert.equal(badFileId.res.status, 400)
  const crossOriginDelete = await request(`/api/local/vaccinations/${petId}`, {
    method: 'DELETE', origin: 'https://otro.example',
  })
  assert.equal(crossOriginDelete.res.status, 403)
})

test('no conecta si falta la contraseña y limita usuario, host y nombre de base', async () => {
  assert.equal(createLocalPool({}), null)
  assert.throws(() => createLocalPool({ AA_DB_PASSWORD: 'x', AA_DB_NAME: 'postgres' }), /AA_DB_NAME/)
  const pool = createLocalPool({ AA_DB_PASSWORD: 'x', AA_DB_NAME: 'accion_animal_dev' })
  assert.equal(pool.options.user, 'aa_local_app')
  assert.equal(pool.options.host, '127.0.0.1')
  await pool.end()
})

test('guarda el perfil verificado usando parámetros SQL', async () => {
  const calls = []
  await saveVerifiedProfile({ query: async (...args) => calls.push(args) }, {
    userId, displayName: 'Veterinaria', role: 'veterinarian',
  })
  assert.match(calls[0][0], /ON CONFLICT \(id\) DO UPDATE/)
  assert.deepEqual(calls[0][1], [userId, 'Veterinaria', 'veterinarian'])
})
