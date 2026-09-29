import { createHash } from 'node:crypto'
import { validateClinicalFile } from './local-writes.mjs'

export const syncTables = ['pets', 'clinical_records', 'clinical_files', 'vaccinations', 'medications', 'allergies', 'pet_notes', 'weight_records']
export const clinicalResourceTables = ['vaccinations', 'medications', 'allergies', 'pet_notes', 'weight_records', 'clinical_files']
const inboundBatchSize = 500
const dateFields = new Set(['birth_date', 'sterilization_date', 'administered_on', 'next_due_on', 'starts_on', 'ends_on', 'diagnosed_on'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metadata = new Set(['row_version', 'deleted_at', 'cascade_delete_operations', '_sync_base', 'remote_base', 'remote_base_version'])
const numericFields = new Set(['legacy_id', 'estimated_cost', 'weight_kg', 'size_bytes'])

export class SyncConflict extends Error {}

export function syncErrorCode(error) {
  const known = ['28P01', '28000', '42501', '42P01', '42P18', '23502', '23503', '23505', '23514', '42703', '42601', '22P02', '22003', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']
  if (known.includes(error?.code)) return error.code
  if (error instanceof SyncConflict) return 'SYNC_CONFLICT'
  if (/not permitted to log in|cannot log in/i.test(error?.message || '')) return 'ROLE_NO_LOGIN'
  if (/tenant or user not found/i.test(error?.message || '')) return 'POOLER_USER_NOT_FOUND'
  return /timeout|timed out/i.test(error?.message || '') ? 'ETIMEDOUT' : 'UNKNOWN'
}

export function canonicalRow(row) {
  if (!row) return null
  return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !metadata.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (value instanceof Date && dateFields.has(key)) value = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    else if (value !== null && numericFields.has(key)) value = String(Number(value))
    else if (value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))) value = new Date(value).toISOString()
    return [key, value]
  })))
}

function validateOperation(op) {
  if (!syncTables.includes(op.entity_table) || !['INSERT', 'UPDATE', 'DELETE'].includes(op.action)
    || ![op.id, op.entity_id, op.actor_id].every((value) => typeof value === 'string' && uuid.test(value))
    || !/^[1-9]\d*$/.test(String(op.source_version)) || !op.payload || op.payload.id !== op.entity_id) {
    throw new SyncConflict('Operación inválida o sin autor verificable.')
  }
}

async function guardCascade(remote, op) {
  const children = op.entity_table === 'pets'
    ? ['clinical_records', 'vaccinations', 'medications', 'allergies', 'pet_notes', 'weight_records'].map((table) => [table, 'pet_id'])
    : op.entity_table === 'clinical_records' ? [['clinical_files', 'clinical_record_id'], ['medications', 'clinical_record_id']] : []
  for (const [table, column] of children) {
    const result = await remote.query(`SELECT id FROM public.${table} WHERE ${column} = $1 LIMIT 1`, [op.entity_id])
    if (result.rows.length) throw new SyncConflict('Hay registros remotos relacionados; no se eliminará el padre.')
  }
}

