import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'
import { canonicalRow, receivePet, SyncConflict, syncErrorCode } from '../server/local-sync.mjs'

assertProductionEnvironment()
const mode = process.argv[2]
const petId = process.argv[3]
if (!['--check', '--once', '--watch'].includes(mode) || process.argv.length !== 4
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(petId)) {
  throw new Error('Uso: receive-production-pet.mjs --check|--once|--watch UUID_DE_MASCOTA')
}
if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST || '')
  || !process.env.AA_PROD_DB_PASSWORD || !process.env.AA_DB_PASSWORD) {
  throw new Error('Faltan host o contraseñas de producción/local; no se modificó ninguna base.')
}

const remoteSettings = {
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `postgres.${productionRef}`, password: process.env.AA_PROD_DB_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
}
const localSettings = {
  host: '127.0.0.1', port: Number(process.env.AA_DB_PORT || 5432), database: 'accion_animal_produ',
  user: 'aa_local_app', password: process.env.AA_DB_PASSWORD, ssl: false,
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
}

let stopping = false
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })

async function receiveOnce() {
  const remote = new Client(remoteSettings)
  const local = new Client(localSettings)
  try {
    await remote.connect()
    await remote.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    const origin = (await remote.query('SELECT current_user AS role, current_database() AS db')).rows[0]
    if (origin.role !== 'postgres' || origin.db !== 'postgres') throw new SyncConflict('Origen de producción inesperado.')
    await local.connect()
    const destination = (await local.query('SELECT current_user AS role, current_database() AS db')).rows[0]
    if (destination.role !== 'aa_local_app' || destination.db !== 'accion_animal_produ') throw new SyncConflict('Destino local inesperado.')

    const existing = await local.query('SELECT to_jsonb(p) AS snapshot FROM aa_local.pets p WHERE id = $1', [petId])
    if (!existing.rows.length) throw new SyncConflict('La mascota no existe en la copia local; no se insertará automáticamente.')
    const pending = await local.query("SELECT id, action, status, created_at FROM aa_local.sync_operations WHERE entity_table = 'pets' AND entity_id = $1 AND status <> 'confirmed' ORDER BY created_at", [petId])
    if (pending.rows.length) {
      console.log('Operaciones locales protegidas (sin datos de la mascota):', pending.rows)
      if (mode !== '--check') throw new SyncConflict('La mascota tiene cambios locales pendientes; no se sobrescribirá.')
    }

    await remote.query('BEGIN READ ONLY')
    let cloud
    try {
      const readOnly = (await remote.query('SHOW transaction_read_only')).rows[0].transaction_read_only
      if (readOnly !== 'on') throw new SyncConflict('La conexión remota no es de solo lectura.')
      cloud = (await remote.query('SELECT to_jsonb(p) AS snapshot FROM public.pets p WHERE id = $1', [petId])).rows[0]?.snapshot
    } finally {
      await remote.query('ROLLBACK').catch(() => {})
    }
    if (!cloud) throw new SyncConflict('La mascota no existe en Supabase; no se eliminará la copia local.')
    if (mode === '--check') {
      const differentFields = [...new Set([...Object.keys(cloud), ...Object.keys(existing.rows[0].snapshot)])]
        .filter((field) => canonicalRow({ [field]: cloud[field] }) !== canonicalRow({ [field]: existing.rows[0].snapshot[field] }))
      console.log(pending.rows.length ? 'Comprobación correcta: edición local protegida. Supabase solo lectura.'
        : 'Comprobación correcta: mascota en ambas bases, sin cambios locales pendientes. Supabase solo lectura.')
      console.log('Campos distintos (sin valores):', differentFields.length ? differentFields.join(', ') : 'ninguno')
    } else {
      const result = await receivePet(local, remote, petId, true)
      if (result.received || mode !== '--watch') console.log(result.received ? 'Mascota actualizada en PostgreSQL local. Supabase no se modificó.'
        : `Sin cambio local: ${result.reason}. Supabase no se modificó.`)
    }
  } finally {
    await Promise.allSettled([remote.end(), local.end()])
  }
}

try {
  do {
    await receiveOnce()
    if (mode === '--watch' && !stopping) await setTimeout(30000)
  } while (mode === '--watch' && !stopping)
} catch (error) {
  console.error(error instanceof SyncConflict ? error.message : `No se completó la recepción. Código: ${syncErrorCode(error)}.`)
  process.exitCode = 1
}
