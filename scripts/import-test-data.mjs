import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { assertTestEnvironment } from './test-environment.mjs'

const testProject = 'wuenfwsjifwuupfjgubm'
const productionProject = 'hvfubwyzarikudisbwfy'
const production = process.argv[2] === '--production'
if (!production) assertTestEnvironment()
const tables = [
  'profiles', 'pets', 'clinical_records', 'vaccinations', 'medications',
  'allergies', 'pet_notes', 'weight_records', 'clinical_files',
]
const mode = process.argv[production ? 3 : 2] || '--check'
const apply = mode === '--apply'
const targetName = production ? 'accion_animal_produ' : 'accion_animal_dev'
const sourceUrl = process.env.AA_TEST_DB_URL
if (process.argv.length > (production ? 4 : 3) || !['--check', '--apply'].includes(mode)) {
  throw new Error('Uso: node scripts/import-test-data.mjs [--check|--apply] o --production [--check|--apply]')
}
if (!process.env.AA_DB_PASSWORD || (production ? !process.env.AA_PROD_DB_HOST || !process.env.AA_PROD_DB_PASSWORD : !sourceUrl)) {
  throw new Error('Faltan credenciales de origen o destino. No se modificó ninguna base.')
}
if (!production) {
  const sourceAddress = new URL(sourceUrl)
  if (!`${sourceAddress.hostname} ${sourceAddress.username}`.includes(testProject)) {
    throw new Error('El origen debe ser el proyecto Supabase de pruebas. No se modificó ninguna base.')
  }
  if (sourceAddress.hostname === `db.${testProject}.supabase.co`) {
    throw new Error('La URI es de conexión directa. En Supabase Connect elige Session pooler (puerto 5432).')
  }
} else if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(process.env.AA_PROD_DB_HOST)) {
  throw new Error('AA_PROD_DB_HOST debe ser el host Session pooler de Supabase. No se modificó ninguna base.')
}

const source = new Client(production ? {
  host: process.env.AA_PROD_DB_HOST, port: 5432, database: 'postgres',
  user: `postgres.${productionProject}`, password: process.env.AA_PROD_DB_PASSWORD,
  ssl: { rejectUnauthorized: true, ...(process.env.AA_SYNC_CA_FILE ? { ca: await readFile(process.env.AA_SYNC_CA_FILE, 'utf8') } : {}) },
  connectionTimeoutMillis: 5000,
} : { connectionString: sourceUrl })
const target = new Client({
  host: '127.0.0.1', ssl: false, port: Number(process.env.AA_DB_PORT || 5432),
  database: targetName, user: 'aa_local_app', password: process.env.AA_DB_PASSWORD,
})

function quote(name) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Columna inesperada en el origen.')
  return `"${name}"`
}

async function columns(client, schema, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table],
  )
  return rows.map(({ column_name }) => column_name)
}

let targetStarted = false
try {
  try {
    await source.connect()
  } catch (error) {
    throw new Error(`No se pudo conectar al origen ${production ? 'Supabase PRODUCCIÓN' : 'Supabase PRUEBAS'}: ${error.message}`, { cause: error })
  }
  try {
    await target.connect()
  } catch (error) {
    throw new Error(`No se pudo conectar al destino PostgreSQL local: ${error.message}`, { cause: error })
  }
  if (production) {
    await source.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    const remoteIdentity = await source.query('SELECT current_user AS role, current_database() AS db')
    if (remoteIdentity.rows[0].role !== 'postgres' || remoteIdentity.rows[0].db !== 'postgres') {
      throw new Error('Origen de producción inesperado. No se importó ningún dato.')
    }
  }
  const identity = await target.query('SELECT current_database() AS db, current_user AS role')
  if (identity.rows[0].db !== targetName || identity.rows[0].role !== 'aa_local_app') {
    throw new Error('Destino local inesperado.')
  }
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  if (production && (await source.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') {
    throw new Error('La transacción de producción no es de solo lectura.')
  }
  await target.query('BEGIN')
  targetStarted = true

  for (const table of [...tables.slice(1), 'sync_operations']) {
    const { rows } = await target.query(`SELECT EXISTS (SELECT 1 FROM aa_local.${table}) AS occupied`)
    if (rows[0].occupied) throw new Error(`El destino ya contiene ${table}; se canceló la importación.`)
  }
  if (production) {
    const state = await target.query("SELECT count(*)::integer AS total FROM aa_local.sync_state WHERE stream IN ('business_outbound', 'profiles_inbound', 'business_inbound')")
    if (state.rows[0].total !== 3) throw new Error('Faltan los tres estados de sincronización locales.')
  }

  const existingProfiles = await target.query('SELECT id FROM aa_local.profiles')
  const importedProfiles = new Set()
  const counts = {}
  for (const table of tables) {
    const sourceColumns = await columns(source, 'public', table)
    const localColumns = new Set(await columns(target, 'aa_local', table))
    if (!sourceColumns.length || sourceColumns.some((column) => !localColumns.has(column))) {
      throw new Error(`Las columnas de ${table} no coinciden entre origen y destino.`)
    }
    const names = sourceColumns.map(quote).join(', ')
    const values = sourceColumns.map((_, index) => `$${index + 1}`).join(', ')
    counts[table] = 0
    let lastId = null
    for (;;) {
      // ponytail: páginas de 500 filas; usar COPY si el volumen real vuelve lento el traslado.
      const { rows } = await source.query(
        `SELECT ${names} FROM public.${table}
         WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 500`, [lastId],
      )
      if (!rows.length) break
      for (const row of rows) {
        if (table === 'profiles') importedProfiles.add(row.id)
        await target.query(
          `INSERT INTO aa_local.${table} (${names}) VALUES (${values})`
            + (table === 'profiles' ? ` ON CONFLICT (id) DO UPDATE SET ${sourceColumns
              .filter((column) => column !== 'id')
              .map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`).join(', ')}` : ''),
          sourceColumns.map((column) => row[column]),
        )
        counts[table] += 1
      }
      lastId = rows.at(-1).id
    }
  }
  if (existingProfiles.rows.some(({ id }) => !importedProfiles.has(id))) {
    throw new Error('Hay perfiles locales que no pertenecen al origen de pruebas.')
  }
  for (const table of tables) {
    const { rows } = await target.query(`SELECT count(*)::integer AS total FROM aa_local.${table}`)
    if (rows[0].total !== counts[table]) throw new Error(`El recuento de ${table} no coincide.`)
  }
  const queued = await target.query('SELECT count(*)::integer AS total FROM aa_local.sync_operations')
  if (queued.rows[0].total) throw new Error('La importación inicial creó operaciones pendientes inesperadas.')
  await source.query('COMMIT')
  if (apply) {
    await target.query('COMMIT')
    targetStarted = false
    console.log(`Datos de ${production ? 'PRODUCCIÓN' : 'PRUEBAS'} importados en ${targetName}:`, counts)
  } else {
    await target.query('ROLLBACK')
    targetStarted = false
    console.log('Ensayo correcto; ROLLBACK, sin cambios locales:', counts)
  }
} catch (error) {
  if (targetStarted) await target.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await Promise.allSettled([source.end(), target.end()])
}
