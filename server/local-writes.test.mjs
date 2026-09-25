import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createClinicalRecord, createPetChild, createPetWithRelated, deleteLeafResource, deleteVaccination,
  registerClinicalFile, updateClinicalRecord, updatePet, updatePetNote,
  validateChildCreation, validateClinicalFile, validateClinicalRecordCreation,
  validatePatch, validatePetCreation,
} from './local-writes.mjs'

const actorId = '11111111-1111-4111-8111-111111111111'
const petId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const payload = {
  pet: { name: 'Luna', guardian_name: 'Tutora', sex: 'female' },
  vaccinations: [{ vaccine_name: 'Rabia', administered_on: '2026-09-24' }],
  note: 'Sin alergias conocidas',
}

function database({ failVaccination = false } = {}) {
  const calls = []
  let released = false
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (failVaccination && sql.includes('INSERT INTO aa_local.vaccinations')) {
        throw Object.assign(new Error('failed'), { code: '23514' })
      }
      if (sql.includes('INSERT INTO aa_local.pets')) return { rows: [{ id: petId, row_version: 1, name: 'Luna' }] }
      if (sql.includes('INSERT INTO aa_local.sync_operations')) return { rows: [{ id: operationId }] }
      if (sql.includes('INSERT INTO aa_local.vaccinations')) return { rows: [{ id: '44444444-4444-4444-8444-444444444444', row_version: 1 }] }
      if (sql.includes('INSERT INTO aa_local.pet_notes')) return { rows: [{ id: '55555555-5555-4555-8555-555555555555', row_version: 1 }] }
      return { rows: [] }
    },
    release() { released = true },
  }
  return { pool: { async connect() { return client } }, calls, wasReleased: () => released }
}

test('valida campos clínicos antes de abrir una transacción', () => {
  assert.throws(() => validatePetCreation({ pet: { ...payload.pet, row_version: 999 } }), /no permitido/)
  assert.throws(() => validatePetCreation({ pet: { ...payload.pet, sterilization_date: '2026-09-24' } }), /esterilización/)
  assert.throws(() => validatePetCreation({ ...payload, vaccinations: [{ vaccine_name: 'Rabia' }] }), /fecha/)
})

test('guarda mascota, vacuna, nota y tres operaciones pendientes en una transacción', async () => {
  const db = database()
  const pet = await createPetWithRelated(db.pool, actorId, payload)
  assert.equal(pet.id, petId)
  assert.equal(db.calls[0].sql, 'BEGIN')
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  assert.equal(db.calls.filter((call) => call.sql.includes('INSERT INTO aa_local.sync_operations')).length, 3)
  assert.equal(db.calls[1].values[0], actorId)
  const childOperations = db.calls.filter((call) => call.sql.includes('INSERT INTO aa_local.sync_operations')).slice(1)
  assert.deepEqual(childOperations.map((call) => call.values[5]), [operationId, operationId])
  assert.equal(db.wasReleased(), true)
})

test('deshace todos los cambios si falla una vacuna', async () => {
  const db = database({ failVaccination: true })
  await assert.rejects(createPetWithRelated(db.pool, actorId, payload), /failed/)
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(db.calls.some((call) => call.sql === 'COMMIT'), false)
  assert.equal(db.wasReleased(), true)
})

test('rechaza campos de expediente que el cliente no puede asignar', () => {
  const record = { occurred_at: '2026-09-24T12:30:00Z', history: 'Consulta' }
  assert.throws(() => validateClinicalRecordCreation({ record: { ...record, attended_by: actorId } }), /no permitido/)
  assert.throws(() => validateClinicalRecordCreation({ record: { ...record, estimated_cost: -1 } }), /estimated_cost/)
  assert.throws(() => validateClinicalRecordCreation({ record: { ...record, occurred_at: '2026-09-24T12:30' } }), /zona horaria/)
})

