import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRemoteOperation, canonicalRow, sendPending, syncErrorCode, reviewConflict, resolveReviewedConflict, SyncConflict } from './local-sync.mjs'

const op = { id: '11111111-1111-4111-8111-111111111111', entity_id: '22222222-2222-4222-8222-222222222222', actor_id: '33333333-3333-4333-8333-333333333333', entity_table: 'pet_notes', action: 'INSERT', source_version: '1', payload: { id: '22222222-2222-4222-8222-222222222222', body: 'Ficticio' } }

test('el diagnóstico identifica fallos conocidos sin imprimir mensajes ni códigos arbitrarios', () => {
  assert.equal(syncErrorCode({ code: '28P01', message: 'password secret' }), '28P01')
  assert.equal(syncErrorCode({ code: '42P18', message: 'secret' }), '42P18')
  assert.equal(syncErrorCode({ code: '23503', detail: 'secret' }), '23503')
  assert.equal(syncErrorCode({ code: 'SECRET', message: 'postgresql://secret' }), 'UNKNOWN')
  assert.equal(syncErrorCode(new Error('Connection timeout')), 'ETIMEDOUT')
  assert.equal(syncErrorCode(new Error('role "secret" is not permitted to log in')), 'ROLE_NO_LOGIN')
  assert.equal(syncErrorCode(new Error('Tenant or user not found')), 'POOLER_USER_NOT_FOUND')
})

function remoteDatabase({ current = null, prior = [], children = [], receipt = null, failReceipt = false, active = true } = {}) {
  const calls = []
  const remote = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT * FROM aa_sync.receipts')) return { rows: receipt ? [receipt] : [] }
    if (sql.startsWith('SELECT snapshot, source_version FROM aa_sync.receipts')) return { rows: prior }
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: active }] }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: current ? [{ snapshot: current }] : [] }
    if (sql.startsWith('SELECT column_name')) return { rows: Object.keys(op.payload).map((column_name) => ({ column_name })) }
    if (sql.startsWith('SELECT id FROM public.')) return { rows: children }
    if (sql.startsWith('INSERT INTO aa_sync.receipts')) {
      if (failReceipt) throw new Error('receipt unavailable')
      return { rows: [] }
    }
    if (/^(INSERT|UPDATE|DELETE) .*public\./.test(sql)) return { rows: [{ id: op.entity_id, snapshot: op.payload }] }
    return { rows: [] }
  } }
  return { remote, calls }
}

test('compara versiones originales normalizando fechas y números sin omitir campos clínicos', () => {
  assert.equal(canonicalRow({ weight_kg: '12.00', updated_at: '2026-09-26T12:00:00+00:00', row_version: 2 }), canonicalRow({ updated_at: new Date('2026-09-26T12:00:00Z'), weight_kg: 12 }))
  assert.notEqual(canonicalRow({ body: 'Antes' }), canonicalRow({ body: 'Después' }))
})

test('escritura y confirmación remota son atómicas; un reintento no vuelve a escribir', async () => {
  const db = remoteDatabase()
  await applyRemoteOperation(db.remote, op)
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  assert.ok(db.calls.findIndex(({ sql }) => sql === 'SET LOCAL ROLE authenticated') < db.calls.findIndex(({ sql }) => sql.startsWith('INSERT INTO public.')))
  const inserted = db.calls.find(({ sql }) => sql.startsWith('INSERT INTO aa_sync.receipts'))
  const replay = remoteDatabase({ receipt: { fingerprint: inserted.values[4] } })
  assert.equal((await applyRemoteOperation(replay.remote, op)).replayed, true)
  assert.equal(replay.calls.some(({ sql }) => sql.startsWith('INSERT INTO public.')), false)
  const failed = remoteDatabase({ failReceipt: true })
  await assert.rejects(applyRemoteOperation(failed.remote, op), /receipt unavailable/)
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK')
})

