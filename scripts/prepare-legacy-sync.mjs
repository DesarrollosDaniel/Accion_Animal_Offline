import fs from 'node:fs'
import path from 'node:path'

const [sourceArg = 'accion_animal (5).sql', uploadsArg = 'uploaded', outputArg] = process.argv.slice(2)
const sourcePath = path.resolve(sourceArg)
const uploadsPath = path.resolve(uploadsArg)
const outputPath = path.resolve(outputArg || path.join(process.env.TEMP || process.cwd(), 'accion-animal-legacy-sync'))
const stageSchema = 'legacy_sync_20260910'
const maxBatchChars = 350_000

if (!fs.existsSync(sourcePath)) throw new Error(`No existe el respaldo: ${sourcePath}`)
if (!fs.existsSync(uploadsPath)) throw new Error(`No existe la carpeta uploaded: ${uploadsPath}`)
if (path.basename(outputPath) !== 'accion-animal-legacy-sync') {
  throw new Error('La carpeta temporal debe llamarse exactamente accion-animal-legacy-sync')
}

fs.rmSync(outputPath, { recursive: true, force: true })
fs.mkdirSync(outputPath, { recursive: true })

const sql = fs.readFileSync(sourcePath, 'utf8')

function mysqlUnescape(value) {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    if (current !== '\\' || index + 1 >= value.length) {
      result += current
      continue
    }
    const next = value[index + 1]
    index += 1
    const escapes = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }
    result += escapes[next] ?? next
  }
  return result
}

function parseScalar(raw) {
  const value = raw.trim()
  if (/^null$/i.test(value)) return null
  if (value.startsWith("'") && value.endsWith("'")) return mysqlUnescape(value.slice(1, -1))
  return value
}

function parseTuples(statement) {
  const rows = []
  let inString = false
  let escaped = false
  let depth = 0
  let tupleStart = -1

  for (let index = 0; index < statement.length; index += 1) {
    const current = statement[index]
    if (inString) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === "'") inString = false
      continue
    }
    if (current === "'") {
      inString = true
      continue
    }
    if (current === '(') {
      if (depth === 0) tupleStart = index + 1
      depth += 1
    } else if (current === ')') {
      depth -= 1
      if (depth === 0 && tupleStart >= 0) {
        const tuple = statement.slice(tupleStart, index)
        const values = []
        let valueStart = 0
        let valueInString = false
        let valueEscaped = false
        for (let cursor = 0; cursor <= tuple.length; cursor += 1) {
          const char = tuple[cursor]
          if (valueInString) {
            if (valueEscaped) valueEscaped = false
            else if (char === '\\') valueEscaped = true
            else if (char === "'") valueInString = false
          } else if (char === "'") valueInString = true
          else if (char === ',' || cursor === tuple.length) {
            values.push(parseScalar(tuple.slice(valueStart, cursor)))
            valueStart = cursor + 1
          }
        }
        rows.push(values)
        tupleStart = -1
      }
    }
  }
  return rows
}

function extractTable(tableName) {
  const marker = `INSERT INTO \`${tableName}\``
  const rows = []
  let cursor = 0
  while ((cursor = sql.indexOf(marker, cursor)) !== -1) {
    const valuesAt = sql.indexOf(' VALUES', cursor)
    if (valuesAt === -1) throw new Error(`INSERT incompleto para ${tableName}`)
    let inString = false
    let escaped = false
    let end = valuesAt + 7
    for (; end < sql.length; end += 1) {
      const current = sql[end]
      if (inString) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === "'") inString = false
      } else if (current === "'") inString = true
      else if (current === ';') break
    }
    if (end >= sql.length) throw new Error(`No se encontró el final de un INSERT de ${tableName}`)
    rows.push(...parseTuples(sql.slice(valuesAt + 7, end)))
    cursor = end + 1
  }
  return rows
}

function cleanText(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function normalizeRelative(value) {
  if (!value) return null
  const normalized = String(value).trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '')
  if (!normalized || normalized.split('/').some((part) => part === '..')) return null
  return normalized.toLowerCase().startsWith('uploaded/') ? normalized : `uploaded/${normalized}`
}