function clinicalDatabase({ missingPet = false, failWeight = false } = {}) {
  const calls = []
  let released = false
  const pool = {
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql, values })
          if (sql.includes('FOR KEY SHARE')) return { rows: missingPet ? [] : [{ id: petId }] }
          if (sql.includes("entity_table = 'pets'")) return { rows: [{ id: operationId }] }
          if (sql.includes('INSERT INTO aa_local.clinical_records')) {
            return { rows: [{ id: '66666666-6666-4666-8666-666666666666', row_version: 1, pet_id: petId }] }
          }
          if (sql.includes('INSERT INTO aa_local.weight_records')) {
            if (failWeight) throw Object.assign(new Error('invalid weight'), { code: '23514' })
            return { rows: [{ id: '77777777-7777-4777-8777-777777777777', row_version: 1 }] }
          }
          if (sql.includes('INSERT INTO aa_local.sync_operations')) return { rows: [{ id: '88888888-8888-4888-8888-888888888888' }] }
          return { rows: [] }
        },
        release() { released = true },
      }
    },
  }
  return { pool, calls, wasReleased: () => released }
}

const clinicalPayload = {
  record: { occurred_at: '2026-09-24T12:30:00Z', history: 'Consulta', vomiting: false },
  weight: { weight_kg: 12.5 },
}

test('expediente y peso generan operaciones dependientes en una transacción', async () => {
  const db = clinicalDatabase()
  const record = await createClinicalRecord(db.pool, actorId, petId, clinicalPayload)
  assert.equal(record.pet_id, petId)
  assert.equal(db.calls[0].sql, 'BEGIN')
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  const operations = db.calls.filter((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
  assert.deepEqual(operations.map((call) => call.values[0]), ['clinical_records', 'weight_records'])
  assert.equal(operations[0].values[5], operationId)
  assert.equal(operations[1].values[5], '88888888-8888-4888-8888-888888888888')
  assert.equal(db.wasReleased(), true)
})

test('expediente no se guarda cuando falta la mascota o falla el peso', async () => {
  const missing = clinicalDatabase({ missingPet: true })
  await assert.rejects(createClinicalRecord(missing.pool, actorId, petId, clinicalPayload), /Mascota no encontrada/)
  assert.equal(missing.calls.at(-1).sql, 'ROLLBACK')
  const failing = clinicalDatabase({ failWeight: true })
  await assert.rejects(createClinicalRecord(failing.pool, actorId, petId, clinicalPayload), /invalid weight/)
  assert.equal(failing.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(failing.calls.some((call) => call.sql === 'COMMIT'), false)
})

test('rechaza rutas de archivo fuera de uploaded', () => {
  const metadata = {
    kind: 'document', object_path: 'uploaded/clinicos/1/archivo.txt',
    original_name: 'archivo.txt', mime_type: 'text/plain', size_bytes: 4,
  }
  assert.throws(() => validateClinicalFile({ ...metadata, object_path: 'uploaded/../secreto.txt' }), /Ruta/)
  assert.throws(() => validateClinicalFile({ ...metadata, object_path: 'uploaded/clinicos\\secreto.txt' }), /Ruta/)
  assert.throws(() => validateClinicalFile({ ...metadata, original_name: '../secreto.txt' }), /Nombre/)
})

test('verifica el archivo físico y guarda checksum y operación en la misma transacción', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aa-clinical-file-test-'))
  const first = path.join(root, 'clinicos')
  const second = path.join(first, '1')
  const file = path.join(second, 'archivo.txt')
  await mkdir(second, { recursive: true })
  await writeFile(file, 'hola')
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('FOR KEY SHARE')) return { rows: [{ id: '66666666-6666-4666-8666-666666666666' }] }
      if (sql.includes("entity_table = 'clinical_records'")) return { rows: [{ id: operationId }] }
      if (sql.includes('INSERT INTO aa_local.clinical_files')) {
        return { rows: [{ id: '99999999-9999-4999-8999-999999999999', row_version: 1 }] }
      }
      if (sql.includes('INSERT INTO aa_local.sync_operations')) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { async connect() { return client } }
  const metadata = {
    kind: 'document', object_path: 'uploaded/clinicos/1/archivo.txt',
    original_name: 'archivo.txt', mime_type: 'text/plain', size_bytes: 4,
  }
  try {
    await assert.rejects(
      registerClinicalFile(pool, actorId, '66666666-6666-4666-8666-666666666666', { ...metadata, size_bytes: 5 }, root),
      /tamaño/,
    )
    assert.equal(calls.length, 0)
    const result = await registerClinicalFile(pool, actorId, '66666666-6666-4666-8666-666666666666', metadata, root)
    assert.equal(result.row_version, 1)
    const insert = calls.find((call) => call.sql.includes('INSERT INTO aa_local.clinical_files'))
    assert.equal(insert.values[6], createHash('sha256').update('hola').digest('hex'))
    const operation = calls.find((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
    assert.equal(operation.values[5], operationId)
    assert.equal(calls.at(-1).sql, 'COMMIT')
  } finally {
    await unlink(file)
    await rmdir(second)
    await rmdir(first)
    await rmdir(root)
  }
})

test('actualizaciones exigen versión y rechazan campos reservados', () => {
  assert.throws(() => validatePatch({ expected_version: 0, changes: { name: 'Luna' } }, 'pets'), /expected_version/)
  assert.throws(() => validatePatch({ expected_version: '1', changes: { row_version: 8 } }, 'pets'), /no permitido/)
  assert.throws(() => validatePatch({ expected_version: '1', changes: { pet_id: petId } }, 'clinical_records'), /no permitido/)
  assert.deepEqual(validatePatch({ expected_version: '2', changes: { name: 'Luna II' } }, 'pets'), {
    expectedVersion: '2', changes: { name: 'Luna II' },
  })
})

function updateDatabase({ found = true, exists = true, failOperation = false } = {}) {
  const calls = []
  let released = false
  const pool = {
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql, values })
          if (sql.startsWith('UPDATE aa_local.')) {
            return { rows: found ? [{ id: petId, row_version: 3, name: 'Luna II' }] : [] }
          }
          if (sql.startsWith('SELECT id FROM aa_local.pets')) return { rows: exists ? [{ id: petId }] : [] }
          if (sql.includes('ORDER BY source_version DESC')) return { rows: [{ id: operationId }] }
          if (sql.includes('INSERT INTO aa_local.sync_operations')) {
            if (failOperation) throw new Error('outbox failed')
            return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }
          }
          return { rows: [] }
        },
        release() { released = true },
      }
    },
  }
  return { pool, calls, wasReleased: () => released }
}