test('no sobrescribe cambios remotos, actualizaciones antiguas sin base ni identidades revocadas', async () => {
  for (const [operation, settings] of [
    [{ ...op, action: 'UPDATE', payload: { ...op.payload, _sync_base: { ...op.payload, body: 'Original' } } }, { current: { ...op.payload, body: 'Cambio remoto' } }],
    [{ ...op, action: 'UPDATE' }, { current: op.payload }],
    [op, { active: false }],
    [op, { receipt: { fingerprint: 'otro' } }],
  ]) {
    const db = remoteDatabase(settings)
    await assert.rejects(applyRemoteOperation(db.remote, operation))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(db.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE) .*public\./.test(sql)), false)
  }
})

test('eliminar un padre no elimina hijos creados remotamente', async () => {
  const deletion = { ...op, entity_table: 'pets', action: 'DELETE' }
  const db = remoteDatabase({ current: op.payload, children: [{ id: 'nuevo-hijo' }] })
  await assert.rejects(applyRemoteOperation(db.remote, deletion), /relacionados/)
  assert.equal(db.calls.some(({ sql }) => sql.startsWith('DELETE FROM public.')), false)
})

test('la cola exige todas las dependencias y confirma localmente solo después del COMMIT remoto', async () => {
  const db = remoteDatabase()
  const calls = []
  let sent = false
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT op.*')) {
      assert.match(sql, /cascade_delete_operations/)
      assert.match(sql, /depends_on_operation_id/)
      if (!sent) { sent = true; return { rows: [op] } }
    }
    if (sql.startsWith('INSERT INTO aa_local.sync_confirmations')) assert.equal(db.calls.at(-1).sql, 'COMMIT')
    return { rows: [] }
  } }
  assert.equal((await sendPending(local, db.remote)).confirmed, 1)
  assert.equal(calls.filter(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_confirmations')).length, 1)
})

