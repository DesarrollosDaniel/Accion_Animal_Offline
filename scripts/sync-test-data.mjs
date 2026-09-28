import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { createInterface } from 'node:readline/promises'
import { assertTestEnvironment, testProjectRef } from './test-environment.mjs'
import { sendPending, syncErrorCode, reviewConflict, resolveReviewedConflict, receiveProfiles, comparePets, receivePet, receivePetBatch, receiveNewPetBatch, receiveClinicalRecordBatch, receiveClinicalBatch, receiveDeletedBatch, clinicalResourceTables } from '../server/local-sync.mjs'

assertTestEnvironment()
const mode = process.argv[2] || '--check'
if (['--resolve-local', '--pet-receive'].includes(mode) ? process.argv.length !== 4 : process.argv.length > 3 || !['--check', '--once', '--watch', '--profiles', '--pets-check'].includes(mode)) throw new Error('Uso: sync-test-data.mjs [--check|--once|--watch|--profiles|--pets-check|--resolve-local UUID|--pet-receive UUID]')
if (!process.env.AA_DB_PASSWORD || !process.env.AA_SYNC_DB_URL) throw new Error('Carga AA_DB_PASSWORD y AA_SYNC_DB_URL en esta terminal; no las compartas.')
let address
try { address = new URL(process.env.AA_SYNC_DB_URL) } catch { throw new Error('URI de sincronización inválida.') }
if (!['postgres:', 'postgresql:'].includes(address.protocol) || !/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(address.hostname)
  || decodeURIComponent(address.username) !== `aa_sync_worker.${testProjectRef}` || address.port !== '5432' || address.pathname !== '/postgres' || address.search || address.hash) {
  throw new Error('Usa Session pooler, puerto 5432, usuario aa_sync_worker del proyecto de PRUEBAS; sin parámetros adicionales.')
}
const remoteSettings = { connectionString: address.toString(), ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) }, connectionTimeoutMillis: 5000, statement_timeout: 10000 }
let remote
const local = new Client({ host: '127.0.0.1', ssl: false, port: 5432, database: 'accion_animal_dev', user: 'aa_local_app', password: process.env.AA_DB_PASSWORD, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
let stopping = false
let profilesReported = false
let petCursor = null
let newPetCursor = null
let clinicalCursor = null
const resourceCursors = new Map()
const deletionCursors = new Map()
let stage = 'conexión a PostgreSQL local'
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })
try {
  await local.connect()
  stage = 'cuenta y bloqueo locales'
  const identity = await local.query('SELECT current_database() AS db, current_user AS role, pg_try_advisory_lock(904500) AS locked')
  if (identity.rows[0].db !== 'accion_animal_dev' || identity.rows[0].role !== 'aa_local_app' || !identity.rows[0].locked) throw new Error('Destino incorrecto o hay otro sincronizador ejecutándose.')
  if (['--once', '--watch'].includes(mode)) {
    stage = 'migraciones locales de recepción (005 y 006)'
    for (const table of ['clinical_records', ...clinicalResourceTables]) {
      await local.query(`SELECT remote_base, remote_base_version FROM aa_local.${table} LIMIT 0`)
    }
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
      if (mode === '--resolve-local') {
        stage = 'revisión de la edición en conflicto'
        const review = await reviewConflict(local, remote, process.argv[3])
        console.log('Cambios propuestos:', JSON.stringify(review.differences, null, 2))
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        let answer
        try { answer = await prompt.question('Escribe APLICAR para conservar esta edición local: ') } finally { prompt.close() }
        if (answer.trim() === 'APLICAR') {
          console.log('Resolución:', await resolveReviewedConflict(local, remote, review.operation, review.remote_hash))
        } else console.log('Cancelado; no se enviaron cambios.')
      } else if (mode === '--pet-receive') {
        stage = 'recepción manual de mascota'
        console.log('Mascota de PRUEBAS recibida:', await receivePet(local, remote, process.argv[3]))
      } else if (mode === '--pets-check') {
        stage = 'comparación de mascotas (solo lectura)'
        console.log('Comparación de mascotas, sin modificar datos:', JSON.stringify(await comparePets(local, remote), null, 2))
      } else if (mode === '--profiles') {
        stage = 'recepción de perfiles'
        console.log('Perfiles de PRUEBAS recibidos:', await receiveProfiles(local, remote))
      } else if (mode === '--check') {
        stage = 'lectura de la cola local'
        const pending = await local.query('SELECT status, count(*)::integer AS total FROM aa_local.sync_operations GROUP BY status ORDER BY status')
        console.log('Conexiones y confirmaciones disponibles. Sin enviar cambios:', pending.rows)
        const problems = await local.query(`SELECT op.id, op.entity_table, op.entity_id, op.action, op.source_version, op.status,
          (op.payload ? '_sync_base') AS has_original, dep.status AS previous_status
          FROM aa_local.sync_operations AS op
          LEFT JOIN aa_local.sync_operations AS dep ON dep.id = op.depends_on_operation_id
          WHERE op.status IN ('conflict', 'blocked') ORDER BY op.created_at LIMIT 50`)
        if (problems.rows.length) console.log('Operaciones que requieren revisión (sin datos clínicos):', problems.rows)
        for (const problem of problems.rows.filter((row) => row.action === 'UPDATE' && row.status === 'conflict')) {
          stage = 'comparación del conflicto (solo lectura)'
          console.log('Comparación local / Supabase:', JSON.stringify(await reviewConflict(local, remote, problem.id), null, 2))
        }
      } else {
        stage = 'recepción de perfiles'
        const profiles = await receiveProfiles(local, remote)
        if (!profilesReported || mode === '--once') console.log('Perfiles de PRUEBAS recibidos:', profiles)
        profilesReported = true
        stage = 'envío de la cola'
        const counts = await sendPending(local, remote)
        const unresolved = await local.query("SELECT EXISTS (SELECT 1 FROM aa_local.sync_operations WHERE status <> 'confirmed') AS pending")
        await local.query("UPDATE aa_local.sync_state SET last_attempt_at = now(), last_success_at = CASE WHEN $1 THEN now() ELSE last_success_at END, last_error = CASE WHEN $1 THEN NULL ELSE 'Hay operaciones pendientes o en conflicto' END, updated_at = now() WHERE stream = 'business_outbound'", [!unresolved.rows[0].pending])
        if (Object.values(counts).some(Boolean) || mode === '--once') console.log('Sincronización de PRUEBAS:', counts)
        stage = 'recepción automática de mascotas'
        const incoming = await receivePetBatch(local, remote, petCursor)
        petCursor = incoming.cursor
        if (incoming.received || incoming.protected || mode === '--once') {
          const { cursor, ...totals } = incoming
          console.log('Recepción de mascotas de PRUEBAS:', totals)
        }
        stage = 'recepción automática de mascotas nuevas'
        const newPets = await receiveNewPetBatch(local, remote, newPetCursor)
        newPetCursor = newPets.cursor
        if (newPets.received || newPets.protected || mode === '--once') {
          const { cursor, ...totals } = newPets
          console.log('Mascotas nuevas de PRUEBAS:', totals)
        }
        stage = 'recepción automática de expedientes clínicos'
        const records = await receiveClinicalRecordBatch(local, remote, clinicalCursor)
        clinicalCursor = records.cursor
        if (records.received || records.protected || mode === '--once') {
          const { cursor, ...totals } = records
          console.log('Expedientes clínicos de PRUEBAS:', totals)
        }
        for (const table of clinicalResourceTables) {
          stage = `recepción automática de ${table}`
          const resources = await receiveClinicalBatch(local, remote, table, resourceCursors.get(table) || null)
          resourceCursors.set(table, resources.cursor)
          if (resources.received || resources.protected || mode === '--once') {
            const { cursor, ...totals } = resources
            console.log('Recursos clínicos de PRUEBAS (%s):', table, totals)
          }
        }
        for (const table of [...clinicalResourceTables, 'clinical_records', 'pets']) {
          stage = `recepción de eliminaciones de ${table}`
          const deletions = await receiveDeletedBatch(local, remote, table, deletionCursors.get(table) || null)
          deletionCursors.set(table, deletions.cursor)
          if (deletions.deleted || deletions.protected || mode === '--once') {
            const { cursor, ...totals } = deletions
            if (table === 'pets') console.log('Eliminaciones de mascotas de PRUEBAS:', totals)
            else console.log('Eliminaciones clínicas de PRUEBAS (%s):', table, totals)
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
    if (mode === '--watch' && !stopping) await setTimeout(30000)
  } while (mode === '--watch' && !stopping)
} catch (error) {
  console.error(`Fallo en ${stage}. Código: ${syncErrorCode(error)}.`)
  console.error('No se completó la sincronización. Revisa credenciales, certificado, migración y conexión; los cambios locales se conservan.')
  process.exitCode = 1
} finally {
  await Promise.allSettled([remote?.end(), local.end()])
}