test('editar estado y nombre genera UPDATE pendiente con versión nueva', async () => {
  const db = updateDatabase()
  await updatePet(db.pool, actorId, petId, {
    expected_version: '2', changes: { status: 'inactive', name: 'Luna II' },
  })
  const update = db.calls.find((call) => call.sql.startsWith('UPDATE aa_local.pets'))
  assert.match(update.sql, /deactivated_at = CASE/)
  assert.match(update.sql, /deactivated_by = CASE[^]*\$5/)
  assert.deepEqual(update.values, [petId, '2', 'inactive', 'Luna II', actorId])
  const operation = db.calls.find((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
  assert.equal(operation.values[0], 'pets')
  assert.equal(operation.values[2], 3)
  assert.equal(operation.values[5], operationId)
  assert.equal(operation.values[6], 'UPDATE')
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  assert.equal(db.wasReleased(), true)
})

test('versión desactualizada o error en outbox deshacen la actualización', async () => {
  const stale = updateDatabase({ found: false })
  await assert.rejects(updatePet(stale.pool, actorId, petId, {
    expected_version: '1', changes: { name: 'Luna II' },
  }), /vuelve a cargarlo/)
  assert.equal(stale.calls.at(-1).sql, 'ROLLBACK')
  const failed = updateDatabase({ failOperation: true })
  await assert.rejects(updateClinicalRecord(failed.pool, actorId, petId, {
    expected_version: '2', changes: { history: 'Nueva historia' },
  }), /outbox failed/)
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(failed.calls.some((call) => call.sql === 'COMMIT'), false)
})

test('vacunas, notas y pesos rechazan valores fuera del formato esperado', () => {
  assert.throws(() => validateChildCreation('vaccinations', { vaccine_name: 'Rabia' }), /obligatorios/)
  assert.throws(() => validateChildCreation('pet_notes', { body: '  ' }), /body/)
  assert.throws(() => validateChildCreation('weight_records', {
    weight_kg: 0, measured_at: '2026-09-24T12:30:00Z',
  }), /weight_kg/)
  assert.throws(() => validateChildCreation('weight_records', {
    weight_kg: 12, measured_at: '2026-09-24T12:30:00Z', actor_id: actorId,
  }), /no permitido/)
})

function childDatabase({ stale = false } = {}) {
  const calls = []
  const vaccinationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('FROM aa_local.pets') && sql.includes('FOR KEY SHARE')) return { rows: [{ id: petId }] }
      if (sql.includes("entity_table = 'pets'")) return { rows: [{ id: operationId }] }
      if (sql.includes('INSERT INTO aa_local.pet_notes')) {
        return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', row_version: 1 }] }
      }
      if (sql.includes('SELECT * FROM aa_local.vaccinations')) {
        return { rows: [{ id: vaccinationId, pet_id: petId, row_version: stale ? '2' : '1' }] }
      }
      if (sql.includes('ORDER BY source_version DESC')) return { rows: [{ id: operationId }] }
      if (sql.includes('INSERT INTO aa_local.sync_operations')) return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] }
      return { rows: [] }
    },
    release() {},
  }
  return { pool: { async connect() { return client } }, calls, vaccinationId }
}