function walkFiles(directory) {
  const files = []
  if (!fs.existsSync(directory)) return files
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'es'))
}

const rootFiles = fs.readdirSync(uploadsPath, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
const rootFilesByLowerName = new Map(rootFiles.map((name) => [name.toLowerCase(), name]))

function resolvePetPhoto(value) {
  const cleaned = cleanText(value)
  if (!cleaned) return { path: null, status: 'empty' }
  const relative = normalizeRelative(cleaned)
  if (relative) {
    const fullPath = path.resolve(path.dirname(uploadsPath), relative.replaceAll('/', path.sep))
    if (fullPath.startsWith(path.dirname(uploadsPath)) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return { path: relative.replaceAll('\\', '/'), status: 'exact' }
    }
  }
  const baseName = path.basename(cleaned.replaceAll('\\', '/'))
  const exact = rootFilesByLowerName.get(baseName.toLowerCase())
  if (exact) return { path: `uploaded/${exact}`, status: 'exact' }
  const candidates = rootFiles.filter((name) => name.toLowerCase().startsWith(baseName.toLowerCase()))
  if (candidates.length) {
    candidates.sort((left, right) => left.length - right.length || left.localeCompare(right, 'es'))
    return { path: `uploaded/${candidates[0]}`, status: candidates.length === 1 ? 'prefix' : 'ambiguous' }
  }
  return { path: relative, status: 'missing' }
}

function mimeType(fileName) {
  const extension = path.extname(fileName).toLowerCase()
  return ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff',
    '.tiff': 'image/tiff', '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain', '.csv': 'text/csv', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  })[extension] || 'application/octet-stream'
}

function pgLiteral(value) {
  if (value == null) return 'null'
  return `'${String(value).replaceAll("'", "''")}'`
}

function writeBatches(prefix, table, columns, rows) {
  const files = []
  let batch = []
  let batchChars = 0
  let batchNumber = 1
  const flush = () => {
    if (!batch.length) return
    const fileName = `${prefix}_${String(batchNumber).padStart(4, '0')}.sql`
    const content = `insert into ${stageSchema}.${table} (${columns.join(', ')}) values\n${batch.join(',\n')};\n`
    fs.writeFileSync(path.join(outputPath, fileName), content, 'utf8')
    files.push(fileName)
    batch = []
    batchChars = 0
    batchNumber += 1
  }
  for (const row of rows) {
    const tuple = `(${row.map(pgLiteral).join(', ')})`
    if (batch.length && batchChars + tuple.length > maxBatchChars) flush()
    batch.push(tuple)
    batchChars += tuple.length + 2
  }
  flush()
  return files
}

const petColumns = ['legacy_id', 'name', 'birth_date', 'weight', 'color_markings', 'species', 'breed', 'usual_food', 'sex', 'sterilized', 'inactive', 'photo_path', 'guardian_name', 'guardian_phone', 'guardian_address', 'referral_source', 'created_at']
const recordColumns = ['legacy_id', 'history', 'physical_exam', 'diagnosis', 'treatment', 'budget', 'photo_directory', 'file_directory', 'pet_legacy_id', 'occurred_at', 'doctor', 'temperature', 'heart_rate', 'respiratory_rate', 'hydration', 'lymph_nodes', 'vomiting', 'diarrhea', 'capillary_refill']

const rawPets = extractTable('mascota')
const rawRecords = extractTable('expediente')
if (rawPets.some((row) => row.length !== petColumns.length)) throw new Error('Una o más filas de mascota tienen un número inesperado de columnas')
if (rawRecords.some((row) => row.length !== recordColumns.length)) throw new Error('Una o más filas de expediente tienen un número inesperado de columnas')

const photoResolution = { exact: 0, prefix: 0, ambiguous: 0, missing: 0, empty: 0 }
const pets = rawPets.map((row) => {
  const photo = resolvePetPhoto(row[11])
  photoResolution[photo.status] += 1
  return [...row.slice(0, 11), photo.path, ...row.slice(12)]
})

