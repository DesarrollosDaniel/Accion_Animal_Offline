import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTestEnvironment } from '../scripts/test-environment.mjs'

assertTestEnvironment()

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(projectRoot, 'dist')
const storageSetting = process.env.AA_STORAGE_ROOT
const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
const host = process.env.AA_HOST || '0.0.0.0'
const port = Number(process.env.AA_PORT || 4173)
const maxUploadBytes = Number(process.env.AA_MAX_UPLOAD_BYTES || 50 * 1024 * 1024)
const cookieName = 'aa_local_session'
const sessions = new Map()

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jfif', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.pdf', 'application/pdf'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.txt', 'text/plain; charset=utf-8'], ['.webp', 'image/webp'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.mp4', 'video/mp4'],
  ['.doc', 'application/msword'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xls', 'application/vnd.ms-excel'], ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

const allowedUploadExtensions = new Set([
  '.bmp', '.doc', '.docx', '.gif', '.jfif', '.jpeg', '.jpg', '.mp4', '.pdf', '.png', '.pptx', '.txt', '.webp', '.xls', '.xlsx',
])

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    return separator < 0 ? [] : [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]]
  }))
}

function currentSession(req) {
  const id = parseCookies(req)[cookieName]
  const session = id && sessions.get(id)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id)
    return null
  }
  return session
}

function requireSession(req, res) {
  const session = currentSession(req)
  if (!session) json(res, 401, { error: 'Inicia sesión para acceder a los archivos locales.' })
  return session
}

function requireSameOrigin(req, res) {
  const origin = req.headers.origin
  if (!origin || new URL(origin).host !== req.headers.host) {
    json(res, 403, { error: 'Solicitud rechazada por seguridad.' })
    return false
  }
  return true
}

async function validateSupabaseUser(accessToken) {
  try {
    const headers = { apikey: publishableKey, Authorization: `Bearer ${accessToken}` }
    const signal = AbortSignal.timeout(10_000)
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers, signal })
    if (!userResponse.ok) return null
    const user = await userResponse.json()
    const profileUrl = new URL(`${supabaseUrl}/rest/v1/profiles`)
    profileUrl.searchParams.set('id', `eq.${user.id}`)
    profileUrl.searchParams.set('select', 'id,role,is_active')
    const profileResponse = await fetch(profileUrl, { headers, signal })
    if (!profileResponse.ok) return null
    const [profile] = await profileResponse.json()
    if (!profile?.is_active || !['owner', 'veterinarian', 'reception'].includes(profile.role)) return null
    return { userId: user.id, role: profile.role }
  } catch (error) {
    throw Object.assign(new Error('SUPABASE_UNAVAILABLE'), { cause: error })
  }
}

function decodeUploadedPath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new Error('INVALID_PATH')
  }
  decoded = decoded.replaceAll('\\', '/')
  if (!decoded.startsWith('/uploaded/')) throw new Error('INVALID_PATH')
  const relative = decoded.slice('/uploaded/'.length)
  const parts = relative.split('/')
  if (!relative || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0') || part.includes(':'))) {
    throw new Error('INVALID_PATH')
  }
  return { relative, parts }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function requestedStoragePath(storageRoot, pathname) {
  const decoded = decodeUploadedPath(pathname)
  const target = path.resolve(storageRoot, ...decoded.parts)
  if (!contained(storageRoot, target)) throw new Error('INVALID_PATH')
  return { ...decoded, target }
}

function canWrite(session) {
  return session.role === 'owner' || session.role === 'veterinarian'
}

async function serveFile(req, res, filePath, options = {}) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw Object.assign(new Error('NOT_FILE'), { code: 'ENOENT' })
  const type = mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream'
  const headers = {
    'Content-Type': type,
    'Content-Length': fileStat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': options.private ? 'private, no-cache' : options.noCache ? 'no-store' : 'public, max-age=31536000, immutable',
  }
  if (options.private && !type.startsWith('image/') && type !== 'application/pdf' && !type.startsWith('video/')) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  createReadStream(filePath).pipe(res)
}