test('una nota nueva queda vinculada a la operación pendiente de su mascota', async () => {
  const db = childDatabase()
  await createPetChild(db.pool, actorId, petId, 'pet_notes', { body: 'Seguimiento' })
  const operation = db.calls.find((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
  assert.equal(operation.values[0], 'pet_notes')
  assert.equal(operation.values[5], operationId)
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
})

test('una nota existente admite edición con control de versión', async () => {
  const db = updateDatabase()
  await updatePetNote(db.pool, actorId, petId, {
    expected_version: '2', changes: { body: 'Seguimiento actualizado' },
  })
  assert.equal(db.calls.some((call) => call.sql.startsWith('UPDATE aa_local.pet_notes')), true)
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
})

test('borrar una vacuna crea una operación DELETE y rechaza versiones antiguas', async () => {
  const db = childDatabase()
  await deleteVaccination(db.pool, actorId, db.vaccinationId, { expected_version: '1' })
  assert.equal(db.calls.some((call) => call.sql.startsWith('DELETE FROM aa_local.vaccinations')), true)
  const operation = db.calls.find((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
  assert.equal(operation.values[0], 'vaccinations')
  assert.equal(operation.values[2], '2')
  assert.equal(operation.values[6], 'DELETE')
  assert.equal(db.calls.at(-1).sql, 'COMMIT')

  const stale = childDatabase({ stale: true })
  await assert.rejects(deleteVaccination(stale.pool, actorId, stale.vaccinationId, {
    expected_version: '1',
  }), /vuelve a cargarlo/)
  assert.equal(stale.calls.some((call) => call.sql.startsWith('DELETE FROM aa_local.vaccinations')), false)
  assert.equal(stale.calls.at(-1).sql, 'ROLLBACK')
})

test('borrar metadatos clínicos registra una lápida sin tocar archivos físicos', async () => {
  const fileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('SELECT * FROM aa_local.clinical_files')) {
        return { rows: [{ id: fileId, row_version: '1', object_path: 'uploaded/clinicos/archivo.pdf' }] }
      }
      if (sql.includes('ORDER BY source_version DESC')) return { rows: [{ id: operationId }] }
      if (sql.includes('INSERT INTO aa_local.sync_operations')) return { rows: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { async connect() { return client } }
  await deleteLeafResource(pool, actorId, 'clinical_files', fileId, { expected_version: '1' })
  assert.equal(calls.some((call) => call.sql.startsWith('DELETE FROM aa_local.clinical_files')), true)
  const operation = calls.find((call) => call.sql.includes('INSERT INTO aa_local.sync_operations'))
  assert.equal(operation.values[0], 'clinical_files')
  assert.equal(operation.values[4].object_path, 'uploaded/clinicos/archivo.pdf')
  assert.equal(operation.values[6], 'DELETE')
  assert.equal(calls.at(-1).sql, 'COMMIT')
})
