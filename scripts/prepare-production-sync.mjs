import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { assertProductionEnvironment, productionRef } from './production-environment.mjs'
import { syncErrorCode } from '../server/local-sync.mjs'

assertProductionEnvironment()
const mode = process.argv[2]
if (!['--check', '--apply'].includes(mode) || process.argv.length !== 3) throw new Error('Uso: prepare-production-sync.mjs --check|--apply')
if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST || '') || !process.env.AA_PROD_DB_PASSWORD) {
  throw new Error('Faltan host o contraseña de producción; no se modificó ninguna base.')
}

const remote = new Client({
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `postgres.${productionRef}`, password: process.env.AA_PROD_DB_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000, statement_timeout: 10000,
})
const migrations = [
  '../supabase/migrations/20260926192506_offline_sync_receipts.sql',
  '../supabase/migrations/20260926211921_offline_profiles_inbound.sql',
  '../supabase/migrations/20260928184202_incremental_inbound_sync.sql',
]

let transactionOpen = false
try {
  await remote.connect()
  const identity = (await remote.query('SELECT current_user AS role, current_database() AS db')).rows[0]
  if (identity.role !== 'postgres' || identity.db !== 'postgres') throw new Error('Origen de producción inesperado.')
  await remote.query(mode === '--check' ? 'BEGIN READ ONLY' : 'BEGIN')
  transactionOpen = true
  const state = (await remote.query(`SELECT
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aa_sync_worker') AS worker,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'aa_sync') AS sync_schema,
    to_regclass('aa_sync.receipts') IS NOT NULL AS receipts,
    EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_sync_read') AS profiles_policy,
    EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_events' AND policyname = 'audit_events_sync_read') AS audit_policy,
    to_regclass('public.audit_events') IS NOT NULL AS audit_events`)).rows[0]
  const logFunction = (await remote.query(`SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'log_row_change' AND p.pronargs = 0`)).rows[0]?.definition || ''
  const orderedAudit = logFunction.includes('pg_advisory_xact_lock(904501)')
  const fresh = !state.worker && !state.sync_schema && !state.receipts
    && !state.profiles_policy && !state.audit_policy && !orderedAudit
    && state.audit_events && logFunction.includes('insert into public.audit_events')
  console.log('Preparación de producción:', { ...state, ordered_audit: orderedAudit, ready_to_apply: fresh })
  if (mode === '--apply') {
    if (!fresh) throw new Error('El esquema remoto no está en el estado inicial esperado; no se aplicaron migraciones.')
    for (const file of migrations) {
      const sql = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^\s*(begin|commit);\s*$/gmi, '')
      await remote.query(sql)
    }
    await remote.query('COMMIT')
    transactionOpen = false
    console.log('Migraciones de sincronización aplicadas en PRODUCCIÓN. La cuenta aa_sync_worker sigue sin LOGIN.')
  }
} catch (error) {
  console.error(`Preparación detenida. Código: ${syncErrorCode(error)}.`)
  process.exitCode = 1
} finally {
  if (transactionOpen) await remote.query('ROLLBACK').catch(() => {})
  await remote.end().catch(() => {})
}