test('una respuesta perdida conserva el pendiente y el error no expone datos ni credenciales', async () => {
  const calls = []
  const local = { async query(sql, values) { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT op.*') ? [op] : [] } } }
  const remote = { async query() { throw new Error('SECRET_PASSWORD clinical data') } }
  const result = await sendPending(local, remote)
  assert.equal(result.pending, 1)
  assert.equal(calls.some(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_confirmations')), false)
  assert.equal(JSON.stringify(calls).includes('SECRET_PASSWORD'), false)
})

test('la revisión compara los cambios sin escribir en ninguna base', async () => {
  const db = remoteDatabase({ current: { ...op.payload, body: 'Original', updated_at: '2026-09-24T12:00:00Z' } })
  const local = { async query(sql) { assert.match(sql, /^SELECT/); return { rows: [{ ...op, action: 'UPDATE' }] } } }
  const review = await reviewConflict(local, db.remote, op.id)
  assert.deepEqual(review.differences, [{ field: 'body', supabase: 'Original', local: 'Ficticio' }])
  assert.equal(db.calls[0].sql, 'BEGIN READ ONLY')
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(db.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql)), false)
})
test('la resolución revisada confirma el cambio y se detiene si Supabase cambió después de revisar', async () => {
  const original = { ...op.payload, body: 'Original' }
  const operation = { ...op, action: 'UPDATE', payload: { ...op.payload, _sync_base: { ...original, body: 'Base antigua' } } }
  const calls = []
  const local = { async query(sql, values) { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT') ? [operation] : [] } } }
  const db = remoteDatabase({ current: original, prior: [{ snapshot: { ...original, body: 'Base antigua' }, source_version: '1' }] })
  const review = await reviewConflict(local, db.remote, op.id)
  assert.equal((await resolveReviewedConflict(local, db.remote, op.id, review.remote_hash)).confirmed, true)
  assert.equal(calls.some(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_confirmations')), true)
  const changed = remoteDatabase({ current: { ...original, body: 'Cambio posterior' } })
  await assert.rejects(resolveReviewedConflict(local, changed.remote, op.id, review.remote_hash))
  assert.equal(changed.calls.some(({ sql }) => sql.startsWith('UPDATE public.')), false)
})

test('recepción de perfiles revoca credenciales sin borrar historia; errores revierten todo', async () => {
  const { receiveProfiles, SyncConflict } = await import('./local-sync.mjs')
  const calls = []
  const row = { id: op.actor_id, display_name: 'Ficticio', role: 'owner', is_active: true, created_at: new Date(), updated_at: new Date() }
  const remote = { query: async () => ({ rows: [row] }) }
  const local = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] } } }
  assert.deepEqual(await receiveProfiles(local, remote), { profiles: 1 })
  assert.equal(calls.at(-1).sql, 'COMMIT')
  assert.ok(calls.some(({ sql }) => sql.startsWith('DELETE FROM aa_local.login_credentials')))
  assert.ok(!calls.some(({ sql }) => sql.startsWith('DELETE FROM aa_local.profiles')))
  assert.deepEqual(calls.find(({ sql }) => sql.includes('ANY($1')).values, [[op.actor_id]])
  calls.length = 0
  await assert.rejects(receiveProfiles(local, { query: async () => ({ rows: [{ ...row, role: 'admin' }] }) }), SyncConflict)
  assert.equal(calls.length, 0)
  await assert.rejects(receiveProfiles({ async query(sql) {
    calls.push({ sql })
    if (sql.startsWith('INSERT')) throw new Error('local failure')
    return { rows: [] }
  } }, remote), /local failure/)
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('comparación de mascotas solo lee, identifica pendientes y rechaza permisos o listas incompletas', async () => {
  const { comparePets } = await import('./local-sync.mjs')
  const calls = []
  const pet = { id: op.entity_id, name: 'Ficticia', updated_at: '2026-09-26T00:00:00Z', row_version: '2' }
  let active = true
  let oversized = false
  const local = { async query(sql) {
    calls.push(sql)
    if (sql.includes('SELECT id FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('FROM aa_local.pets')) return { rows: [{ snapshot: pet }] }
    if (sql.includes('SELECT DISTINCT entity_id')) return { rows: [{ entity_id: pet.id }] }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push(sql)
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: active }] }
    if (sql.includes('FROM public.pets')) return { rows: oversized ? Array(10001).fill({ snapshot: pet }) : [{ snapshot: { ...pet, name: 'Cambio remoto', updated_at: '2026-09-26T01:00:00Z' } }] }
    return { rows: [] }
  } }
  const result = await comparePets(local, remote)
  assert.deepEqual(result.differences, [{ id: pet.id, kind: 'different', fields: ['name'], local_pending: true }])
  assert.ok(!calls.some((sql) => /^(INSERT|UPDATE|DELETE|COMMIT)/.test(sql)))
  assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 2)
  active = false
  await assert.rejects(comparePets(local, remote), /permiso clínico/)
  active = true
  oversized = true
  await assert.rejects(comparePets(local, remote), /10000/)
})

test('recibir una mascota bloquea pendientes, conserva ausencias y aplica sin crear una salida', async () => {
  const { receivePet } = await import('./local-sync.mjs')
  const calls = []
  let pending = false
  let missing = false
  const pet = { id: op.entity_id, name: 'Cambio remoto', updated_at: '2026-09-26T00:00:00Z' }
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: pet.id, row_version: '5' }] }
    if (sql.includes('FROM aa_local.sync_operations')) return { rows: pending ? [{ id: op.id }] : [] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('information_schema.columns')) return { rows: Object.keys(pet).map((column_name) => ({ column_name })) }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push({ sql })
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: missing ? [] : [{ snapshot: pet }] }
    return { rows: [] }
  } }
  assert.equal((await receivePet(local, remote, pet.id)).received, true)
  assert.match(calls.find(({ sql }) => sql.startsWith('UPDATE')).sql, /remote_base_version = p.row_version \+ 1/)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('INSERT') || sql.startsWith('DELETE')))
  calls.length = 0
  pending = true
  await assert.rejects(receivePet(local, remote, pet.id), /pendientes/)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('UPDATE')))
  pending = false
  missing = true
  await assert.rejects(receivePet(local, remote, pet.id), /no se eliminará/)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('UPDATE')))
})

