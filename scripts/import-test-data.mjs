import { Client } from 'pg'
import { assertTestEnvironment } from './test-environment.mjs'

assertTestEnvironment()

const testProject = 'wuenfwsjifwuupfjgubm'
const tables = [
  'profiles', 'pets', 'clinical_records', 'vaccinations', 'medications',
  'allergies', 'pet_notes', 'weight_records', 'clinical_files',
]
const sourceUrl = process.env.AA_TEST_DB_URL
const apply = process.argv[2] === '--apply'
if (process.argv.length > 3 || (process.argv[2] && !['--check', '--apply'].includes(process.argv[2]))) {
  throw new Error('Uso: node scripts/import-test-data.mjs [--check|--apply]')
}
if (!sourceUrl || !process.env.AA_DB_PASSWORD) {
  throw new Error('Faltan AA_TEST_DB_URL o AA_DB_PASSWORD. No se modificó ninguna base.')
}
const sourceAddress = new URL(sourceUrl)
if (!`${sourceAddress.hostname} ${sourceAddress.username}`.includes(testProject)) {
  throw new Error('El origen debe ser el proyecto Supabase de pruebas. No se modificó ninguna base.')
}
if (sourceAddress.hostname === `db.${testProject}.supabase.co`) {
  throw new Error('La URI es de conexión directa. En Supabase Connect elige Session pooler (puerto 5432).')
}

const source = new Client({ connectionString: sourceUrl })
const target = new Client({
  host: '127.0.0.1', port: Number(process.env.AA_DB_PORT || 5432),
  database: 'accion_animal_dev', user: 'aa_local_app', password: process.env.AA_DB_PASSWORD,
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
  await source.connect()
  await target.connect()
  const identity = await target.query('SELECT current_database() AS db, current_user AS role')
  if (identity.rows[0].db !== 'accion_animal_dev' || identity.rows[0].role !== 'aa_local_app') {
    throw new Error('Destino local inesperado.')
  }
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await target.query('BEGIN')
  targetStarted = true

  for (const table of [...tables.slice(1), 'sync_operations']) {
    const { rows } = await target.query(`SELECT EXISTS (SELECT 1 FROM aa_local.${table}) AS occupied`)
    if (rows[0].occupied) throw new Error(`El destino ya contiene ${table}; se canceló la importación.`)
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
    console.log('Datos de PRUEBAS importados en accion_animal_dev:', counts)
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