// One transaction contains both the remote write and its receipt. A lost response is safe to replay.
export async function applyRemoteOperation(remote, op, reviewedHash = null) {
  validateOperation(op)
  const fingerprint = createHash('sha256').update(JSON.stringify([op.entity_table, op.entity_id, op.action, String(op.source_version), op.actor_id, op.payload])).digest('hex')
  await remote.query('BEGIN')
  try {
    // ponytail: una PC origina cambios; múltiples servidores requieren identificar el origen de cada versión.
    await remote.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${op.entity_table}:${op.entity_id}`])
    const receipt = await remote.query('SELECT * FROM aa_sync.receipts WHERE operation_id = $1', [op.id])
    if (receipt.rows[0]) {
      if (receipt.rows[0].fingerprint !== fingerprint) throw new SyncConflict('El identificador remoto tiene otro contenido.')
      await remote.query('COMMIT')
      return { remote_version: String(op.source_version), replayed: true }
    }
    const prior = await remote.query('SELECT snapshot, source_version FROM aa_sync.receipts WHERE entity_table = $1 AND entity_id = $2 ORDER BY applied_at DESC LIMIT 1', [op.entity_table, op.entity_id])
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: op.actor_id, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [op.actor_id])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) {
      throw new SyncConflict('El autor ya no tiene permiso clínico en Supabase.')
    }
    const current = await remote.query(`SELECT to_jsonb(t) AS snapshot FROM public.${op.entity_table} AS t WHERE id = $1 FOR UPDATE`, [op.entity_id])
    const snapshot = current.rows[0]?.snapshot || null
    const imported = op.payload.remote_base
      && /^[1-9]\d*$/.test(String(op.payload.remote_base_version))
      && BigInt(op.payload.remote_base_version) < BigInt(op.source_version)
      && BigInt(op.payload.remote_base_version) > BigInt(prior.rows[0]?.source_version || 0)
    const baseline = imported ? op.payload.remote_base : prior.rows.length ? prior.rows[0].snapshot
      : op.payload._sync_base || (op.action === 'DELETE' ? op.payload : null)
    const reviewed = op.action === 'UPDATE' && snapshot && reviewedHash
      && reviewedHash === createHash('sha256').update(canonicalRow(snapshot)).digest('hex')
    if (reviewedHash && !reviewed) throw new SyncConflict('Supabase cambió después de la revisión; revisa de nuevo.')
    if (op.action === 'INSERT' ? snapshot !== null : !reviewed && (!baseline || canonicalRow(baseline) !== canonicalRow(snapshot))) {
      throw new SyncConflict('El registro remoto cambió o falta su versión original; requiere revisión.')
    }
    let applied = null
    if (op.action === 'DELETE') {
      // Prevent a cascade from removing children created remotely after the local deletion.
      await guardCascade(remote, op)
      const deleted = await remote.query(`DELETE FROM public.${op.entity_table} WHERE id = $1 RETURNING id`, [op.entity_id])
      if (deleted.rows.length !== 1) throw new SyncConflict('Supabase rechazó la eliminación.')
    } else {
      const columns = await remote.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [op.entity_table])
      const allowed = new Set(columns.rows.map((row) => row.column_name))
      const entries = Object.entries(op.payload).filter(([key]) => !metadata.has(key))
      if (entries.some(([key]) => !allowed.has(key) || !/^[a-z][a-z0-9_]*$/.test(key))) throw new SyncConflict('El esquema remoto no coincide con el local.')
      const fields = entries.filter(([key]) => op.action === 'INSERT' || !['id', 'created_at', 'created_by'].includes(key))
      const names = fields.map(([key]) => `"${key}"`)
      const values = fields.map(([, value]) => value)
      const placeholders = fields.map((_, index) => `$${index + 1}`)
      const sql = op.action === 'INSERT'
        ? `INSERT INTO public.${op.entity_table} AS t (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING to_jsonb(t) AS snapshot`
        : `UPDATE public.${op.entity_table} AS t SET ${names.map((name, index) => `${name} = ${placeholders[index]}`).join(', ')} WHERE id = $${values.length + 1} RETURNING to_jsonb(t) AS snapshot`
      if (op.action === 'UPDATE') values.push(op.entity_id)
      const result = await remote.query(sql, values)
      if (result.rows.length !== 1) throw new SyncConflict('Supabase rechazó la escritura.')
      applied = result.rows[0].snapshot
    }
    await remote.query('RESET ROLE')
    await remote.query('INSERT INTO aa_sync.receipts (operation_id, entity_table, entity_id, source_version, fingerprint, snapshot) VALUES ($1, $2, $3, $4, $5, $6)', [op.id, op.entity_table, op.entity_id, op.source_version, fingerprint, applied])
    await remote.query('COMMIT')
    return { remote_version: String(op.source_version), replayed: false }
  } catch (error) {
    await remote.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function sendPending(local, remote, limit = 50) {
  const counts = { confirmed: 0, conflict: 0, blocked: 0, pending: 0 }
  for (let index = 0; index < limit; index++) {
    const next = await local.query(`SELECT op.* FROM aa_local.sync_operations AS op
      WHERE op.status = 'pending' AND op.available_at <= now()
        AND (op.depends_on_operation_id IS NULL OR EXISTS (
          SELECT 1 FROM aa_local.sync_operations AS dep WHERE dep.id = op.depends_on_operation_id AND dep.status = 'confirmed'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(op.payload->'cascade_delete_operations', '[]'::jsonb)) AS child(id)
          WHERE NOT EXISTS (SELECT 1 FROM aa_local.sync_operations AS dep WHERE dep.id::text = child.id AND dep.status = 'confirmed'))
      ORDER BY op.created_at, op.id LIMIT 1`)
    const op = next.rows[0]
    if (!op) break
    await local.query('UPDATE aa_local.sync_operations SET attempt_count = attempt_count + 1, last_attempt_at = now() WHERE id = $1', [op.id])
    let response
    try {
      response = await applyRemoteOperation(remote, op)
    } catch (error) {
      const conflict = error instanceof SyncConflict || ['23505', '23503'].includes(error.code)
      const permanent = ['42501', '42703', '23514', '22P02'].includes(error.code)
      const status = conflict ? 'conflict' : permanent ? 'blocked' : 'pending'
      // Never store raw database errors: they can contain clinical values or connection credentials.
      await local.query('INSERT INTO aa_local.sync_errors (operation_id, kind, error_code, message) VALUES ($1, $2, $3, $4)', [op.id, conflict ? 'conflict' : permanent ? 'permanent' : 'temporary', error.code || 'SYNC', conflict ? 'Conflicto remoto; requiere revisión.' : permanent ? 'Configuración o permiso remoto rechazado.' : 'Conexión remota no disponible; se reintentará.'])
      await local.query(`UPDATE aa_local.sync_operations SET status = $2, available_at = now() + interval '1 minute' * LEAST(60, power(2, LEAST(attempt_count, 6))) WHERE id = $1`, [op.id, status])
      counts[status]++
      if (status === 'pending') break
      continue
    }
    await confirmOperation(local, op, response)
    counts.confirmed++
  }
  return counts
}

export async function reviewConflict(local, remote, operationId) {
  const result = await local.query("SELECT * FROM aa_local.sync_operations WHERE id = $1 AND status = 'conflict'", [operationId])
  const op = result.rows[0]
  if (!op) throw new SyncConflict('El conflicto ya no está disponible.')
  validateOperation(op)
  await remote.query('BEGIN READ ONLY')
  try {
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: op.actor_id, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const current = await remote.query(`SELECT to_jsonb(t) AS snapshot FROM public.${op.entity_table} AS t WHERE id = $1`, [op.entity_id])
    const snapshot = current.rows[0]?.snapshot
    if (!snapshot) throw new SyncConflict('El registro remoto no está disponible para comparar.')
    const before = JSON.parse(canonicalRow(snapshot))
    const after = JSON.parse(canonicalRow(op.payload))
    const audit = new Set(['created_at', 'updated_at', 'created_by', 'updated_by'])
    const differences = Object.keys(after).filter((key) => !audit.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((field) => ({ field, supabase: before[field], local: after[field] }))
    await remote.query('ROLLBACK')
    return { operation: op.id, differences, remote_hash: createHash('sha256').update(canonicalRow(snapshot)).digest('hex') }
  } catch (error) {
    await remote.query('ROLLBACK').catch(() => {})
    throw error
  }
}
async function confirmOperation(local, op, response) {
    // A local failure after remote COMMIT leaves the operation pending; the next run reads its receipt.
    await local.query('BEGIN')
    try {
      await local.query('INSERT INTO aa_local.sync_confirmations (operation_id, remote_entity_id, remote_version, response) VALUES ($1, $2, $3, $4) ON CONFLICT (operation_id) DO NOTHING', [op.id, op.entity_id, response.remote_version, response])
      await local.query("UPDATE aa_local.sync_operations SET status = 'confirmed' WHERE id = $1", [op.id])
      await local.query('UPDATE aa_local.sync_errors SET resolved_at = now() WHERE operation_id = $1 AND resolved_at IS NULL', [op.id])
      await local.query('COMMIT')
    } catch (error) {
      await local.query('ROLLBACK').catch(() => {})
      throw error
    }
}

export async function resolveReviewedConflict(local, remote, operationId, remoteHash) {
  if (!uuid.test(operationId) || !/^[0-9a-f]{64}$/.test(remoteHash)) throw new SyncConflict('Revisión inválida.')
  const result = await local.query("SELECT * FROM aa_local.sync_operations WHERE id = $1 AND status = 'conflict'", [operationId])
  const op = result.rows[0]
  if (!op || op.action !== 'UPDATE') throw new SyncConflict('Esta resolución solo admite una edición en conflicto.')
  if (op.depends_on_operation_id) {
    const dependency = await local.query("SELECT status FROM aa_local.sync_operations WHERE id = $1", [op.depends_on_operation_id])
    if (dependency.rows[0]?.status !== 'confirmed') throw new SyncConflict('La operación anterior aún no está confirmada.')
  }
  const response = await applyRemoteOperation(remote, op, remoteHash)
  await confirmOperation(local, op, response)
  return { confirmed: true, operation: op.id }
}

export async function receiveProfiles(local, remote) {
  // ponytail: snapshot completo de hasta 1000 perfiles; paginar con REPEATABLE READ si la clínica supera ese límite.
  const { rows } = await remote.query('SELECT id, display_name, role, is_active, created_at, updated_at FROM public.profiles ORDER BY id LIMIT 1001')
  if (rows.length > 1000 || rows.some((row) => !uuid.test(row.id) || typeof row.display_name !== 'string'
    || !['owner', 'veterinarian', 'reception'].includes(row.role) || typeof row.is_active !== 'boolean')) throw new SyncConflict('Perfiles remotos inválidos; se conserva el acceso local.')
  const ids = rows.map((row) => row.id)
  await local.query('BEGIN')
  try {
    await local.query(`INSERT INTO aa_local.profiles (id, display_name, role, is_active, created_at, updated_at)
      SELECT id, display_name, role::aa_local.app_role, is_active, created_at, updated_at
      FROM jsonb_to_recordset($1::jsonb) AS p(id uuid, display_name text, role text, is_active boolean, created_at timestamptz, updated_at timestamptz)
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
        is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at
      WHERE (profiles.display_name, profiles.role, profiles.is_active) IS DISTINCT FROM
        (EXCLUDED.display_name, EXCLUDED.role, EXCLUDED.is_active)`, [JSON.stringify(rows)])
    // Preserve clinical foreign keys when the cloud profile has been deleted.
    await local.query('UPDATE aa_local.profiles SET is_active = false WHERE NOT (id = ANY($1::uuid[])) AND is_active', [ids])
    await local.query('DELETE FROM aa_local.login_credentials c USING aa_local.profiles p WHERE c.user_id = p.id AND NOT p.is_active')
    await local.query("UPDATE aa_local.sync_state SET last_attempt_at = now(), last_success_at = now(), last_error = NULL, updated_at = now() WHERE stream = 'profiles_inbound'")
    await local.query('COMMIT')
    return { profiles: rows.length }
  } catch (error) {
    await local.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function comparePets(local, remote) {
  await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let remoteStarted = false
  try {
    const actors = await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")
    const actor = actors.rows[0]?.id
    if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo para revisar mascotas.')
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    remoteStarted = true
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) {
      throw new SyncConflict('El perfil remoto no tiene permiso clínico; no se comparará una lista incompleta.')
    }
    // ponytail: comparación manual de hasta 10000 mascotas; paginar si supera el límite, nunca truncar en silencio.
    const cloud = await remote.query('SELECT to_jsonb(p) AS snapshot FROM public.pets p ORDER BY id LIMIT 10001')
    const pc = await local.query('SELECT to_jsonb(p) AS snapshot FROM aa_local.pets p ORDER BY id LIMIT 10001')
    if (cloud.rows.length > 10000 || pc.rows.length > 10000) throw new SyncConflict('La comparación supera 10000 mascotas.')
    const queued = await local.query("SELECT DISTINCT entity_id FROM aa_local.sync_operations WHERE entity_table = 'pets' AND status <> 'confirmed'")
    const protectedIds = new Set(queued.rows.map((row) => row.entity_id))
    const cloudRows = new Map(cloud.rows.map(({ snapshot }) => [snapshot.id, JSON.parse(canonicalRow(snapshot))]))
    const pcRows = new Map(pc.rows.map(({ snapshot }) => [snapshot.id, JSON.parse(canonicalRow(snapshot))]))
    const audit = new Set(['created_at', 'updated_at', 'created_by', 'updated_by'])
    const differences = []
    for (const id of new Set([...cloudRows.keys(), ...pcRows.keys()])) {
      const before = pcRows.get(id)
      const after = cloudRows.get(id)
      const fields = before && after
        ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => !audit.has(field) && JSON.stringify(before[field]) !== JSON.stringify(after[field]))
        : []
      if (!before || !after || fields.length) differences.push({
        id, kind: !before ? 'only_supabase' : !after ? 'only_local' : 'different',
        fields, local_pending: protectedIds.has(id),
      })
    }
    return { local: pc.rows.length, supabase: cloud.rows.length, differences }
  } finally {
    if (remoteStarted) await remote.query('ROLLBACK').catch(() => {})
    await local.query('ROLLBACK').catch(() => {})
  }
}

export async function receivePet(local, remote, petId, skipPending = false, allowCreate = false) {
  return receiveRow(local, remote, 'pets', petId, skipPending, allowCreate)
}

export async function receiveClinicalRecord(local, remote, id) {
  return receiveRow(local, remote, 'clinical_records', id, true, true)
}

async function receiveRow(local, remote, table, petId, skipPending, allowCreate) {
  if (!uuid.test(petId)) throw new SyncConflict('Identificador de registro inválido.')
  await local.query('BEGIN')
  let remoteStarted = false
  try {
    // The API takes this same row lock before changing the row and adding its outbox entry.
    const existing = await local.query(`SELECT * FROM aa_local.${table} WHERE id = $1 FOR UPDATE`, [petId])
    if (!existing.rows[0] && !allowCreate) throw new SyncConflict('Esta etapa solo actualiza mascotas que ya existen en la PC.')
    const pending = await local.query(`SELECT id FROM aa_local.sync_operations WHERE entity_table = '${table}' AND entity_id = $1 AND status <> 'confirmed' LIMIT 1`, [petId])
    if (pending.rows.length) {
      if (!skipPending) throw new SyncConflict('Hay cambios locales pendientes; no se sobrescribirá la mascota.')
      await local.query('ROLLBACK')
      return { received: false, reason: 'local_pending', id: petId }
    }
    const actors = await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")
    const actor = actors.rows[0]?.id
    if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo.')
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    remoteStarted = true
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
    const result = await remote.query(`SELECT to_jsonb(p) AS snapshot FROM public.${table} p WHERE id = $1`, [petId])
    const snapshot = result.rows[0]?.snapshot
    if (!snapshot || snapshot.id !== petId) {
      if (skipPending && allowCreate) {
        await local.query('ROLLBACK')
        return { received: false, reason: 'remote_unavailable', id: petId }
      }
      if (table !== 'pets') {
        await local.query('ROLLBACK')
        return { received: false, reason: 'remote_unavailable', id: petId }
      }
      throw new SyncConflict('La mascota no está disponible en Supabase; no se eliminará la copia local.')
    }
    if (table !== 'pets') {
      const parents = []
      if (table === 'clinical_files' || (table === 'medications' && snapshot.clinical_record_id !== null)) {
        const record = await local.query('SELECT id, pet_id FROM aa_local.clinical_records WHERE id = $1 FOR KEY SHARE', [snapshot.clinical_record_id])
        if (!record.rows[0] || (table === 'medications' && record.rows[0].pet_id !== snapshot.pet_id)) {
          await local.query('ROLLBACK')
          return { received: false, reason: 'parent_unavailable', id: petId }
        }
        parents.push(['clinical_records', record.rows[0].id], ['pets', record.rows[0].pet_id])
      } else parents.push(['pets', snapshot.pet_id])
      for (const [parentTable, parentId] of parents) {
        const parent = await local.query(`SELECT id FROM aa_local.${parentTable} WHERE id = $1 FOR KEY SHARE`, [parentId])
        const deletion = await local.query(`SELECT id FROM aa_local.sync_operations WHERE entity_table = '${parentTable}' AND entity_id = $1 AND action = 'DELETE' AND status <> 'confirmed' LIMIT 1`, [parentId])
        if (!parent.rows.length || deletion.rows.length) {
          await local.query('ROLLBACK')
          return { received: false, reason: 'parent_unavailable', id: petId }
        }
      }
      if (table === 'clinical_files') {
        // Metadata only: the file server still validates access and physical paths.
        validateClinicalFile(Object.fromEntries(['kind', 'object_path', 'original_name', 'mime_type', 'size_bytes', 'checksum_sha256']
          .map((field) => [field, field === 'size_bytes' ? Number(snapshot[field]) : snapshot[field]])))
      }
    }
    if (existing.rows[0] && petContent(existing.rows[0]) === petContent(snapshot)) {
      await local.query('ROLLBACK')
      return { received: false, reason: 'unchanged', id: petId }
    }
    const fields = Object.keys(snapshot)
    const schema = await local.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'aa_local' AND table_name = '${table}'`)
    const allowed = new Set(schema.rows.map((row) => row.column_name))
    if (fields.some((field) => !allowed.has(field) || !/^[a-z][a-z0-9_]*$/.test(field) || metadata.has(field))) throw new SyncConflict('El esquema remoto no coincide con el local.')
    let received = true
    if (!existing.rows[0]) {
      // A previously deleted UUID must not reuse any local or remote operation version.
      const localVersion = await local.query(`SELECT COALESCE(max(source_version), 0)::text AS version FROM aa_local.sync_operations WHERE entity_table = '${table}' AND entity_id = $1`, [petId])
      await remote.query('RESET ROLE')
      const remoteVersion = await remote.query(`SELECT COALESCE(max(source_version), 0)::text AS version FROM aa_sync.receipts WHERE entity_table = '${table}' AND entity_id = $1`, [petId])
      const version = (BigInt(localVersion.rows[0]?.version || 0) > BigInt(remoteVersion.rows[0]?.version || 0)
        ? BigInt(localVersion.rows[0]?.version || 0) : BigInt(remoteVersion.rows[0]?.version || 0)) + 1n
      const inserted = await local.query(`INSERT INTO aa_local.${table} (${fields.map((field) => `"${field}"`).join(', ')}, row_version, remote_base, remote_base_version)
        SELECT ${fields.map((field) => `cloud."${field}"`).join(', ')}, $3::bigint, $2::jsonb, $3::bigint
        FROM jsonb_populate_record(NULL::aa_local.${table}, $2::jsonb) AS cloud WHERE cloud.id = $1::uuid
        ON CONFLICT (id) DO NOTHING RETURNING id`, [petId, JSON.stringify(snapshot), version.toString()])
      received = inserted.rows.length === 1
    } else {
      // Local triggers increment row_version, timestamp and audit; they do not create outbox operations.
      const updates = fields.filter((field) => !['id', 'created_at', 'created_by'].includes(field))
      await local.query(`UPDATE aa_local.${table} AS p SET ${updates.map((field) => `"${field}" = cloud."${field}"`).join(', ')},
        remote_base = $2::jsonb, remote_base_version = p.row_version + 1
        FROM jsonb_populate_record(NULL::aa_local.${table}, $2::jsonb) AS cloud WHERE p.id = $1`, [petId, JSON.stringify(snapshot)])
    }
    await local.query('COMMIT')
    return { received, id: petId }
  } catch (error) {
    await local.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (remoteStarted) await remote.query('ROLLBACK').catch(() => {})
  }
}