test('la edición posterior a una recepción usa su base remota; un recibo posterior vuelve a ser la referencia', async () => {
  const base = { ...op.payload, body: 'Recibido' }
  const operation = { ...op, entity_table: 'pets', action: 'UPDATE', source_version: '8',
    payload: { ...op.payload, remote_base: base, remote_base_version: '6' } }
  const old = remoteDatabase({ current: base, prior: [{ snapshot: { ...base, body: 'Antes' }, source_version: '4' }] })
  await applyRemoteOperation(old.remote, operation)
  const insert = old.calls.find(({ sql }) => sql.startsWith('UPDATE public.'))
  assert.ok(!insert.sql.includes('remote_base'))
  const newer = { ...base, body: 'Después' }
  const db = remoteDatabase({ current: newer, prior: [{ snapshot: newer, source_version: '7' }] })
  await applyRemoteOperation(db.remote, operation)
  const changed = remoteDatabase({ current: { ...newer, body: 'Conflicto' }, prior: [{ snapshot: newer, source_version: '7' }] })
  await assert.rejects(applyRemoteOperation(changed.remote, operation))
})

test('recepción automática usa lotes, omite pendientes y ausencias y no escribe filas iguales', async () => {
  const { receivePetBatch } = await import('./local-sync.mjs')
  const calls = []
  const a = { id: op.entity_id, name: 'A', updated_at: '2026-09-26T00:00:00Z' }
  const b = { id: op.actor_id, name: 'B' }
  const missing = { id: op.id, name: 'Solo local' }
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('LIMIT 50')) return { rows: [{ snapshot: a, pending: false }, { snapshot: b, pending: true }, { snapshot: missing, pending: false }] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    return { rows: [] }
  } }
  const remote = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.includes('ANY($1')) return { rows: [{ snapshot: { ...a, updated_at: '2026-09-26T01:00:00Z' } }, { snapshot: { ...b, name: 'Cambio protegido' } }] }
    return { rows: [] }
  } }
  assert.deepEqual(await receivePetBatch(local, remote), { checked: 3, received: 0, protected: 1, cursor: null })
  assert.ok(!calls.some(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql)))
  assert.ok(calls.find(({ sql }) => sql.includes('ANY($1')).values[0].includes(a.id))
})

test('el lote vuelve a comprobar pendientes bajo bloqueo antes de importar y conserva el cursor al avanzar', async () => {
  const { receivePetBatch } = await import('./local-sync.mjs')
  const calls = []
  const pet = { id: op.entity_id, name: 'Local' }
  let concurrentPending = true
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('LIMIT 50')) return { rows: [{ snapshot: pet, pending: false }] }
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...pet, row_version: '5' }] }
    if (sql.includes('FROM aa_local.sync_operations')) return { rows: concurrentPending ? [{ id: op.id }] : [] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('information_schema.columns')) return { rows: Object.keys(pet).map((column_name) => ({ column_name })) }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push({ sql })
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: [{ snapshot: { ...pet, name: 'Remoto' } }] }
    return { rows: [] }
  } }
  assert.equal((await receivePetBatch(local, remote)).protected, 1)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('UPDATE')))
  concurrentPending = false
  assert.equal((await receivePetBatch(local, remote)).received, 1)
  assert.ok(calls.some(({ sql }) => sql.startsWith('UPDATE aa_local.pets')))
  const page = Array.from({ length: 50 }, (_, i) => ({ snapshot: { ...pet, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }, pending: true }))
  const full = { async query(sql) { return { rows: sql.includes('LIMIT 50') ? page : [{ id: op.actor_id }] } } }
  assert.equal((await receivePetBatch(full, remote, op.id)).cursor, page.at(-1).snapshot.id)
  assert.equal((await receivePetBatch({ query: async () => ({ rows: [] }) }, remote, pet.id)).cursor, null)
})

