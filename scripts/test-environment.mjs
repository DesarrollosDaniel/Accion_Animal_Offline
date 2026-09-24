import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const testProjectRef = 'wuenfwsjifwuupfjgubm'
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readRequiredFile(relativePath) {
  try {
    return readFileSync(path.join(projectRoot, relativePath), 'utf8')
  } catch {
    throw new Error(`Falta ${relativePath}. Configura el entorno de PRUEBAS antes de continuar.`)
  }
}

function envValue(contents, name) {
  const line = contents.split(/\r?\n/).find((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry))
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2') || ''
}

function configuredUrls(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:VITE_SUPABASE_URL|SUPABASE_URL)\s*=(.*)$/)
    return match ? [match[1].trim().replace(/^(['"])(.*)\1$/, '$2')] : []
  })
}

export function validateTestConfiguration({ configuredUrl, linkedRef, activeUrls = [] }) {
  const expectedHost = `${testProjectRef}.supabase.co`
  const urls = [configuredUrl, ...activeUrls.filter(Boolean)]
  if (linkedRef.trim() !== testProjectRef) {
    throw new Error(`Proyecto Supabase enlazado incorrecto. Se esperaba ${testProjectRef}; operación cancelada.`)
  }
  if (!configuredUrl || urls.some((value) => {
    try {
      const url = new URL(value)
      return url.protocol !== 'https:' || url.hostname !== expectedHost || url.pathname !== '/' || Boolean(url.username || url.password || url.port || url.search || url.hash)
    } catch {
      return true
    }
  })) {
    throw new Error(`URL de Supabase incorrecta. Este repositorio de PRUEBAS solo permite https://${expectedHost}; operación cancelada.`)
  }
}

export function validateLocalDatabaseUrl(value) {
  if (!value) return
  try {
    const url = new URL(value)
    if (['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!url.port || url.port === '5432') && url.pathname === '/accion_animal_dev') return
  } catch {
    // Una URL inválida también debe detener la operación.
  }
  throw new Error('DATABASE_URL debe apuntar solo a accion_animal_dev en PostgreSQL local; operación cancelada.')
}

export function assertTestEnvironment() {
  const localEnv = readRequiredFile('.env.local')
  const serverEnv = readRequiredFile('.env.server')
  const linkedRef = readRequiredFile('supabase/.temp/project-ref')
  const configuredUrl = envValue(localEnv, 'VITE_SUPABASE_URL')
  const envFiles = readdirSync(projectRoot).filter((name) => /^\.env(?:\..+)?$/.test(name))
  const activeUrls = [
    ...envFiles.flatMap((name) => configuredUrls(readFileSync(path.join(projectRoot, name), 'utf8'))),
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_URL,
  ]
  validateTestConfiguration({ configuredUrl, linkedRef, activeUrls })
  for (const name of envFiles) {
    const contents = readFileSync(path.join(projectRoot, name), 'utf8')
    if (/^\s*SUPABASE_DB_URL\s*=/m.test(contents)) throw new Error('SUPABASE_DB_URL no está permitida en este entorno de PRUEBAS.')
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*DATABASE_URL\s*=(.*)$/)
      if (match) validateLocalDatabaseUrl(match[1].trim().replace(/^(['"])(.*)\1$/, '$2'))
    }
  }
  if (process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL no está permitida en este entorno de PRUEBAS.')
  validateLocalDatabaseUrl(process.env.DATABASE_URL)
  if (envValue(serverEnv, 'AA_STORAGE_ROOT') !== 'uploaded' || (process.env.AA_STORAGE_ROOT && process.env.AA_STORAGE_ROOT !== 'uploaded') || realpathSync(path.join(projectRoot, 'uploaded')) !== path.join(projectRoot, 'uploaded')) {
    throw new Error('La carpeta de adjuntos debe ser uploaded dentro de este repositorio de PRUEBAS; operación cancelada.')
  }
  if (!envValue(localEnv, 'VITE_SUPABASE_PUBLISHABLE_KEY')) {
    throw new Error('Falta la clave publicable del proyecto de PRUEBAS en .env.local.')
  }
  console.log(`Entorno: PRUEBAS | Supabase: ${testProjectRef}`)
}
