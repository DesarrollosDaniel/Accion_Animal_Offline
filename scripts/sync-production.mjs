import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'
import { sendPending, syncErrorCode, receiveProfiles, receivePetBatch, receiveNewPetBatch, receiveClinicalRecordBatch, receiveClinicalBatch, receiveDeletedBatch, receiveAuditBatch, clinicalResourceTables } from '../server/local-sync.mjs'

assertProductionEnvironment()
const mode = process.argv[2] || '--check'
if (process.argv.length > 3 || !['--check', '--once', '--watch'].includes(mode)) throw new Error('Uso: sync-production.mjs [--check|--once|--watch]')
if (!process.env.AA_DB_PASSWORD || !process.env.AA_PROD_WORKER_PASSWORD
  || !/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST || '')) {
  throw new Error('Carga host de Session pooler y contraseñas local/del trabajador de PRODUCCIÓN; no las compartas.')
}
const remoteSettings = {
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `aa_sync_worker.${productionRef}`, password: process.env.AA_PROD_WORKER_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
}
let remote
const local = new Client({ host: '127.0.0.1', ssl: false, port: Number(process.env.AA_DB_PORT || 5432), database: 'accion_animal_produ', user: 'aa_local_app', password: process.env.AA_DB_PASSWORD, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
let stopping = false
let profilesReported = false
let petCursor = null
let newPetCursor = null
let clinicalCursor = null
const resourceCursors = new Map()
const deletionCursors = new Map()
const bootstrapDone = new Set()
let inboundCursor
let stage = 'conexión a PostgreSQL local'
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })
try {
  await local.connect()
  stage = 'cuenta y bloqueo locales'
  const identity = await local.query('SELECT current_database() AS db, current_user AS role, pg_try_advisory_lock(904500) AS locked')
  if (identity.rows[0].db !== 'accion_animal_produ' || identity.rows[0].role !== 'aa_local_app' || !identity.rows[0].locked) throw new Error('Destino incorrecto o hay otro sincronizador ejecutándose.')
  if (['--once', '--watch'].includes(mode)) {
    stage = 'migraciones locales de recepción (005, 006 y 007)'
    for (const table of ['clinical_records', ...clinicalResourceTables]) {
      await local.query(`SELECT remote_base, remote_base_version FROM aa_local.${table} LIMIT 0`)
    }
    const state = await local.query("SELECT cursor FROM aa_local.sync_state WHERE stream = 'business_inbound'")
    if (state.rows.length !== 1) throw new Error('Falta la migración local 007.')
    inboundCursor = state.rows[0].cursor
  }
  do {
    remote = new Client(remoteSettings)
    // pg emits idle socket errors after a network outage; retry using a new connection.
    remote.on('error', () => {})
    try {
      stage = 'conexión SSL a Supabase'
      await remote.connect()
      stage = 'cuenta de sincronización remota'
      const remoteIdentity = await remote.query('SELECT current_user AS role, current_database() AS db')
      if (remoteIdentity.rows[0].role !== 'aa_sync_worker' || remoteIdentity.rows[0].db !== 'postgres') throw new Error('Cuenta remota inesperada.')
      stage = 'permisos de confirmaciones remotas'
      await remote.query('SELECT operation_id FROM aa_sync.receipts LIMIT 0')
      stage = 'permisos de auditoría remota'
      await remote.query('SELECT id FROM public.audit_events LIMIT 0')
      if (mode === '--check') {
        stage = 'lectura de la cola local'
        const pending = await local.query('SELECT status, count(*)::integer AS total FROM aa_local.sync_operations GROUP BY status ORDER BY status')
        console.log('Conexiones y confirmaciones disponibles. Sin enviar cambios:', pending.rows)
        const queued = await local.query("SELECT id, entity_table, entity_id, action, status FROM aa_local.sync_operations WHERE status = 'pending' ORDER BY created_at LIMIT 50")
        if (queued.rows.length) console.log('Pendientes que se enviarían (sin valores):', queued.rows)
        const problems = await local.query(`SELECT op.id, op.entity_table, op.entity_id, op.action, op.source_version, op.status,
          (op.payload ? '_sync_base') AS has_original, dep.status AS previous_status
          FROM aa_local.sync_operations AS op
          LEFT JOIN aa_local.sync_operations AS dep ON dep.id = op.depends_on_operation_id
          WHERE op.status IN ('conflict', 'blocked') ORDER BY op.created_at LIMIT 50`)
        if (problems.rows.length) console.log('Operaciones que requieren revisión (sin datos clínicos):', problems.rows)
      } else {
        stage = 'recepción de perfiles'
        const profiles = await receiveProfiles(local, remote)
        if (!profilesReported || mode === '--once') console.log('Perfiles de PRODUCCIÓN recibidos:', profiles)
        profilesReported = true
        stage = 'envío de la cola'
        const counts = await sendPending(local, remote)
        const unresolved = await local.query("SELECT EXISTS (SELECT 1 FROM aa_local.sync_operations WHERE status <> 'confirmed') AS pending")
        await local.query("UPDATE aa_local.sync_state SET last_attempt_at = now(), last_success_at = CASE WHEN $1 THEN now() ELSE last_success_at END, last_error = CASE WHEN $1 THEN NULL ELSE 'Hay operaciones pendientes o en conflicto' END, updated_at = now() WHERE stream = 'business_outbound'", [!unresolved.rows[0].pending])
        if (Object.values(counts).some(Boolean) || mode === '--once') console.log('Sincronización de PRODUCCIÓN:', counts)
        if (inboundCursor === null) {
          const start = await remote.query('SELECT COALESCE(max(id), 0)::text AS id FROM public.audit_events')
          inboundCursor = `bootstrap:${start.rows[0].id}`
          await local.query("UPDATE aa_local.sync_state SET cursor = $1, updated_at = now() WHERE stream = 'business_inbound'", [inboundCursor])
        }
        if (!inboundCursor.startsWith('bootstrap:')) {
          stage = 'recepción incremental'
          const incoming = await receiveAuditBatch(local, remote, inboundCursor)
          inboundCursor = incoming.cursor
          if (incoming.checked || incoming.retry || mode === '--once') console.log('Cambios remotos de PRODUCCIÓN:', incoming)
        } else {
          stage = 'recepción automática de mascotas'
          if (!bootstrapDone.has('pets')) {
            const incoming = await receivePetBatch(local, remote, petCursor)
            petCursor = incoming.cursor
            if (petCursor === null) bootstrapDone.add('pets')
            if (incoming.received || incoming.protected || mode === '--once') {
              const { cursor, ...totals } = incoming
              console.log('Recepción de mascotas de PRODUCCIÓN:', totals)
            }
          }
          stage = 'recepción automática de mascotas nuevas'
          if (!bootstrapDone.has('new_pets')) {
            const newPets = await receiveNewPetBatch(local, remote, newPetCursor)
            newPetCursor = newPets.cursor
            if (newPetCursor === null) bootstrapDone.add('new_pets')
            if (newPets.received || newPets.protected || mode === '--once') {
              const { cursor, ...totals } = newPets
              console.log('Mascotas nuevas de PRODUCCIÓN:', totals)
            }
          }
          stage = 'recepción automática de expedientes clínicos'
          if (!bootstrapDone.has('clinical_records')) {
            const records = await receiveClinicalRecordBatch(local, remote, clinicalCursor)
            clinicalCursor = records.cursor
            if (clinicalCursor === null) bootstrapDone.add('clinical_records')
            if (records.received || records.protected || mode === '--once') {
              const { cursor, ...totals } = records
              console.log('Expedientes clínicos de PRODUCCIÓN:', totals)
            }
          }
          for (const table of clinicalResourceTables) {
            if (bootstrapDone.has(table)) continue
            stage = `recepción automática de ${table}`
            const resources = await receiveClinicalBatch(local, remote, table, resourceCursors.get(table) || null)
            resourceCursors.set(table, resources.cursor)
            if (resources.cursor === null) bootstrapDone.add(table)
            if (resources.received || resources.protected || mode === '--once') {
              const { cursor, ...totals } = resources
              console.log('Recursos clínicos de PRODUCCIÓN (%s):', table, totals)
            }
          }
          for (const table of [...clinicalResourceTables, 'clinical_records', 'pets']) {
            if (bootstrapDone.has(`deleted_${table}`)) continue
            stage = `recepción de eliminaciones de ${table}`
            const deletions = await receiveDeletedBatch(local, remote, table, deletionCursors.get(table) || null)
            deletionCursors.set(table, deletions.cursor)
            if (deletions.cursor === null) bootstrapDone.add(`deleted_${table}`)
            if (deletions.deleted || deletions.protected || mode === '--once') {
              const { cursor, ...totals } = deletions
              if (table === 'pets') console.log('Eliminaciones de mascotas de PRODUCCIÓN:', totals)
              else console.log('Eliminaciones clínicas de PRODUCCIÓN (%s):', table, totals)
            }
          }
          if (bootstrapDone.size === 17) {
            inboundCursor = inboundCursor.slice('bootstrap:'.length)
            await local.query("UPDATE aa_local.sync_state SET cursor = $1, last_success_at = now(), updated_at = now() WHERE stream = 'business_inbound'", [inboundCursor])
            console.log('Carga inicial remota terminada; desde ahora se leerán solo cambios recientes.')
          }
        }
      }
    } catch (error) {
      if (mode !== '--watch') throw error
      console.error('Sincronización interrumpida en %s. Código: %s; se reintentará.', stage, syncErrorCode(error))
      await local.query("UPDATE aa_local.sync_state SET last_attempt_at = now(), last_error = 'Sincronización no completada; se reintentará', updated_at = now() WHERE stream IN ('business_outbound', 'profiles_inbound')")
    } finally {
      await remote.end().catch(() => {})
    }
    if (mode === '--watch' && !stopping) await setTimeout(inboundCursor?.startsWith('bootstrap:') ? 2000 : 30000)
  } while (!stopping && (mode === '--watch' || (mode === '--once' && inboundCursor?.startsWith('bootstrap:'))))
} catch (error) {
  console.error(`Fallo en ${stage}. Código: ${syncErrorCode(error)}.`)
  console.error('No se completó la sincronización. Revisa credenciales, certificado, migración y conexión; los cambios locales se conservan.')
  process.exitCode = 1
} finally {
  await Promise.allSettled([remote?.end(), local.end()])
}
