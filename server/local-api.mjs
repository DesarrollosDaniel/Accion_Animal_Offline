import { Pool, types } from 'pg'
import { randomBytes, randomUUID } from 'node:crypto'
import { passwordHash } from './local-auth.mjs'
import {
  createClinicalRecord, createPetChild, createPetWithRelated, deleteLeafResource,
  LocalApiError, readJsonBody, registerClinicalFile, updateClinicalRecord,
  updatePet, updatePetNote, updateVaccination, updateWeightRecord,
} from './local-writes.mjs'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const childTables = new Map([
  ['clinical-records', { table: 'clinical_records', order: 'occurred_at DESC, id DESC' }],
  ['vaccinations', { table: 'vaccinations', order: 'administered_on DESC, id DESC' }],
  ['medications', { table: 'medications', order: 'created_at DESC, id DESC' }],
  ['allergies', { table: 'allergies', order: 'created_at DESC, id DESC' }],
  ['pet-notes', { table: 'pet_notes', order: 'created_at DESC, id DESC' }],
  ['weight-records', { table: 'weight_records', order: 'measured_at DESC, id DESC' }],
])

const childWriteTables = new Map([
  ['vaccinations', 'vaccinations'], ['pet-notes', 'pet_notes'], ['weight-records', 'weight_records'],
])

const deletableTables = new Map([
  ['pets', 'pets'], ['clinical-records', 'clinical_records'],
  ['vaccinations', 'vaccinations'], ['pet-notes', 'pet_notes'],
  ['weight-records', 'weight_records'], ['clinical-files', 'clinical_files'],
])

function reply(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

function pageOptions(url) {
  const rawLimit = url.searchParams.get('limit') || '100'
  const rawOffset = url.searchParams.get('offset') || '0'
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) return null
  const limit = Number(rawLimit)
  const offset = Number(rawOffset)
  if (limit < 1 || limit > 200 || offset > 50000) return null
  return { limit, offset }
}