const petIds = new Set(pets.map((row) => String(row[0])))
const orphanRecords = rawRecords.filter((row) => !petIds.has(String(row[8])))
const validRecords = rawRecords.filter((row) => petIds.has(String(row[8])))
const recordIds = new Set(validRecords.map((row) => String(row[0])))
const clinicalFiles = []
const missingClinicalDirectories = []
const duplicateClinicalPaths = []
const seenClinicalPaths = new Set()

for (const row of validRecords) {
  const legacyRecordId = String(row[0])
  for (const [kind, rawDirectory] of [['photo', row[6]], ['document', row[7]]]) {
    const relativeDirectory = normalizeRelative(rawDirectory)
    if (!relativeDirectory) continue
    const absoluteDirectory = path.resolve(path.dirname(uploadsPath), relativeDirectory.replaceAll('/', path.sep))
    const files = walkFiles(absoluteDirectory)
    if (!files.length) {
      missingClinicalDirectories.push({ legacyRecordId, kind, path: relativeDirectory })
      continue
    }
    for (const filePath of files) {
      const objectPath = path.relative(path.dirname(uploadsPath), filePath).replaceAll('\\', '/')
      const key = `${legacyRecordId}\0${objectPath.toLowerCase()}`
      if (seenClinicalPaths.has(key)) {
        duplicateClinicalPaths.push({ legacyRecordId, path: objectPath })
        continue
      }
      seenClinicalPaths.add(key)
      const stat = fs.statSync(filePath)
      clinicalFiles.push([legacyRecordId, kind, objectPath, path.basename(filePath), mimeType(filePath), String(stat.size)])
    }
  }
}

const createSql = `begin;
create schema ${stageSchema};
revoke all on schema ${stageSchema} from public, anon, authenticated;
create table ${stageSchema}.pets (${petColumns.map((column) => `${column} text`).join(', ')}, primary key (legacy_id));
create table ${stageSchema}.clinical_records (${recordColumns.map((column) => `${column} text`).join(', ')}, primary key (legacy_id));
create table ${stageSchema}.clinical_files (
  record_legacy_id text not null,
  kind text not null,
  object_path text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes text not null,
  primary key (record_legacy_id, object_path)
);
commit;
`
fs.writeFileSync(path.join(outputPath, '00_create_staging.sql'), createSql, 'utf8')

const petBatchFiles = writeBatches('10_pets', 'pets', petColumns, pets)
const recordBatchFiles = writeBatches('20_records', 'clinical_records', recordColumns, validRecords)
const fileBatchFiles = writeBatches('30_files', 'clinical_files', ['record_legacy_id', 'kind', 'object_path', 'original_name', 'mime_type', 'size_bytes'], clinicalFiles)

const validateSql = `select jsonb_build_object(
  'staged_pets', (select count(*) from ${stageSchema}.pets),
  'staged_records', (select count(*) from ${stageSchema}.clinical_records),
  'staged_files', (select count(*) from ${stageSchema}.clinical_files),
  'orphan_records_in_stage', (select count(*) from ${stageSchema}.clinical_records r left join ${stageSchema}.pets p on p.legacy_id = r.pet_legacy_id where p.legacy_id is null),
  'duplicate_pet_ids', (select count(*) - count(distinct legacy_id) from ${stageSchema}.pets),
  'duplicate_record_ids', (select count(*) - count(distinct legacy_id) from ${stageSchema}.clinical_records)
) as staging_validation;
`
fs.writeFileSync(path.join(outputPath, '90_validate_staging.sql'), validateSql, 'utf8')

