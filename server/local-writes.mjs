import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const petTextFields = new Map([
  ['name', 200], ['guardian_name', 200], ['guardian_phone', 40],
  ['species', 100], ['breed', 120], ['color_markings', 5000],
  ['usual_food', 5000], ['guardian_address', 5000],
  ['guardian_street', 200], ['guardian_number', 40], ['referral_source', 200],
])
const petDateFields = new Set(['birth_date', 'sterilization_date'])
const petBooleanFields = new Set(['birth_date_is_approximate', 'is_sterilized'])
const recordTextFields = new Map([
  ['history', 20000], ['physical_exam', 20000], ['provisional_diagnosis', 10000],
  ['prognosis', 10000], ['treatment', 20000], ['budget_notes', 10000],
  ['attending_professional', 200], ['temperature_observation', 500],
  ['heart_rate_observation', 500], ['respiratory_rate_observation', 500],
  ['hydration_observation', 500], ['lymph_nodes_observation', 500],
  ['capillary_refill_observation', 500], ['vomiting_notes', 5000],
  ['diarrhea_notes', 5000],
])
const maxBodyBytes = 64 * 1024

export class LocalApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new LocalApiError(400, `${label} no es válido.`)
  }
  return value.trim()
}

function optionalDate(value, label) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LocalApiError(400, `${label} no es válido.`)
  }
  return value
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new LocalApiError(400, `${label} debe incluir fecha, hora y zona horaria.`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new LocalApiError(400, `${label} no es válida.`)
  return parsed.toISOString()
}

function parseVaccinationFields(input) {
  const vaccination = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'vaccine_name') vaccination[key] = requiredText(value, 200, key)
    else if (key === 'administered_on' || key === 'next_due_on') vaccination[key] = optionalDate(value, key)
    else if (['batch_number', 'provider', 'notes'].includes(key)) {
      vaccination[key] = value === null ? null : requiredText(value, key === 'notes' ? 5000 : 200, key)
    } else throw new LocalApiError(400, `Campo de vacuna no permitido: ${key}.`)
  }
  return vaccination
}

function parseNoteFields(input) {
  const note = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'body') throw new LocalApiError(400, `Campo de nota no permitido: ${key}.`)
    note.body = requiredText(value, 10000, 'body')
  }
  return note
}

function parseWeightFields(input) {
  const weight = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'weight_kg') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 10000) {
        throw new LocalApiError(400, 'weight_kg no es válido.')
      }
      weight.weight_kg = value
    } else if (key === 'measured_at') weight.measured_at = timestamp(value, key)
    else if (key === 'notes') weight.notes = value === null ? null : requiredText(value, 1000, key)
    else throw new LocalApiError(400, `Campo de peso no permitido: ${key}.`)
  }
  return weight
}

function parseChildFields(resource, input) {
  if (!isRecord(input)) throw new LocalApiError(400, 'Datos clínicos inválidos.')
  if (resource === 'vaccinations') return parseVaccinationFields(input)
  if (resource === 'pet_notes') return parseNoteFields(input)
  if (resource === 'weight_records') return parseWeightFields(input)
  throw new LocalApiError(400, 'Recurso clínico inválido.')
}

export function validateChildCreation(resource, body) {
  const fields = parseChildFields(resource, body)
  if (resource === 'vaccinations' && (!fields.vaccine_name || !fields.administered_on)) {
    throw new LocalApiError(400, 'Nombre y fecha de la vacuna son obligatorios.')
  }
  if (resource === 'pet_notes' && !fields.body) throw new LocalApiError(400, 'La nota es obligatoria.')
  if (resource === 'weight_records' && (!fields.weight_kg || !fields.measured_at)) {
    throw new LocalApiError(400, 'Peso y fecha de medición son obligatorios.')
  }
  return fields
}

function parsePetFields(input, allowStatus = false) {
  const pet = {}
  for (const [key, value] of Object.entries(input)) {
    if (petTextFields.has(key)) {
      pet[key] = value === null && !['name', 'guardian_name'].includes(key)
        ? null : requiredText(value, petTextFields.get(key), key)
    } else if (petDateFields.has(key)) {
      pet[key] = optionalDate(value, key)
    } else if (petBooleanFields.has(key)) {
      if (value !== null && typeof value !== 'boolean') throw new LocalApiError(400, `${key} no es válido.`)
      pet[key] = value
    } else if (key === 'sex' && ['male', 'female', 'unknown', null].includes(value)) {
      pet.sex = value
    } else if (key === 'status' && allowStatus && ['active', 'inactive', 'deceased'].includes(value)) {
      pet.status = value
    } else {
      throw new LocalApiError(400, `Campo de mascota no permitido: ${key}.`)
    }
  }
  if (pet.sterilization_date && pet.is_sterilized === false) {
    throw new LocalApiError(400, 'La fecha de esterilización requiere is_sterilized=true.')
  }
  return pet
}

