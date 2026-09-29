import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'
import { canonicalRow, SyncConflict, syncErrorCode } from '../server/local-sync.mjs'

assertProductionEnvironment()
const [mode, petId, operationId] = process.argv.slice(2)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!['--check', '--apply'].includes(mode) || process.argv.length !== 5 || !uuid.test(petId) || !uuid.test(operationId)) {
  throw new Error('Uso: send-production-pet-name.mjs --check|--apply UUID_MASCOTA UUID_OPERACIÓN')
}
if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST || '')
  || !process.env.AA_PROD_DB_PASSWORD || !process.env.AA_DB_PASSWORD) {
  throw new Error('Faltan host o contraseñas de producción/local; no se modificó ninguna base.')
}

const local = new Client({
  host: '127.0.0.1', port: Number(process.env.AA_DB_PORT || 5432), database: 'accion_animal_produ',
  user: 'aa_local_app', password: process.env.AA_DB_PASSWORD, ssl: false,
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
})
const remote = new Client({
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `postgres.${productionRef}`, password: process.env.AA_PROD_DB_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
})

let localOpen = false
let remoteOpen = false
try {
  await local.connect()
  const destination = (await local.query('SELECT current_user AS role, current_database() AS db')).rows[0]
  if (destination.role !== 'aa_local_app' || destination.db !== 'accion_animal_produ') throw new SyncConflict('Destino local inesperado.')
  await remote.connect()
  if (mode === '--check') await remote.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  const origin = (await remote.query('SELECT current_user AS role, current_database() AS db')).rows[0]
  if (origin.role !== 'postgres' || origin.db !== 'postgres') throw new SyncConflict('Origen de producción inesperado.')

  await local.query(mode === '--check' ? 'BEGIN READ ONLY' : 'BEGIN')
  localOpen = true
  const pet = (await local.query(`SELECT * FROM aa_local.pets WHERE id = $1${mode === '--apply' ? ' FOR UPDATE' : ''}`, [petId])).rows[0]
  const operations = (await local.query(`SELECT * FROM aa_local.sync_operations
    WHERE entity_table = 'pets' AND entity_id = $1 AND status <> 'confirmed' ORDER BY created_at${mode === '--apply' ? ' FOR UPDATE' : ''}`, [petId])).rows
  if (!pet || operations.length !== 1 || operations[0].id !== operationId) {
    const recent = (await local.query(`SELECT id, action, status, source_version FROM aa_local.sync_operations
      WHERE entity_table = 'pets' AND entity_id = $1 ORDER BY created_at DESC LIMIT 3`, [petId])).rows
    console.log('Diagnóstico local (sin datos de la mascota):', {
      pet_exists: Boolean(pet),
      operations: recent,
    })
    throw new SyncConflict('La mascota o su cola local cambió; no se enviará nada.')
  }
  const op = operations[0]
  if (op.action !== 'UPDATE' || op.status !== 'pending' || !uuid.test(op.actor_id)
    || String(op.source_version) !== String(op.payload.row_version)
    || String(op.source_version) !== String(pet.row_version)
    || canonicalRow(op.payload) !== canonicalRow(pet)) throw new SyncConflict('La edición local ya no coincide con la operación pendiente.')
  if (op.depends_on_operation_id) {
    const previous = (await local.query('SELECT status FROM aa_local.sync_operations WHERE id = $1', [op.depends_on_operation_id])).rows[0]
    if (previous?.status !== 'confirmed') throw new SyncConflict('Hay una operación anterior sin confirmar.')
  }
  const base = op.payload.remote_base || op.payload._sync_base
  if (!base || base.id !== petId || typeof op.payload.name !== 'string') throw new SyncConflict('Falta una versión original verificable.')
  const audit = new Set(['created_at', 'updated_at', 'created_by', 'updated_by'])
  const changed = [...new Set([...Object.keys(base), ...Object.keys(op.payload)])]
    .filter((field) => !audit.has(field) && canonicalRow({ [field]: base[field] }) !== canonicalRow({ [field]: op.payload[field] }))
  if (changed.length !== 1 || changed[0] !== 'name') throw new SyncConflict('Esta operación modifica otros campos; no se enviará con este comando.')

  await remote.query(mode === '--check' ? 'BEGIN READ ONLY' : 'BEGIN')
  remoteOpen = true
  await remote.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: op.actor_id, role: 'authenticated' })])
  await remote.query('SET LOCAL ROLE authenticated')
  const actor = (await remote.query('SELECT role, is_active FROM public.profiles WHERE id = $1', [op.actor_id])).rows[0]
  if (!actor?.is_active || !['owner', 'veterinarian'].includes(actor.role)) throw new SyncConflict('El autor local no tiene permiso clínico activo en Supabase.')
  const snapshot = (await remote.query(`SELECT to_jsonb(p) AS snapshot FROM public.pets p WHERE id = $1${mode === '--apply' ? ' FOR UPDATE' : ''}`, [petId])).rows[0]?.snapshot
  if (!snapshot) throw new SyncConflict('La mascota no está disponible en Supabase.')
  const otherRemoteChanges = [...new Set([...Object.keys(base), ...Object.keys(snapshot)])]
    .filter((field) => !audit.has(field) && field !== 'name'
      && canonicalRow({ [field]: base[field] }) !== canonicalRow({ [field]: snapshot[field] }))
  if (otherRemoteChanges.length) throw new SyncConflict('Supabase tiene otros cambios desde la versión original; no se sobrescribirán.')
  const alreadyApplied = snapshot.name === op.payload.name
  if (!alreadyApplied && canonicalRow(base) !== canonicalRow(snapshot)) throw new SyncConflict('Supabase cambió desde la versión original; no se sobrescribirá.')
  if (mode === '--check') {
    console.log('Verificación correcta: solo nombre; autor autorizado y versión remota comprobada.')
    console.log(alreadyApplied ? 'El nombre ya coincide en Supabase; solo falta confirmar la cola local.' : 'El nombre local está listo para enviarse a Supabase.')
    console.log('No se modificó ninguna base.')
  } else {
    let applied = snapshot
    if (!alreadyApplied) {
      const result = await remote.query('UPDATE public.pets AS p SET name = $1 WHERE id = $2 RETURNING to_jsonb(p) AS snapshot', [op.payload.name, petId])
      if (result.rows.length !== 1) throw new SyncConflict('Supabase rechazó la edición.')
      applied = result.rows[0].snapshot
    }
    await remote.query('COMMIT')
    remoteOpen = false
    await local.query('UPDATE aa_local.pets SET remote_base = $1::jsonb, remote_base_version = row_version + 1 WHERE id = $2', [JSON.stringify(applied), petId])
    await local.query('INSERT INTO aa_local.sync_confirmations (operation_id, remote_entity_id, remote_version, response) VALUES ($1, $2, $3, $4) ON CONFLICT (operation_id) DO NOTHING', [operationId, petId, op.source_version, { manual_production: true }])
    await local.query("UPDATE aa_local.sync_operations SET status = 'confirmed' WHERE id = $1 AND status = 'pending'", [operationId])
    await local.query('COMMIT')
    localOpen = false
    console.log(alreadyApplied ? 'Cola local confirmada; Supabase ya tenía ese nombre.' : 'Nombre enviado a Supabase y cola local confirmada.')
  }
} catch (error) {
  console.error(error instanceof SyncConflict ? error.message : `No se completó el envío. Código: ${syncErrorCode(error)}.`)
  process.exitCode = 1
} finally {
  if (remoteOpen) await remote.query('ROLLBACK').catch(() => {})
  if (localOpen) await local.query('ROLLBACK').catch(() => {})
  await Promise.allSettled([remote.end(), local.end()])
}