const applySql = `begin;
set local lock_timeout = '15s';
set local statement_timeout = '0';
set local session_replication_role = replica;

truncate table
  public.clinical_files,
  public.weight_records,
  public.pet_notes,
  public.allergies,
  public.medications,
  public.vaccinations,
  public.clinical_records,
  public.pets,
  public.audit_events
restart identity;

insert into public.pets (
  legacy_id, name, birth_date, birth_date_is_approximate, color_markings, species,
  breed, usual_food, sex, is_sterilized, photo_path, status, deactivated_at,
  created_at, updated_at, guardian_name, guardian_phone, guardian_address, referral_source
)
select
  legacy_id::bigint,
  left(coalesce(nullif(btrim(name), ''), 'Mascota #' || legacy_id), 200),
  case when birth_date ~ '^\\d{4}-\\d{2}-\\d{2}$' and birth_date not like '0000-%' then birth_date::date else null end,
  false,
  nullif(btrim(color_markings), ''),
  left(nullif(btrim(species), ''), 100),
  left(nullif(btrim(breed), ''), 120),
  nullif(btrim(usual_food), ''),
  case
    when lower(btrim(sex)) in ('macho', 'male', 'masculino') then 'male'::public.biological_sex
    when lower(btrim(sex)) in ('hembra', 'female', 'femenino') then 'female'::public.biological_sex
    when nullif(btrim(sex), '') is null then null
    else 'unknown'::public.biological_sex
  end,
  case
    when lower(btrim(sterilized)) in ('si', 'sí', '1', 'true') then true
    when lower(btrim(sterilized)) in ('no', '0', 'false') then false
    else null
  end,
  nullif(btrim(photo_path), ''),
  case when inactive = '1' then 'inactive'::public.pet_status else 'active'::public.pet_status end,
  case when inactive = '1' then coalesce(
    case when created_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and created_at not like '0000-%' then created_at::timestamp at time zone 'UTC' end,
    now()
  ) end,
  coalesce(case when created_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and created_at not like '0000-%' then created_at::timestamp at time zone 'UTC' end, now()),
  coalesce(case when created_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and created_at not like '0000-%' then created_at::timestamp at time zone 'UTC' end, now()),
  left(coalesce(nullif(btrim(guardian_name), ''), 'Sin responsable registrado'), 200),
  left(nullif(btrim(guardian_phone), ''), 200),
  nullif(btrim(guardian_address), ''),
  left(nullif(btrim(referral_source), ''), 200)
from ${stageSchema}.pets;

insert into public.clinical_records (
  legacy_id, pet_id, occurred_at, history, physical_exam, provisional_diagnosis,
  treatment, estimated_cost, budget_notes, attending_professional,
  temperature_observation, heart_rate_observation, respiratory_rate_observation,
  hydration_observation, lymph_nodes_observation, capillary_refill_observation,
  vomiting, vomiting_notes, diarrhea, diarrhea_notes, legacy_photo_directory,
  legacy_file_directory, created_at, updated_at
)
select
  r.legacy_id::bigint,
  p.id,
  coalesce(case when r.occurred_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and r.occurred_at not like '0000-%' then r.occurred_at::timestamp at time zone 'UTC' end, now()),
  nullif(btrim(r.history), ''),
  nullif(btrim(r.physical_exam), ''),
  nullif(btrim(r.diagnosis), ''),
  nullif(btrim(r.treatment), ''),
  case
    when regexp_replace(coalesce(r.budget, ''), '[\\s$,]', '', 'g') ~ '^\\d+(\\.\\d{1,2})?$'
      and regexp_replace(r.budget, '[\\s$,]', '', 'g')::numeric <= 9999999999.99
    then regexp_replace(r.budget, '[\\s$,]', '', 'g')::numeric
    else null
  end,
  nullif(btrim(r.budget), ''),
  nullif(btrim(r.doctor), ''),
  nullif(btrim(r.temperature), ''),
  nullif(btrim(r.heart_rate), ''),
  nullif(btrim(r.respiratory_rate), ''),
  nullif(btrim(r.hydration), ''),
  nullif(btrim(r.lymph_nodes), ''),
  nullif(btrim(r.capillary_refill), ''),
  case when lower(btrim(coalesce(r.vomiting, ''))) in ('1','si','sí','true') then true when lower(btrim(coalesce(r.vomiting, ''))) in ('0','no','false','') then false else null end,
  nullif(btrim(r.vomiting), ''),
  case when lower(btrim(coalesce(r.diarrhea, ''))) in ('1','si','sí','true') then true when lower(btrim(coalesce(r.diarrhea, ''))) in ('0','no','false','') then false else null end,
  nullif(btrim(r.diarrhea), ''),
  nullif(btrim(r.photo_directory), ''),
  nullif(btrim(r.file_directory), ''),
  coalesce(case when r.occurred_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and r.occurred_at not like '0000-%' then r.occurred_at::timestamp at time zone 'UTC' end, now()),
  coalesce(case when r.occurred_at ~ '^\\d{4}-\\d{2}-\\d{2} ' and r.occurred_at not like '0000-%' then r.occurred_at::timestamp at time zone 'UTC' end, now())
from ${stageSchema}.clinical_records r
join public.pets p on p.legacy_id = r.pet_legacy_id::bigint;

insert into public.weight_records (pet_id, measured_at, weight_kg, notes, created_at, updated_at)
select
  p.id,
  p.created_at,
  s.weight::numeric,
  'Peso importado de la ficha histórica',
  p.created_at,
  p.created_at
from ${stageSchema}.pets s
join public.pets p on p.legacy_id = s.legacy_id::bigint
where s.weight ~ '^\\d+(\\.\\d+)?$' and s.weight::numeric > 0 and s.weight::numeric < 10000;

insert into public.clinical_files (
  clinical_record_id, kind, bucket_id, object_path, original_name, mime_type, size_bytes, created_at
)
select
  r.id,
  case when f.kind = 'photo' then 'photo'::public.clinical_file_kind else 'document'::public.clinical_file_kind end,
  'clinical-files',
  f.object_path,
  f.original_name,
  f.mime_type,
  f.size_bytes::bigint,
  r.created_at
from ${stageSchema}.clinical_files f
join public.clinical_records r on r.legacy_id = f.record_legacy_id::bigint;

set local session_replication_role = origin;
commit;

select jsonb_build_object(
  'profiles_preserved', (select count(*) from public.profiles),
  'auth_users_preserved', (select count(*) from auth.users),
  'pets', (select count(*) from public.pets),
  'clinical_records', (select count(*) from public.clinical_records),
  'clinical_files', (select count(*) from public.clinical_files),
  'weight_records', (select count(*) from public.weight_records),
  'orphan_records', (select count(*) from public.clinical_records r left join public.pets p on p.id = r.pet_id where p.id is null),
  'missing_profile_users', (select count(*) from public.profiles p left join auth.users u on u.id = p.id where u.id is null)
) as imported_counts;
`
fs.writeFileSync(path.join(outputPath, '99_apply.sql'), applySql, 'utf8')