async function handleSession(req, res) {
  if (!requireSameOrigin(req, res)) return
  if (req.method === 'DELETE') {
    const id = parseCookies(req)[cookieName]
    if (id) sessions.delete(id)
    return json(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' }, { Allow: 'POST, DELETE' })
  const authorization = req.headers.authorization || ''
  if (!authorization.startsWith('Bearer ')) return json(res, 401, { error: 'Sesión de Supabase ausente.' })
  const accessToken = authorization.slice(7)
  const user = await validateSupabaseUser(accessToken)
  if (!user) return json(res, 401, { error: 'La sesión o el perfil no son válidos.' })
  const id = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + 55 * 60 * 1000
  sessions.set(id, { ...user, expiresAt })
  json(res, 200, { ok: true, role: user.role }, {
    'Set-Cookie': `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3300`,
  })
}

async function handleUploaded(req, res, url, storageRoot) {
  const session = requireSession(req, res)
  if (!session) return
  const { relative, target } = requestedStoragePath(storageRoot, url.pathname)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const resolved = await realpath(target)
    if (!contained(storageRoot, resolved)) throw new Error('INVALID_PATH')
    return serveFile(req, res, resolved, { private: true })
  }
  if (!['PUT', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET, HEAD, PUT, DELETE' })
  if (!requireSameOrigin(req, res)) return
  if (!canWrite(session)) return json(res, 403, { error: 'Tu rol no permite modificar este archivo.' })

  if (req.method === 'DELETE') {
    const resolved = await realpath(target)
    if (!contained(storageRoot, resolved)) throw new Error('INVALID_PATH')
    await unlink(resolved)
    return json(res, 200, { ok: true })
  }

  const extension = path.extname(target).toLowerCase()
  if (!allowedUploadExtensions.has(extension)) return json(res, 415, { error: 'Tipo de archivo no permitido.' })
  if (Number(req.headers['content-length'] || 0) > maxUploadBytes) return json(res, 413, { error: 'El archivo supera el límite configurado.' })
  await mkdir(path.dirname(target), { recursive: true })
  const resolvedParent = await realpath(path.dirname(target))
  if (!contained(storageRoot, resolvedParent)) throw new Error('INVALID_PATH')
  try {
    await access(target)
    return json(res, 409, { error: 'Ya existe un archivo con esa ruta.' })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = path.join(resolvedParent, `.${path.basename(target)}.${randomBytes(8).toString('hex')}.tmp`)
  let received = 0
  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(temporary, { flags: 'wx' })
      req.on('data', (chunk) => {
        received += chunk.length
        if (received > maxUploadBytes) {
          output.destroy(new Error('UPLOAD_TOO_LARGE'))
        }
      })
      req.on('error', reject)
      output.on('error', reject)
      output.on('finish', resolve)
      req.pipe(output)
    })
    await copyFile(temporary, target, constants.COPYFILE_EXCL)
    return json(res, 201, { ok: true, path: `uploaded/${relative}`, size: received })
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Método no permitido.' })
  const pathname = decodeURIComponent(url.pathname)
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  let target = path.resolve(distRoot, requested)
  if (!contained(distRoot, target)) return json(res, 400, { error: 'Ruta inválida.' })
  try {
    if (!(await stat(target)).isFile()) throw Object.assign(new Error('NOT_FILE'), { code: 'ENOENT' })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    target = path.join(distRoot, 'index.html')
  }
  return serveFile(req, res, target, { noCache: target.endsWith('index.html') })
}

async function start() {
  if (!storageSetting) throw new Error('Falta AA_STORAGE_ROOT en .env.local.')
  if (!supabaseUrl || !publishableKey) throw new Error('Faltan la URL o la clave publicable de Supabase.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AA_PORT no es válido.')
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes < 1) throw new Error('AA_MAX_UPLOAD_BYTES no es válido.')
  await access(path.join(distRoot, 'index.html'), constants.R_OK)
  const storageRoot = await realpath(path.resolve(projectRoot, storageSetting))

  setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id)
  }, 10 * 60 * 1000).unref()

  const server = createServer(async (req, res) => {
    try {
      const rawPathname = (req.url || '/').split('?', 1)[0]
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/api/health') {
        return json(res, 200, { ok: true, storage: 'available', mode: 'local' })
      }
      if (url.pathname === '/api/local-session') return await handleSession(req, res)
      if (rawPathname.startsWith('/uploaded/')) {
        return await handleUploaded(req, res, { ...url, pathname: rawPathname }, storageRoot)
      }
      return await serveStatic(req, res, url)
    } catch (error) {
      if (error?.code === 'ENOENT') return json(res, 404, { error: 'Archivo no encontrado.' })
      if (error?.message === 'INVALID_PATH') return json(res, 400, { error: 'Ruta inválida.' })
      if (error?.message === 'UPLOAD_TOO_LARGE') return json(res, 413, { error: 'El archivo supera el límite configurado.' })
      if (error?.message === 'SUPABASE_UNAVAILABLE') return json(res, 503, { error: 'No fue posible comunicarse con Supabase.' })
      console.error(error)
      if (!res.headersSent) json(res, 500, { error: 'Error interno del servidor local.' })
      else res.destroy()
    }
  })

  server.listen(port, host, () => {
    console.log(`Acción Animal disponible en http://${host}:${port}`)
    console.log('Almacenamiento local preparado.')
  })
}

await start()