function petContent(row) {
  return canonicalRow(Object.fromEntries(Object.entries(row).filter(([field]) =>
    !['created_at', 'updated_at', 'created_by', 'updated_by'].includes(field))))
}

export async function receivePetBatch(local, remote, cursor = null) {
  if (cursor !== null && !uuid.test(cursor)) throw new SyncConflict('Cursor de mascotas inválido.')
  // La carga inicial usa lotes; después se leen los cambios del registro de auditoría.
  const page = await local.query(`SELECT to_jsonb(p) AS snapshot, EXISTS (
    SELECT 1 FROM aa_local.sync_operations op WHERE op.entity_table = 'pets'
      AND op.entity_id = p.id AND op.status <> 'confirmed') AS pending
    FROM aa_local.pets p WHERE ($1::uuid IS NULL OR p.id > $1::uuid) ORDER BY p.id LIMIT ${inboundBatchSize}`, [cursor])
  const counts = { checked: page.rows.length, received: 0, protected: 0 }
  if (!page.rows.length) return { ...counts, cursor: null }
  const actors = await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")
  const actor = actors.rows[0]?.id
  if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo.')
  let cloud
  await remote.query('BEGIN READ ONLY')
  try {
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
    cloud = await remote.query('SELECT to_jsonb(p) AS snapshot FROM public.pets p WHERE id = ANY($1::uuid[])', [page.rows.map(({ snapshot }) => snapshot.id)])
  } finally {
    await remote.query('ROLLBACK').catch(() => {})
  }
  const remoteRows = new Map(cloud.rows.map(({ snapshot }) => [snapshot.id, snapshot]))
  for (const row of page.rows) {
    if (row.pending) { counts.protected++; await rememberInboundRetry(local, 'pets', row.snapshot.id); continue }
    const incoming = remoteRows.get(row.snapshot.id)
    // Remote absence is not authorization for deletion.
    if (!incoming || petContent(incoming) === petContent(row.snapshot)) continue
    const result = await receivePet(local, remote, row.snapshot.id, true)
    if (result.received) counts.received++
    else { counts.protected++; await rememberInboundRetry(local, 'pets', row.snapshot.id) }
  }
  return { ...counts, cursor: page.rows.length === inboundBatchSize ? page.rows.at(-1).snapshot.id : null }
}