export function validatePetCreation(body) {
  if (!isRecord(body) || !isRecord(body.pet)) throw new LocalApiError(400, 'Datos de mascota inválidos.')
  if (Object.keys(body).some((key) => !['pet', 'vaccinations', 'note'].includes(key))) {
    throw new LocalApiError(400, 'La solicitud contiene campos no permitidos.')
  }
  const pet = parsePetFields(body.pet)
  pet.name = requiredText(pet.name, 200, 'name')
  pet.guardian_name = requiredText(pet.guardian_name, 200, 'guardian_name')
  if (pet.sterilization_date && pet.is_sterilized !== true) {
    throw new LocalApiError(400, 'La fecha de esterilización requiere is_sterilized=true.')
  }

  const vaccinations = body.vaccinations || []
  if (!Array.isArray(vaccinations) || vaccinations.length > 50) {
    throw new LocalApiError(400, 'Lista de vacunas inválida.')
  }
  const parsedVaccinations = vaccinations.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['vaccine_name', 'administered_on'].includes(key))) {
      throw new LocalApiError(400, 'Vacuna inválida.')
    }
    return {
      vaccine_name: requiredText(entry.vaccine_name, 200, 'vaccine_name'),
      administered_on: optionalDate(entry.administered_on, 'fecha de vacuna'),
    }
  })
  if (parsedVaccinations.some((entry) => !entry.administered_on)) {
    throw new LocalApiError(400, 'La fecha de cada vacuna es obligatoria.')
  }
  const note = body.note === undefined || body.note === null ? null : requiredText(body.note, 10000, 'note')
  return { pet, vaccinations: parsedVaccinations, note }
}

function parseRecordFields(input) {
  const record = {}
  for (const [key, value] of Object.entries(input)) {
    if (recordTextFields.has(key)) {
      record[key] = value === null ? null : requiredText(value, recordTextFields.get(key), key)
    } else if (key === 'occurred_at') {
      record.occurred_at = timestamp(value, key)
    } else if (key === 'estimated_cost') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 9999999999.99)) {
        throw new LocalApiError(400, 'estimated_cost no es válido.')
      }
      record.estimated_cost = value
    } else if (key === 'vomiting' || key === 'diarrhea') {
      if (value !== null && typeof value !== 'boolean') throw new LocalApiError(400, `${key} no es válido.`)
      record[key] = value
    } else {
      throw new LocalApiError(400, `Campo de expediente no permitido: ${key}.`)
    }
  }
  return record
}

export function validateClinicalRecordCreation(body) {
  if (!isRecord(body) || !isRecord(body.record) || Object.keys(body).some((key) => !['record', 'weight'].includes(key))) {
    throw new LocalApiError(400, 'Datos de expediente inválidos.')
  }
  const record = parseRecordFields(body.record)
  if (!record.occurred_at) throw new LocalApiError(400, 'occurred_at es obligatorio.')
  let weight = null
  if (body.weight !== undefined && body.weight !== null) {
    if (!isRecord(body.weight) || Object.keys(body.weight).some((key) => !['weight_kg', 'notes'].includes(key))) {
      throw new LocalApiError(400, 'Peso inválido.')
    }
    const value = body.weight.weight_kg
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 10000) {
      throw new LocalApiError(400, 'El peso debe ser mayor que cero y menor que 10000 kg.')
    }
    weight = {
      weight_kg: value,
      notes: body.weight.notes === undefined || body.weight.notes === null
        ? null : requiredText(body.weight.notes, 1000, 'notes'),
    }
  }
  return { record, weight }
}

function parseExpectedVersion(version) {
  if (!(typeof version === 'string' && /^[1-9]\d*$/.test(version))
    && !(Number.isSafeInteger(version) && version > 0)) {
    throw new LocalApiError(400, 'expected_version no es válida.')
  }
  if (String(version).length > 19 || BigInt(version) > 9223372036854775807n) {
    throw new LocalApiError(400, 'expected_version no es válida.')
  }
  return String(version)
}