test('alta recibida conserva UUID y referencia, no crea salida y continúa después de versiones antiguas', async () => {
  const { receivePet } = await import('./local-sync.mjs')
  const calls = []
  let pending = false
  const pet = { id: op.entity_id, name: 'Nueva ficticia', guardian_name: 'Tutor ficticio' }
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('FOR UPDATE')) return { rows: [] }
    if (sql.includes('SELECT id FROM aa_local.sync_operations')) return { rows: pending ? [{ id: op.id }] : [] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('information_schema.columns')) return { rows: Object.keys(pet).map((column_name) => ({ column_name })) }
    if (sql.includes('max(source_version)')) return { rows: [{ version: '8' }] }
    if (sql.startsWith('INSERT INTO aa_local.pets')) return { rows: [{ id: pet.id }] }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push({ sql })
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: [{ snapshot: pet }] }
    if (sql.includes('max(source_version)')) return { rows: [{ version: '10' }] }
    return { rows: [] }
  } }
  await assert.rejects(receivePet(local, remote, pet.id), /solo actualiza/)
  assert.equal((await receivePet(local, remote, pet.id, true, true)).received, true)
  const inserted = calls.find(({ sql }) => sql.startsWith('INSERT INTO aa_local.pets'))
  assert.equal(inserted.values[0], pet.id)
  assert.equal(inserted.values[2], '11')
  assert.match(inserted.sql, /WHERE cloud\.id = \$1::uuid/)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_operations')))
  calls.length = 0
  pending = true
  assert.equal((await receivePet(local, remote, pet.id, true, true)).received, false)
  assert.ok(!calls.some(({ sql }) => sql.startsWith('INSERT')))
})

test('descubrimiento de altas omite UUID conocidos y protege una eliminación local pendiente', async () => {
  const { receiveNewPetBatch } = await import('./local-sync.mjs')
  const known = op.actor_id
  const fresh = op.entity_id
  const calls = []
  const local = { async query(sql) {
    calls.push(sql)
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: known }] }
    if (sql.includes('ANY($1')) return { rows: [{ id: known }] }
    if (sql.includes('SELECT id FROM aa_local.sync_operations')) return { rows: [{ id: op.id }] }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push(sql)
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.startsWith('SELECT id FROM public.pets')) return { rows: [{ id: known }, { id: fresh }] }
    return { rows: [] }
  } }
  assert.deepEqual(await receiveNewPetBatch(local, remote), { checked: 2, received: 0, protected: 1, cursor: null })
  assert.ok(!calls.some((sql) => /^(INSERT|DELETE|UPDATE)/.test(sql)))
})

test('expedientes recibidos protegen pendientes, requieren mascota y conservan la base sin crear salida', async () => {
  const { receiveClinicalRecord, receiveClinicalRecordBatch } = await import('./local-sync.mjs')
  const record = { id: op.entity_id, pet_id: op.actor_id, history: 'Consulta ficticia', estimated_cost: '12.00' }
  let existing = null
  let pending = false
  let parent = true
  let parentDeleted = false
  let missing = false
  let failWrite = false
  const calls = []
  const local = { async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('FROM aa_local.clinical_records') && sql.includes('FOR UPDATE')) return { rows: existing ? [existing] : [] }
    if (sql.includes('FROM aa_local.pets') && sql.includes('FOR KEY SHARE')) return { rows: parent ? [{ id: record.pet_id }] : [] }
    if (sql.includes('SELECT id FROM aa_local.sync_operations')) return { rows: (sql.includes("entity_table = 'pets'") ? parentDeleted : pending) ? [{ id: op.id }] : [] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('information_schema.columns')) return { rows: Object.keys(record).map((column_name) => ({ column_name })) }
    if (sql.includes('max(source_version)')) return { rows: [{ version: '4' }] }
    if (/^(INSERT|UPDATE) INTO? ?aa_local.clinical_records/.test(sql) || sql.startsWith('UPDATE aa_local.clinical_records')) {
      if (failWrite) throw new Error('write failed')
      return { rows: [{ id: record.id }] }
    }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: missing ? [] : [{ snapshot: record }] }
    if (sql.includes('max(source_version)')) return { rows: [{ version: '6' }] }
    if (sql.startsWith('SELECT id FROM public.clinical_records')) return { rows: [{ id: record.id }] }
    return { rows: [] }
  } }
  assert.equal((await receiveClinicalRecord(local, remote, record.id)).received, true)
  const inserted = calls.find(({ sql }) => sql.startsWith('INSERT INTO aa_local.clinical_records'))
  assert.equal(inserted.values[2], '7')
  existing = { ...record, history: 'Original', row_version: '8' }
  calls.length = 0
  assert.equal((await receiveClinicalRecord(local, remote, record.id)).received, true)
  assert.match(calls.find(({ sql }) => sql.startsWith('UPDATE')).sql, /remote_base_version = p.row_version \+ 1/)
  for (const scenario of ['pending', 'parent', 'parentDeleted', 'unchanged', 'missing']) {
    calls.length = 0
    pending = scenario === 'pending'
    parent = scenario !== 'parent'
    parentDeleted = scenario === 'parentDeleted'
    missing = scenario === 'missing'
    existing = scenario === 'unchanged' ? { ...record, estimated_cost: 12, row_version: '8' } : null
    assert.equal((await receiveClinicalRecord(local, remote, record.id)).received, false)
    assert.ok(!calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql)))
  }
  pending = parentDeleted = missing = false
  parent = true
  existing = null
  assert.deepEqual(await receiveClinicalRecordBatch(local, remote), { checked: 1, received: 1, protected: 0, cursor: null })
  pending = true
  assert.equal((await receiveClinicalRecordBatch(local, remote)).protected, 1)
  pending = false
  failWrite = true
  await assert.rejects(receiveClinicalRecord(local, remote, record.id), /write failed/)
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!calls.some(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_operations')))
})