export async function receiveNewPetBatch(local, remote, cursor = null) {
  if (cursor !== null && !uuid.test(cursor)) throw new SyncConflict('Cursor de mascotas inválido.')
  const actors = await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")
  const actor = actors.rows[0]?.id
  if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo.')
  let page
  await remote.query('BEGIN READ ONLY')
  try {
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
    page = await remote.query(`SELECT id FROM public.pets WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT ${inboundBatchSize}`, [cursor])
  } finally {
    await remote.query('ROLLBACK').catch(() => {})
  }
  const counts = { checked: page.rows.length, received: 0, protected: 0 }
  if (!page.rows.length) return { ...counts, cursor: null }
  const ids = page.rows.map((row) => row.id)
  const existing = await local.query('SELECT id FROM aa_local.pets WHERE id = ANY($1::uuid[])', [ids])
  const known = new Set(existing.rows.map((row) => row.id))
  for (const id of ids) {
    if (known.has(id)) continue
    // receivePet also checks tombstone operations even when no local pet row remains.
    const result = await receivePet(local, remote, id, true, true)
    if (result.received) counts.received++
    else { counts.protected++; await rememberInboundRetry(local, 'pets', id) }
  }
  return { ...counts, cursor: ids.length === inboundBatchSize ? ids.at(-1) : null }
}