const cleanupSql = `drop schema ${stageSchema} cascade;\n`
fs.writeFileSync(path.join(outputPath, 'zz_cleanup.sql'), cleanupSql, 'utf8')

const manifest = {
  sourcePath,
  uploadsPath,
  outputPath,
  stageSchema,
  pets: pets.length,
  clinicalRecords: validRecords.length,
  orphanRecords: orphanRecords.map((row) => ({ legacyRecordId: row[0], petLegacyId: row[8] })),
  clinicalFiles: clinicalFiles.length,
  photoResolution,
  legacyStats: {
    guardianPhonesLongerThan40: pets.filter((row) => String(row[13] ?? '').trim().length > 40).length,
    invalidBirthDates: pets.filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(String(row[2] ?? '')) || String(row[2]).startsWith('0000-')).length,
    positiveWeights: pets.filter((row) => /^\d+(\.\d+)?$/.test(String(row[3] ?? '')) && Number(row[3]) > 0 && Number(row[3]) < 10000).length,
  },
  missingClinicalDirectories,
  duplicateClinicalPaths,
  batches: [...petBatchFiles, ...recordBatchFiles, ...fileBatchFiles],
}
fs.writeFileSync(path.join(outputPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log(JSON.stringify({
  outputPath,
  pets: manifest.pets,
  clinicalRecords: manifest.clinicalRecords,
  orphanRecords: manifest.orphanRecords.length,
  clinicalFiles: manifest.clinicalFiles,
  photoResolution,
  legacyStats: manifest.legacyStats,
  missingClinicalDirectories: missingClinicalDirectories.length,
  duplicateClinicalPaths: duplicateClinicalPaths.length,
  batchFiles: manifest.batches.length,
}, null, 2))