export function validatePatch(body, resource) {
  if (!isRecord(body) || !isRecord(body.changes)
    || Object.keys(body).some((key) => !['expected_version', 'changes'].includes(key))) {
    throw new LocalApiError(400, 'Datos de actualización inválidos.')
  }
  const expectedVersion = parseExpectedVersion(body.expected_version)
  const changes = resource === 'pets' ? parsePetFields(body.changes, true)
    : resource === 'clinical_records' ? parseRecordFields(body.changes)
      : parseChildFields(resource, body.changes)
  if (!Object.keys(changes).length) throw new LocalApiError(400, 'No hay cambios para guardar.')
  return { expectedVersion, changes }
}

export function validateClinicalFile(body) {
  if (!isRecord(body) || Object.keys(body).some((key) => ![
    'kind', 'object_path', 'original_name', 'mime_type', 'size_bytes', 'checksum_sha256',
  ].includes(key))) {
    throw new LocalApiError(400, 'Metadatos de archivo inválidos.')
  }
  if (!['photo', 'document'].includes(body.kind)) throw new LocalApiError(400, 'Tipo de archivo inválido.')
  if (typeof body.object_path !== 'string' || body.object_path.length > 1024 || !body.object_path.startsWith('uploaded/')) {
    throw new LocalApiError(400, 'Ruta de archivo inválida.')
  }
  const parts = body.object_path.slice('uploaded/'.length).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    throw new LocalApiError(400, 'Ruta de archivo inválida.')
  }
  const originalName = requiredText(body.original_name, 255, 'original_name')
  if (/[\\/\0\r\n]/.test(originalName)) throw new LocalApiError(400, 'Nombre de archivo inválido.')
  const mimeType = requiredText(body.mime_type, 127, 'mime_type')
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new LocalApiError(400, 'mime_type no es válido.')
  if (!Number.isSafeInteger(body.size_bytes) || body.size_bytes < 0) {
    throw new LocalApiError(400, 'size_bytes no es válido.')
  }
  if (body.checksum_sha256 !== undefined && body.checksum_sha256 !== null
    && !/^[0-9a-f]{64}$/.test(body.checksum_sha256)) {
    throw new LocalApiError(400, 'checksum_sha256 no es válido.')
  }
  return {
    kind: body.kind, object_path: body.object_path, original_name: originalName,
    mime_type: mimeType, size_bytes: body.size_bytes,
    checksum_sha256: body.checksum_sha256 || null, parts,
  }
}

async function checkedPhysicalFile(storageRoot, metadata) {
  const candidate = path.resolve(storageRoot, ...metadata.parts)
  let resolved
  try {
    resolved = await realpath(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') throw new LocalApiError(404, 'El archivo físico no existe.')
    throw error
  }
  const relative = path.relative(storageRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new LocalApiError(400, 'El archivo está fuera del almacenamiento local.')
  }
  const fileStat = await stat(resolved)
  if (!fileStat.isFile() || fileStat.size !== metadata.size_bytes) {
    throw new LocalApiError(409, 'El tamaño del archivo no coincide con los metadatos.')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(resolved)) hash.update(chunk)
  const checksum = hash.digest('hex')
  if (metadata.checksum_sha256 && metadata.checksum_sha256 !== checksum) {
    throw new LocalApiError(409, 'La suma de verificación del archivo no coincide.')
  }
  return checksum
}

export async function readJsonBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new LocalApiError(415, 'Se requiere application/json.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBodyBytes) throw new LocalApiError(413, 'La solicitud supera el límite permitido.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LocalApiError(400, 'JSON inválido.')
  }
}

async function addOperation(client, table, row, actorId, dependsOn = null, action = 'INSERT') {
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(action)) throw new Error('Acción de sincronización inválida.')
  const { rows } = await client.query(
    `INSERT INTO aa_local.sync_operations
       (entity_table, entity_id, action, source_version, actor_id, payload, depends_on_operation_id)
     VALUES ($1, $2, $7, $3, $4, $5, $6) RETURNING id`,
    [table, row.id, row.row_version, actorId, row, dependsOn, action],
  )
  return rows[0].id
}