test('edición de un expediente recibido compara la nueva base aunque exista un recibo anterior', async () => {
  const base = { ...op.payload, body: 'Consulta recibida' }
  const operation = { ...op, entity_table: 'clinical_records', action: 'UPDATE', source_version: '8',
    payload: { ...op.payload, remote_base: base, remote_base_version: '6' } }
  const db = remoteDatabase({ current: base, prior: [{ snapshot: { ...base, body: 'Antes' }, source_version: '4' }] })
  await applyRemoteOperation(db.remote, operation)
  const changed = remoteDatabase({ current: { ...base, body: 'Cambio remoto posterior' } })
  await assert.rejects(applyRemoteOperation(changed.remote, operation), SyncConflict)
})

test('recursos clínicos reutilizan recepción protegida, referencias y validación de adjuntos', async () => {
  const { receiveClinicalBatch, clinicalResourceTables } = await import('./local-sync.mjs')
  const fixtures = {
    vaccinations: { vaccine_name: 'Ficticia', administered_on: '2026-09-26' },
    medications: { name: 'Ficticio', clinical_record_id: op.id },
    allergies: { allergen: 'Ficticio' },
    pet_notes: { body: 'Nota ficticia' },
    weight_records: { weight_kg: '12.00', measured_at: '2026-09-26T12:00:00Z' },
    clinical_files: { clinical_record_id: op.id, kind: 'document', bucket_id: 'clinical-files',
      object_path: 'uploaded/clinicos/prueba.pdf', original_name: 'prueba.pdf', mime_type: 'application/pdf', size_bytes: '0', checksum_sha256: null },
  }
  for (const table of clinicalResourceTables) {
    const snapshot = { id: op.entity_id, ...(table === 'clinical_files' ? {} : { pet_id: op.actor_id }), ...fixtures[table] }
    let existing = null
    let pending = false
    let missingParent = false
    let deletedParent = false
    let denied = false
    let schemaMismatch = false
    let mismatchPet = false
    let remoteMissing = false
    const calls = []
    const local = { async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('FOR UPDATE')) return { rows: existing ? [existing] : [] }
      if (sql.includes('FOR KEY SHARE')) return { rows: missingParent ? [] : [{ id: sql.includes('clinical_records') ? op.id : op.actor_id, pet_id: mismatchPet ? op.entity_id : op.actor_id }] }
      if (sql.includes('SELECT id FROM aa_local.sync_operations')) return { rows: (sql.includes(`entity_table = '${table}'`) ? pending : deletedParent) ? [{ id: op.id }] : [] }
      if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
      if (sql.includes('information_schema.columns')) return { rows: (schemaMismatch ? ['id'] : Object.keys(snapshot)).map((column_name) => ({ column_name })) }
      if (sql.includes('max(source_version)')) return { rows: [{ version: '3' }] }
      if (sql.startsWith(`INSERT INTO aa_local.${table}`)) return { rows: [{ id: snapshot.id }] }
      return { rows: [] }
    } }
    const remote = { async query(sql) {
      if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: !denied }] }
      if (sql.startsWith('SELECT id FROM public.')) return { rows: [{ id: snapshot.id }] }
      if (sql.startsWith('SELECT to_jsonb')) return { rows: remoteMissing ? [] : [{ snapshot }] }
      if (sql.includes('max(source_version)')) return { rows: [{ version: '8' }] }
      return { rows: [] }
    } }
    assert.equal((await receiveClinicalBatch(local, remote, table)).received, 1, table)
    assert.equal(calls.find(({ sql }) => sql.startsWith('INSERT')).values[2], '9')
    existing = { ...snapshot, row_version: '10', remote_base: snapshot, remote_base_version: '9' }
    assert.equal((await receiveClinicalBatch(local, remote, table)).received, 0)
    existing = { ...existing, ...(table === 'clinical_files' ? { original_name: 'antes.pdf' } : table === 'weight_records' ? { weight_kg: 11 } : { ...Object.fromEntries(Object.keys(fixtures[table]).filter((key) => !key.endsWith('_id')).map((key) => [key, null])) }) }
    calls.length = 0
    assert.equal((await receiveClinicalBatch(local, remote, table)).received, 1)
    assert.match(calls.find(({ sql }) => sql.startsWith('UPDATE')).sql, /remote_base_version = p.row_version \+ 1/)
    for (const scenario of ['pending', 'missingParent', 'deletedParent', 'remoteMissing']) {
      pending = scenario === 'pending'
      missingParent = scenario === 'missingParent'
      deletedParent = scenario === 'deletedParent'
      remoteMissing = scenario === 'remoteMissing'
      existing = null // also protect a deleted local UUID
      calls.length = 0
      assert.equal((await receiveClinicalBatch(local, remote, table)).protected, 1)
      assert.ok(!calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql)))
    }
    pending = missingParent = deletedParent = remoteMissing = false
    denied = true
    await assert.rejects(receiveClinicalBatch(local, remote, table), /permiso clínico/)
    denied = false
    schemaMismatch = true
    await assert.rejects(receiveClinicalBatch(local, remote, table), /esquema/)
    assert.equal(calls.at(-1).sql, 'ROLLBACK')
    schemaMismatch = false
    if (table === 'medications') {
      mismatchPet = true
      assert.equal((await receiveClinicalBatch(local, remote, table)).protected, 1)
    }
    if (table === 'clinical_files') {
      snapshot.object_path = 'uploaded/../privado.pdf'
      await assert.rejects(receiveClinicalBatch(local, remote, table), /Ruta/)
      assert.equal(calls.at(-1).sql, 'ROLLBACK')
    }
    assert.ok(!calls.some(({ sql }) => sql.startsWith('INSERT INTO aa_local.sync_operations')))
    const base = { ...op.payload, body: 'Referencia recibida' }
    const operation = { ...op, entity_table: table, action: 'UPDATE', source_version: '10', payload: { ...op.payload, remote_base: base, remote_base_version: '9' } }
    await applyRemoteOperation(remoteDatabase({ current: base, prior: [{ snapshot: { ...base, body: 'Anterior' }, source_version: '4' }] }).remote, operation)
    await assert.rejects(applyRemoteOperation(remoteDatabase({ current: { ...base, body: 'Cambio posterior' } }).remote, operation), SyncConflict)
  }
  let accessed = false
  await assert.rejects(receiveClinicalBatch({ query: async () => { accessed = true } }, {}, 'profiles'), /Recurso/)
  await assert.rejects(receiveClinicalBatch({ query: async () => { accessed = true } }, {}, 'pet_notes', 'invalid'), /Cursor/)
  assert.equal(accessed, false)
})