export async function receiveClinicalRecordBatch(local, remote, cursor = null) {
  return receiveClinicalBatch(local, remote, 'clinical_records', cursor)
}

async function receiveChangedEntity(local, remote, table, id) {
  const result = await receiveRow(local, remote, table, id, true, true)
  if (result.reason !== 'remote_unavailable') return result.reason !== 'local_pending' && result.reason !== 'parent_unavailable'
  const deleted = await receiveDeletedBatch(local, remote, table, null, [id])
  return deleted.protected === 0
}

async function rememberInboundRetry(local, table, id) {
  await local.query('INSERT INTO aa_local.inbound_retry (entity_table, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [table, id])
}

export async function receiveAuditBatch(local, remote, cursor) {
  if (!/^\d+$/.test(cursor)) throw new SyncConflict('Cursor de auditoría inválido.')
  const { rows } = await remote.query(`SELECT id, entity_table, entity_id FROM public.audit_events
    WHERE id > $1::bigint ORDER BY id LIMIT 100`, [cursor])
  const latest = new Map(rows.filter((row) => syncTables.includes(row.entity_table) && uuid.test(row.entity_id))
    .map((row) => [`${row.entity_table}:${row.entity_id}`, row]))
  const priority = ['pets', 'clinical_records', ...clinicalResourceTables]
  for (const event of [...latest.values()].sort((a, b) => priority.indexOf(a.entity_table) - priority.indexOf(b.entity_table))) {
    const resolved = await receiveChangedEntity(local, remote, event.entity_table, event.entity_id)
    if (resolved) await local.query('DELETE FROM aa_local.inbound_retry WHERE entity_table = $1 AND entity_id = $2', [event.entity_table, event.entity_id])
    else await rememberInboundRetry(local, event.entity_table, event.entity_id)
  }
  const next = rows.at(-1)?.id?.toString() || cursor
  await local.query("UPDATE aa_local.sync_state SET cursor = $1, last_success_at = now(), updated_at = now() WHERE stream = 'business_inbound'", [next])
  const retries = await local.query(`SELECT entity_table, entity_id FROM aa_local.inbound_retry
    WHERE last_attempt_at IS NULL OR last_attempt_at < now() - interval '5 minutes'
    ORDER BY last_attempt_at NULLS FIRST, entity_table, entity_id LIMIT 50`)
  for (const { entity_table, entity_id } of retries.rows) {
    if (await receiveChangedEntity(local, remote, entity_table, entity_id)) {
      await local.query('DELETE FROM aa_local.inbound_retry WHERE entity_table = $1 AND entity_id = $2', [entity_table, entity_id])
    } else await local.query('UPDATE aa_local.inbound_retry SET last_attempt_at = now() WHERE entity_table = $1 AND entity_id = $2', [entity_table, entity_id])
  }
  return { checked: rows.length, cursor: next, retry: retries.rows.length }
}

export async function receiveClinicalBatch(local, remote, table, cursor = null) {
  if (table !== 'clinical_records' && !clinicalResourceTables.includes(table)) throw new SyncConflict('Recurso clínico inválido.')
  if (cursor !== null && !uuid.test(cursor)) throw new SyncConflict('Cursor clínico inválido.')
  const actors = await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")
  const actor = actors.rows[0]?.id
  if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo.')
  let page
  let cloud
  await remote.query('BEGIN READ ONLY')
  try {
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
    page = await remote.query(`SELECT id FROM public.${table} WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT ${inboundBatchSize}`, [cursor])
    if (page.rows.length) cloud = await remote.query(`SELECT to_jsonb(t) AS snapshot FROM public.${table} t WHERE id = ANY($1::uuid[])`, [page.rows.map((row) => row.id)])
  } finally {
    await remote.query('ROLLBACK').catch(() => {})
  }
  const counts = { checked: page.rows.length, received: 0, protected: 0 }
  if (!page.rows.length) return { ...counts, cursor: null }
  const ids = page.rows.map((row) => row.id)
  const localRows = await local.query(`SELECT to_jsonb(t) AS snapshot FROM aa_local.${table} t WHERE id = ANY($1::uuid[])`, [ids])
  const incoming = new Map(cloud.rows.map(({ snapshot }) => [snapshot.id, snapshot]))
  const existing = new Map(localRows.rows.map(({ snapshot }) => [snapshot.id, snapshot]))
  for (const id of ids) {
    if (!incoming.has(id)) { counts.protected++; await rememberInboundRetry(local, table, id); continue }
    if (existing.has(id) && petContent(existing.get(id)) === petContent(incoming.get(id))) continue
    // Recheck pending operations under the row lock, including local deletions.
    const result = await receiveRow(local, remote, table, id, true, true)
    if (result.received) counts.received++
    else if (result.reason !== 'unchanged') { counts.protected++; await rememberInboundRetry(local, table, id) }
  }
  return { ...counts, cursor: ids.length === inboundBatchSize ? ids.at(-1) : null }
}

// Parents are removed only after their linked resources are gone.
export async function receiveDeletedBatch(local, remote, table, cursor = null, ids = null) {
  if (!syncTables.includes(table)) throw new SyncConflict('Recurso inválido.')
  if (cursor !== null && !uuid.test(cursor)) throw new SyncConflict('Cursor clínico inválido.')
  const page = ids
    ? await local.query(`SELECT id FROM aa_local.${table} WHERE id = ANY($1::uuid[])`, [ids])
    : await local.query(`SELECT id FROM aa_local.${table} WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT ${inboundBatchSize}`, [cursor])
  const counts = { checked: page.rows.length, deleted: 0, protected: 0 }
  if (!page.rows.length) return { ...counts, cursor: null }
  const actor = (await local.query("SELECT id FROM aa_local.profiles WHERE is_active AND role IN ('owner', 'veterinarian') ORDER BY id LIMIT 1")).rows[0]?.id
  if (!actor || !uuid.test(actor)) throw new SyncConflict('Falta un perfil clínico activo.')
  await remote.query('BEGIN READ ONLY')
  let cloud
  try {
    await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await remote.query('SET LOCAL ROLE authenticated')
    const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
    if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
    cloud = await remote.query(`SELECT id FROM public.${table} WHERE id = ANY($1::uuid[])`, [page.rows.map((row) => row.id)])
  } finally {
    await remote.query('ROLLBACK').catch(() => {})
  }
  const present = new Set(cloud.rows.map((row) => row.id))
  for (const { id } of page.rows) {
    if (present.has(id)) continue
    await local.query('BEGIN')
    try {
      const row = (await local.query(`SELECT id, row_version, remote_base_version FROM aa_local.${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!row) { await local.query('ROLLBACK'); continue }
      const operations = await local.query(`SELECT COALESCE(bool_or(status <> 'confirmed'), false) AS pending,
        max(source_version) FILTER (WHERE status = 'confirmed') AS confirmed_version
        FROM aa_local.sync_operations WHERE entity_table = '${table}' AND entity_id = $1`, [id])
      const history = operations.rows[0]
      const clean = !history.pending && (String(history.confirmed_version) === String(row.row_version)
        || row.remote_base_version !== null && String(row.remote_base_version) === String(row.row_version))
      if (!clean) { counts.protected++; await local.query('ROLLBACK'); await rememberInboundRetry(local, table, id); continue }
      if (table === 'clinical_records' || table === 'pets') {
        const children = await local.query(table === 'clinical_records'
          ? `SELECT EXISTS (SELECT 1 FROM aa_local.clinical_files WHERE clinical_record_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.medications WHERE clinical_record_id = $1) AS linked`
          : `SELECT EXISTS (SELECT 1 FROM aa_local.clinical_records WHERE pet_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.vaccinations WHERE pet_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.medications WHERE pet_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.allergies WHERE pet_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.pet_notes WHERE pet_id = $1)
            OR EXISTS (SELECT 1 FROM aa_local.weight_records WHERE pet_id = $1) AS linked`, [id])
        if (children.rows[0].linked) { counts.protected++; await local.query('ROLLBACK'); await rememberInboundRetry(local, table, id); continue }
      }
      // Recheck under the row lock so a concurrent local edit cannot be erased.
      await remote.query('BEGIN READ ONLY')
      try {
        await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
        await remote.query('SET LOCAL ROLE authenticated')
        const profile = await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [actor])
        if (!profile.rows[0]?.is_active || !['owner', 'veterinarian'].includes(profile.rows[0].role)) throw new SyncConflict('El perfil remoto no tiene permiso clínico.')
        const exists = await remote.query(`SELECT id FROM public.${table} WHERE id = $1`, [id])
        if (exists.rows.length) { await local.query('ROLLBACK'); continue }
      } finally {
        await remote.query('ROLLBACK').catch(() => {})
      }
      await local.query(`DELETE FROM aa_local.${table} WHERE id = $1`, [id])
      await local.query('COMMIT')
      counts.deleted++
    } catch (error) {
      await local.query('ROLLBACK').catch(() => {})
      throw error
    }
  }
  return { ...counts, cursor: !ids && page.rows.length === inboundBatchSize ? page.rows.at(-1).id : null }
}
