import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'
import { syncErrorCode } from '../server/local-sync.mjs'

assertProductionEnvironment()
if (process.argv.length !== 2) throw new Error('Uso: check-production-sync.mjs')
if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST || '')
  || !process.env.AA_PROD_DB_PASSWORD || !process.env.AA_DB_PASSWORD) {
  throw new Error('Faltan host o contraseñas de producción/local; no se modificó ninguna base.')
}

const remote = new Client({
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `postgres.${productionRef}`, password: process.env.AA_PROD_DB_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
})
const local = new Client({
  host: '127.0.0.1', port: Number(process.env.AA_DB_PORT || 5432), database: 'accion_animal_produ',
  user: 'aa_local_app', password: process.env.AA_DB_PASSWORD, ssl: false,
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
})

try {
  await remote.connect()
  await remote.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  await remote.query('BEGIN READ ONLY')
  const source = (await remote.query(`SELECT current_user AS role, current_database() AS db,
    current_setting('transaction_read_only') AS read_only,
    to_regclass('aa_sync.receipts') IS NOT NULL AS receipts,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aa_sync_worker') AS worker_exists,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aa_sync_worker' AND rolcanlogin) AS worker_login,
    to_regclass('public.audit_events') IS NOT NULL AS audit_events`)).rows[0]
  if (source.role !== 'postgres' || source.db !== 'postgres' || source.read_only !== 'on') throw new Error('Origen de producción inesperado.')
  const auditFunction = (await remote.query(`SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'log_row_change' AND p.pronargs = 0`)).rows[0]?.definition || ''
  const remoteStatus = {
    receipts: source.receipts,
    worker_exists: source.worker_exists,
    worker_login: source.worker_login,
    audit_events: source.audit_events,
    ordered_audit: auditFunction.includes('pg_advisory_xact_lock(904501)'),
  }
  await remote.query('ROLLBACK')

  await local.connect()
  await local.query('BEGIN READ ONLY')
  const destination = (await local.query('SELECT current_user AS role, current_database() AS db')).rows[0]
  if (destination.role !== 'aa_local_app' || destination.db !== 'accion_animal_produ') throw new Error('Destino local inesperado.')
  const queue = (await local.query(`SELECT action, status, count(*)::integer AS total
    FROM aa_local.sync_operations GROUP BY action, status ORDER BY action, status`)).rows
  const pending = (await local.query(`SELECT id, entity_table, entity_id, action, status
    FROM aa_local.sync_operations WHERE status <> 'confirmed' ORDER BY created_at LIMIT 20`)).rows
  const confirmations = (await local.query(`SELECT op.id, op.entity_table, op.action,
    c.operation_id IS NOT NULL AS has_receipt, c.response->>'manual_production' AS manual_production
    FROM aa_local.sync_operations op LEFT JOIN aa_local.sync_confirmations c ON c.operation_id = op.id
    WHERE op.status = 'confirmed' ORDER BY op.created_at DESC LIMIT 20`)).rows
  const state = (await local.query('SELECT stream, cursor IS NOT NULL AS has_cursor FROM aa_local.sync_state ORDER BY stream')).rows
  const inboundRetry = (await local.query("SELECT to_regclass('aa_local.inbound_retry') IS NOT NULL AS exists")).rows[0].exists
  const retries = inboundRetry ? (await local.query('SELECT entity_table, entity_id FROM aa_local.inbound_retry ORDER BY entity_table, entity_id LIMIT 20')).rows : []
  await local.query('ROLLBACK')
  console.log('Supabase PRODUCCIÓN (solo lectura):', remoteStatus)
  console.log('Cola local por acción y estado:', queue)
  console.log('Operaciones locales sin confirmar (solo identificadores):', pending)
  console.log('Confirmaciones locales:', confirmations)
  console.log('Estado local:', state, 'Reintentos de recepción:', inboundRetry)
  if (retries.length) console.log('Recepciones pendientes (sin valores):', retries)
} catch (error) {
  console.error(`Diagnóstico incompleto. Código: ${syncErrorCode(error)}.`)
  process.exitCode = 1
} finally {
  await Promise.allSettled([remote.end(), local.end()])
}