export function createLocalPool(env = process.env) {
  if (!env.AA_DB_PASSWORD) return null
  const port = Number(env.AA_DB_PORT || 5432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AA_DB_PORT no es válido.')
  const database = env.AA_DB_NAME || 'accion_animal_dev'
  if (database !== (env.AA_MODE === 'production' ? 'accion_animal_produ' : 'accion_animal_dev')) {
    throw new Error('AA_DB_NAME no corresponde al entorno seleccionado.')
  }
  return new Pool({
    host: '127.0.0.1', ssl: false, port, database, user: 'aa_local_app', password: env.AA_DB_PASSWORD,
    max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    types: {
      getTypeParser(oid, format) {
        if (format === 'text' && oid === 1082) return (value) => value
        if (format === 'text' && oid === 1700) return Number
        return types.getTypeParser(oid, format)
      },
    },
  })
}

export async function handleLocalApi(req, res, url, pool, currentSession, storageRoot) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    return reply(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET, POST, PATCH, DELETE' })
  }
  const session = currentSession(req)
  if (!session) return reply(res, 401, { error: 'Inicia sesión para consultar los datos locales.' })
  if (!pool) return reply(res, 503, { error: 'La base de datos local aún no está configurada.' })

  const { rows: profiles } = await pool.query(
    'SELECT role, is_active FROM aa_local.profiles WHERE id = $1', [session.userId],
  )
  const profile = profiles[0]
  if (!profile?.is_active || profile.role !== session.role) {
    return reply(res, 403, { error: 'Tu perfil local no está activo o necesita actualizarse.' })
  }

  if (url.pathname === '/api/local/users' && req.method === 'POST'
    || /^\/api\/local\/users\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
    if (profile.role !== 'owner') return reply(res, 403, { error: 'Solo el dueño puede administrar usuarios.' })
    let sameOrigin = false
    try {
      const origin = new URL(req.headers.origin)
      sameOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host
    } catch {}
    if (!sameOrigin) return reply(res, 403, { error: 'Solicitud rechazada por seguridad.' })
    if (req.method === 'DELETE' && !uuidPattern.test(url.pathname.split('/').at(-1))) {
      return reply(res, 400, { error: 'Identificador inválido.' })
    }
    try {
      const saved = req.method === 'POST'
        ? await createLocalUser(pool, await readJsonBody(req))
        : await deactivateLocalUser(pool, url.pathname.split('/').at(-1))
      return reply(res, req.method === 'POST' ? 201 : 200, { data: saved })
    } catch (error) {
      if (error instanceof LocalApiError) return reply(res, error.status, { error: error.message })
      if (error.code === '23505') return reply(res, 409, { error: 'Ya existe un usuario con ese correo.' })
      throw error
    }
  }

  if (req.method !== 'GET') {
    const parts = url.pathname.split('/').filter(Boolean)
    const isPetCreation = url.pathname === '/api/local/pets'
    const isRecordCreation = parts.length === 5 && parts[0] === 'api' && parts[1] === 'local'
      && parts[2] === 'pets' && parts[4] === 'clinical-records'
    const isFileCreation = parts.length === 5 && parts[0] === 'api' && parts[1] === 'local'
      && parts[2] === 'clinical-records' && parts[4] === 'files'
    const childCreateTable = parts.length === 5 && parts[0] === 'api' && parts[1] === 'local'
      && parts[2] === 'pets' && childWriteTables.get(parts[4])
    const isPetUpdate = parts.length === 4 && parts[0] === 'api' && parts[1] === 'local' && parts[2] === 'pets'
    const isRecordUpdate = parts.length === 4 && parts[0] === 'api' && parts[1] === 'local'
      && parts[2] === 'clinical-records'
    const childUpdateTable = parts.length === 4 && parts[0] === 'api' && parts[1] === 'local'
      && childWriteTables.get(parts[2])
    const deleteTable = parts.length === 4 && parts[0] === 'api' && parts[1] === 'local'
      && deletableTables.get(parts[2])
    const supported = req.method === 'POST' ? isPetCreation || isRecordCreation || isFileCreation || childCreateTable
      : req.method === 'PATCH' ? isPetUpdate || isRecordUpdate || childUpdateTable
        : deleteTable
    if (!supported) {
      return reply(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET' })
    }
    if (!isPetCreation && !uuidPattern.test(parts[3])) {
      return reply(res, 400, { error: 'Identificador inválido.' })
    }
    if (!['owner', 'veterinarian'].includes(profile.role)) {
      return reply(res, 403, { error: 'Tu rol no permite modificar datos clínicos.' })
    }
    let sameOrigin = false
    try {
      const origin = new URL(req.headers.origin)
      sameOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host
    } catch {
      // Los cambios requieren el encabezado Origin del mismo servidor.
    }
    if (!sameOrigin) return reply(res, 403, { error: 'Solicitud rechazada por seguridad.' })
    if (req.method === 'DELETE' && ['pets', 'clinical_records'].includes(deleteTable)
      && (!session.verifiedAt || Date.now() - session.verifiedAt > 5 * 60 * 1000)) {
      return reply(res, 403, { error: 'Confirma tu contraseña antes de eliminar.' })
    }
    try {
      const body = await readJsonBody(req)
      let saved
      if (req.method === 'DELETE') saved = await deleteLeafResource(pool, session.userId, deleteTable, parts[3], body)
      else if (isPetCreation) saved = await createPetWithRelated(pool, session.userId, body)
      else if (isRecordCreation) saved = await createClinicalRecord(pool, session.userId, parts[3], body)
      else if (isFileCreation) saved = await registerClinicalFile(pool, session.userId, parts[3], body, storageRoot)
      else if (childCreateTable) saved = await createPetChild(pool, session.userId, parts[3], childCreateTable, body)
      else if (isPetUpdate) saved = await updatePet(pool, session.userId, parts[3], body, storageRoot)
      else if (isRecordUpdate) saved = await updateClinicalRecord(pool, session.userId, parts[3], body)
      else if (childUpdateTable === 'vaccinations') saved = await updateVaccination(pool, session.userId, parts[3], body)
      else if (childUpdateTable === 'pet_notes') saved = await updatePetNote(pool, session.userId, parts[3], body)
      else saved = await updateWeightRecord(pool, session.userId, parts[3], body)
      return reply(res, req.method === 'POST' ? 201 : 200, { data: saved })
    } catch (error) {
      if (error instanceof LocalApiError) return reply(res, error.status, { error: error.message })
      if (['23502', '23514', '22003', '22007', '22P02'].includes(error.code)) {
        return reply(res, 400, { error: 'Los datos no cumplen las validaciones clínicas.' })
      }
      if (['23503', '23505'].includes(error.code)) {
        return reply(res, 409, { error: 'Hay un conflicto con los datos existentes.' })
      }
      throw error
    }
  }

  const page = pageOptions(url)
  if (!page) return reply(res, 400, { error: 'Paginación inválida.' })
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'local') return reply(res, 404, { error: 'Ruta no encontrada.' })

  if (parts.length === 3 && parts[2] === 'profile') {
    const { rows } = await pool.query('SELECT id, display_name, role, is_active, created_at FROM aa_local.profiles WHERE id = $1', [session.userId])
    return reply(res, 200, { data: rows[0] })
  }
  if (parts.length === 3 && parts[2] === 'profiles') {
    if (profile.role !== 'owner') return reply(res, 403, { error: 'Solo el dueño puede consultar usuarios.' })
    const { rows } = await pool.query('SELECT id, display_name, role, is_active, created_at FROM aa_local.profiles ORDER BY created_at LIMIT $1 OFFSET $2', [page.limit, page.offset])
    return reply(res, 200, { data: rows })
  }

  if (parts.length === 3 && parts[2] === 'summary') {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM aa_local.pets WHERE status = 'active') AS "activePets",
        (SELECT count(*) FROM aa_local.pets WHERE status <> 'active') AS "inactivePets",
        (SELECT count(*) FROM aa_local.clinical_records) AS "clinicalRecords"`)
    return reply(res, 200, { data: {
      activePets: Number(rows[0].activePets),
      inactivePets: Number(rows[0].inactivePets),
      clinicalRecords: Number(rows[0].clinicalRecords),
    } })
  }

  if (parts.length === 3 && parts[2] === 'pets') {
    const status = url.searchParams.get('status') || 'active'
    if (!['active', 'inactive', 'deceased', 'all'].includes(status)) {
      return reply(res, 400, { error: 'Estado de mascota inválido.' })
    }
    const search = url.searchParams.get('search')?.trim() || ''
    if (search.length > 100) return reply(res, 400, { error: 'Búsqueda demasiado larga.' })
    const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    const { rows } = await pool.query(
      `SELECT * FROM aa_local.pets WHERE ($1::text = 'all' OR status::text = $1)
       ${search ? `AND (lower(name) LIKE $5 OR lower(species) LIKE $5 OR lower(breed) LIKE $5
         OR lower(guardian_name) LIKE $5 OR guardian_phone LIKE $5 OR legacy_id::text = $4)` : ''}
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      search ? [status, page.limit, page.offset, search, pattern] : [status, page.limit, page.offset],
    )
    return reply(res, 200, { data: rows })
  }

  if (parts[2] === 'pets' && parts.length >= 4) {
    const petId = parts[3]
    if (!uuidPattern.test(petId)) return reply(res, 400, { error: 'Identificador de mascota inválido.' })
    if (parts.length === 4) {
      const { rows } = await pool.query('SELECT * FROM aa_local.pets WHERE id = $1', [petId])
      return rows[0] ? reply(res, 200, { data: rows[0] }) : reply(res, 404, { error: 'Mascota no encontrada.' })
    }
    const child = parts.length === 5 && childTables.get(parts[4])
    if (child) {
      const { rows } = await pool.query('SELECT id FROM aa_local.pets WHERE id = $1', [petId])
      if (!rows[0]) return reply(res, 404, { error: 'Mascota no encontrada.' })
      const result = await pool.query(
        `SELECT * FROM aa_local.${child.table} WHERE pet_id = $1 ORDER BY ${child.order} LIMIT $2 OFFSET $3`,
        [petId, page.limit, page.offset],
      )
      return reply(res, 200, { data: result.rows })
    }
  }

  if (parts.length === 5 && parts[2] === 'clinical-records' && parts[4] === 'files') {
    const recordId = parts[3]
    if (!uuidPattern.test(recordId)) return reply(res, 400, { error: 'Identificador de expediente inválido.' })
    const { rows } = await pool.query('SELECT id FROM aa_local.clinical_records WHERE id = $1', [recordId])
    if (!rows[0]) return reply(res, 404, { error: 'Expediente no encontrado.' })
    const files = await pool.query(
      `SELECT * FROM aa_local.clinical_files WHERE clinical_record_id = $1
       ORDER BY created_at, id LIMIT $2 OFFSET $3`,
      [recordId, page.limit, page.offset],
    )
    return reply(res, 200, { data: files.rows })
  }

  return reply(res, 404, { error: 'Ruta no encontrada.' })
}