test('las fechas de vacunas conservan el día local al comparar con JSON remoto', () => {
  assert.equal(canonicalRow({ administered_on: new Date(2026, 8, 26), next_due_on: null }), canonicalRow({ administered_on: '2026-09-26', next_due_on: null }))
})

test('eliminaciones clínicas remotas quitan solo filas limpias y revalidan la ausencia bajo bloqueo', async () => {
  const { receiveDeletedBatch } = await import('./local-sync.mjs')
  const ids = [op.entity_id, op.actor_id, op.id]
  let pending = false
  let remoteExists = false
  let baseline = '4'
  let active = true
  const calls = []
  const local = { async query(sql) {
    calls.push(sql)
    if (sql.includes('ORDER BY id LIMIT 50')) return { rows: ids.map((id) => ({ id })) }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: op.entity_id, row_version: '4', remote_base_version: baseline }] }
    if (sql.includes('bool_or')) return { rows: [{ pending, confirmed_version: null }] }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    calls.push(sql)
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: active }] }
    if (sql.includes('ANY($1')) return { rows: [{ id: ids[1] }, { id: ids[2] }] }
    if (sql.startsWith('SELECT id FROM public.pet_notes WHERE id = $1')) return { rows: remoteExists ? [{ id: ids[0] }] : [] }
    return { rows: [] }
  } }
  assert.deepEqual(await receiveDeletedBatch(local, remote, 'pet_notes'), { checked: 3, deleted: 1, protected: 0, cursor: null })
  assert.equal(calls.filter((sql) => sql.startsWith('DELETE FROM aa_local.pet_notes')).length, 1)
  for (const scenario of ['pending', 'untracked', 'reappeared']) {
    calls.length = 0
    pending = scenario === 'pending'
    baseline = scenario === 'untracked' ? null : '4'
    remoteExists = scenario === 'reappeared'
    const result = await receiveDeletedBatch(local, remote, 'pet_notes')
    assert.equal(result.deleted, 0)
    assert.equal(result.protected, scenario === 'reappeared' ? 0 : 1)
    assert.ok(!calls.some((sql) => sql.startsWith('DELETE FROM aa_local.pet_notes')))
  }
  active = false
  await assert.rejects(receiveDeletedBatch(local, remote, 'pet_notes'), /permiso clínico/)
  assert.equal(calls.at(-1), 'ROLLBACK')
})