export async function createPetWithRelated(pool, actorId, body) {
  const { pet, vaccinations, note } = validatePetCreation(body)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const columns = [...Object.keys(pet), 'created_by', 'updated_by']
    const values = [...Object.values(pet), actorId, actorId]
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
    const result = await client.query(
      `INSERT INTO aa_local.pets (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`, values,
    )
    const createdPet = result.rows[0]
    const petOperationId = await addOperation(client, 'pets', createdPet, actorId)
    for (const vaccine of vaccinations) {
      const inserted = await client.query(
        `INSERT INTO aa_local.vaccinations
           (pet_id, vaccine_name, administered_on, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4) RETURNING *`,
        [createdPet.id, vaccine.vaccine_name, vaccine.administered_on, actorId],
      )
      await addOperation(client, 'vaccinations', inserted.rows[0], actorId, petOperationId)
    }
    if (note) {
      const inserted = await client.query(
        `INSERT INTO aa_local.pet_notes (pet_id, body, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING *`,
        [createdPet.id, note, actorId],
      )
      await addOperation(client, 'pet_notes', inserted.rows[0], actorId, petOperationId)
    }
    await client.query('COMMIT')
    return createdPet
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function createClinicalRecord(pool, actorId, petId, body) {
  const { record, weight } = validateClinicalRecordCreation(body)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const pet = await client.query('SELECT id FROM aa_local.pets WHERE id = $1 FOR KEY SHARE', [petId])
    if (!pet.rows[0]) throw new LocalApiError(404, 'Mascota no encontrada.')
    const parentOperation = await client.query(
      `SELECT id FROM aa_local.sync_operations
       WHERE entity_table = 'pets' AND entity_id = $1
       ORDER BY source_version DESC LIMIT 1`, [petId],
    )
    const columns = ['pet_id', ...Object.keys(record), 'attended_by', 'created_by', 'updated_by']
    const values = [petId, ...Object.values(record), actorId, actorId, actorId]
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
    const { rows } = await client.query(
      `INSERT INTO aa_local.clinical_records (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`, values,
    )
    const created = rows[0]
    const recordOperationId = await addOperation(client, 'clinical_records', created, actorId, parentOperation.rows[0]?.id)
    if (weight) {
      const inserted = await client.query(
        `INSERT INTO aa_local.weight_records
           (pet_id, measured_at, weight_kg, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
        [petId, record.occurred_at, weight.weight_kg, weight.notes, actorId],
      )
      await addOperation(client, 'weight_records', inserted.rows[0], actorId, recordOperationId)
    }
    await client.query('COMMIT')
    return created
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function registerClinicalFile(pool, actorId, recordId, body, storageRoot) {
  const metadata = validateClinicalFile(body)
  const checksum = await checkedPhysicalFile(storageRoot, metadata)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const record = await client.query(
      'SELECT id FROM aa_local.clinical_records WHERE id = $1 FOR KEY SHARE', [recordId],
    )
    if (!record.rows[0]) throw new LocalApiError(404, 'Expediente no encontrado.')
    const parentOperation = await client.query(
      `SELECT id FROM aa_local.sync_operations
       WHERE entity_table = 'clinical_records' AND entity_id = $1
       ORDER BY source_version DESC LIMIT 1`, [recordId],
    )
    const { rows } = await client.query(
      `INSERT INTO aa_local.clinical_files
         (clinical_record_id, kind, object_path, original_name, mime_type, size_bytes, checksum_sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [recordId, metadata.kind, metadata.object_path, metadata.original_name,
        metadata.mime_type, metadata.size_bytes, checksum, actorId],
    )
    const created = rows[0]
    await addOperation(client, 'clinical_files', created, actorId, parentOperation.rows[0]?.id)
    await client.query('COMMIT')
    return created
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function updateWithOutbox(pool, actorId, table, id, body) {
  const { expectedVersion, changes } = validatePatch(body, table)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const assignments = []
    const values = [id, expectedVersion]
    let statusPlaceholder = null
    for (const [column, value] of Object.entries(changes)) {
      values.push(value)
      const placeholder = `$${values.length}`
      assignments.push(`${column} = ${placeholder}`)
      if (table === 'pets' && column === 'status') statusPlaceholder = placeholder
    }
    values.push(actorId)
    if (statusPlaceholder) {
      assignments.push(`deactivated_at = CASE WHEN ${statusPlaceholder}::aa_local.pet_status = 'active' THEN NULL
        WHEN status = 'active' THEN now() ELSE deactivated_at END`)
      assignments.push(`deactivated_by = CASE WHEN ${statusPlaceholder}::aa_local.pet_status = 'active' THEN NULL
        WHEN status = 'active' THEN $${values.length} ELSE deactivated_by END`)
    }
    assignments.push(`updated_by = $${values.length}`)
    const result = await client.query(
      `UPDATE aa_local.${table} SET ${assignments.join(', ')}
       WHERE id = $1 AND row_version = $2 RETURNING *`, values,
    )
    if (!result.rows[0]) {
      const exists = await client.query(`SELECT id FROM aa_local.${table} WHERE id = $1`, [id])
      throw new LocalApiError(exists.rows[0] ? 409 : 404,
        exists.rows[0] ? 'El registro cambió; vuelve a cargarlo antes de guardar.' : 'Registro no encontrado.')
    }
    const previous = await client.query(
      `SELECT id FROM aa_local.sync_operations WHERE entity_table = $1 AND entity_id = $2
       ORDER BY source_version DESC LIMIT 1`, [table, id],
    )
    const updated = result.rows[0]
    await addOperation(client, table, updated, actorId, previous.rows[0]?.id, 'UPDATE')
    await client.query('COMMIT')
    return updated
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function updatePet(pool, actorId, petId, body) {
  return updateWithOutbox(pool, actorId, 'pets', petId, body)
}

export function updateClinicalRecord(pool, actorId, recordId, body) {
  return updateWithOutbox(pool, actorId, 'clinical_records', recordId, body)
}

export async function createPetChild(pool, actorId, petId, resource, body) {
  const fields = validateChildCreation(resource, body)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const pet = await client.query('SELECT id FROM aa_local.pets WHERE id = $1 FOR KEY SHARE', [petId])
    if (!pet.rows[0]) throw new LocalApiError(404, 'Mascota no encontrada.')
    const parentOperation = await client.query(
      `SELECT id FROM aa_local.sync_operations
       WHERE entity_table = 'pets' AND entity_id = $1
       ORDER BY source_version DESC LIMIT 1`, [petId],
    )
    const columns = ['pet_id', ...Object.keys(fields), 'created_by', 'updated_by']
    const values = [petId, ...Object.values(fields), actorId, actorId]
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
    const { rows } = await client.query(
      `INSERT INTO aa_local.${resource} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`, values,
    )
    const created = rows[0]
    await addOperation(client, resource, created, actorId, parentOperation.rows[0]?.id)
    await client.query('COMMIT')
    return created
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function updateVaccination(pool, actorId, vaccinationId, body) {
  return updateWithOutbox(pool, actorId, 'vaccinations', vaccinationId, body)
}

export function updatePetNote(pool, actorId, noteId, body) {
  return updateWithOutbox(pool, actorId, 'pet_notes', noteId, body)
}

export function updateWeightRecord(pool, actorId, weightId, body) {
  return updateWithOutbox(pool, actorId, 'weight_records', weightId, body)
}

const deletableResources = new Set([
  'vaccinations', 'pet_notes', 'weight_records', 'clinical_files',
])

export async function deleteLeafResource(pool, actorId, resource, entityId, body) {
  if (!deletableResources.has(resource)) throw new LocalApiError(400, 'Recurso no eliminable.')
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'expected_version')) {
    throw new LocalApiError(400, 'Datos de eliminación inválidos.')
  }
  const expectedVersion = parseExpectedVersion(body.expected_version)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('aa.actor_id', $1, true)", [actorId])
    const { rows } = await client.query(
      `SELECT * FROM aa_local.${resource} WHERE id = $1 FOR UPDATE`, [entityId],
    )
    const current = rows[0]
    if (!current) throw new LocalApiError(404, 'Registro no encontrado.')
    if (String(current.row_version) !== expectedVersion) {
      throw new LocalApiError(409, 'El registro cambió; vuelve a cargarlo antes de eliminar.')
    }
    const previous = await client.query(
      `SELECT id FROM aa_local.sync_operations
       WHERE entity_table = $1 AND entity_id = $2
       ORDER BY source_version DESC LIMIT 1`, [resource, entityId],
    )
    await client.query(`DELETE FROM aa_local.${resource} WHERE id = $1`, [entityId])
    const tombstone = {
      ...current, row_version: String(BigInt(current.row_version) + 1n),
      deleted_at: new Date().toISOString(),
    }
    await addOperation(client, resource, tombstone, actorId, previous.rows[0]?.id, 'DELETE')
    await client.query('COMMIT')
    return { id: entityId, deleted: true }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function deleteVaccination(pool, actorId, vaccinationId, body) {
  return deleteLeafResource(pool, actorId, 'vaccinations', vaccinationId, body)
}