export async function createLocalUser(pool, input) {
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : ''
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
  const password = input?.password
  if (displayName.length < 2 || displayName.length > 120 || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || !['veterinarian', 'reception'].includes(input?.role)
    || typeof password !== 'string' || password.length < 10 || password.length > 1024
    || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new LocalApiError(400, 'Revisa nombre, correo, rol y contraseña.')
  }
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const hash = await passwordHash(password, salt)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: existing } = await client.query('SELECT 1 FROM aa_local.login_credentials WHERE email = $1', [email])
    if (existing.length) throw new LocalApiError(409, 'Ya existe un usuario con ese correo.')
    await client.query('INSERT INTO aa_local.profiles (id, display_name, role, local_managed) VALUES ($1, $2, $3, true)', [id, displayName, input.role])
    await client.query('INSERT INTO aa_local.login_credentials (user_id, email, password_salt, password_hash) VALUES ($1, $2, $3, $4)', [id, email, salt, hash])
    await client.query('COMMIT')
    return { id }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function deactivateLocalUser(pool, id) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query("UPDATE aa_local.profiles SET is_active = false, local_managed = true WHERE id = $1 AND role <> 'owner' RETURNING id", [id])
    if (!rows.length) throw new LocalApiError(404, 'Usuario no encontrado o protegido.')
    await client.query('DELETE FROM aa_local.login_credentials WHERE user_id = $1', [id])
    await client.query('COMMIT')
    return { id }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