test('un padre remoto eliminado espera a que desaparezcan sus recursos vinculados', async () => {
  const { receiveDeletedBatch } = await import('./local-sync.mjs')
  let linked = true
  const calls = []
  const local = { async query(sql) {
    calls.push(sql)
    if (sql.includes('ORDER BY id LIMIT 50')) return { rows: [{ id: op.entity_id }] }
    if (sql.includes('FROM aa_local.profiles')) return { rows: [{ id: op.actor_id }] }
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: op.entity_id, row_version: '4', remote_base_version: '4' }] }
    if (sql.includes('bool_or')) return { rows: [{ pending: false, confirmed_version: null }] }
    if (sql.includes('AS linked')) return { rows: [{ linked }] }
    return { rows: [] }
  } }
  const remote = { async query(sql) {
    if (sql.startsWith('SELECT role')) return { rows: [{ role: 'owner', is_active: true }] }
    return { rows: [] }
  } }
  for (const table of ['clinical_records', 'pets']) {
    calls.length = 0
    linked = true
    assert.equal((await receiveDeletedBatch(local, remote, table)).protected, 1)
    assert.ok(!calls.some((sql) => sql.startsWith('DELETE')))
    linked = false
    assert.equal((await receiveDeletedBatch(local, remote, table)).deleted, 1)
    assert.equal(calls.filter((sql) => sql.startsWith(`DELETE FROM aa_local.${table}`)).length, 1)
  }
})
