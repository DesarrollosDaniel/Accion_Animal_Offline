import { scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { LocalApiError } from './local-writes.mjs'

const deriveKey = promisify(scrypt)
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }

export async function passwordHash(password, salt) {
  return (await deriveKey(password, salt, 64, options)).toString('hex')
}

export async function passwordMatches(password, credential) {
  if (!/^[a-f0-9]{32}$/.test(credential.password_salt) || !/^[a-f0-9]{128}$/.test(credential.password_hash)) return false
  return timingSafeEqual(Buffer.from(await passwordHash(password, credential.password_salt), 'hex'), Buffer.from(credential.password_hash, 'hex'))
}

export function createLocalAuth(pool) {
  const attempts = new Map()
  function throttle(email, address) {
    const now = Date.now()
    for (const [id, value] of attempts) if (value.until <= now) attempts.delete(id)
    const ids = [`email:${email}`, `ip:${address}`]
    if (attempts.size >= 1000 || ids.some((id) => (attempts.get(id)?.count || 0) >= 5)) {
      throw new LocalApiError(429, 'Demasiados intentos. Espera cinco minutos.')
    }
    for (const id of ids) {
      const value = attempts.get(id) || { count: 0, until: now + 5 * 60 * 1000 }
      value.count++
      attempts.set(id, value)
    }
    return () => ids.forEach((id) => attempts.delete(id))
  }

  return async function authenticate(input, address, expectedUserId = null) {
    if (!pool) throw new LocalApiError(503, 'La base de datos local no está configurada.')
    if (typeof input?.email !== 'string' || input.email.length > 254
      || typeof input.password !== 'string' || !input.password || input.password.length > 1024) {
      throw new LocalApiError(400, 'Correo o contraseña no válidos.')
    }
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new LocalApiError(400, 'Correo no válido.')
    const clearAttempts = throttle(email, address)
    const { rows } = await pool.query(`SELECT c.*, p.role, p.display_name, p.is_active
      FROM aa_local.login_credentials c JOIN aa_local.profiles p ON p.id = c.user_id
      WHERE c.email = $1`, [email])
    const credential = rows[0]
    if (!credential?.is_active || (expectedUserId && credential.user_id !== expectedUserId)) {
      throw new LocalApiError(401, 'El acceso local no está habilitado.')
    }
    if (!await passwordMatches(input.password, credential)) throw new LocalApiError(401, 'Correo o contraseña incorrectos.')
    clearAttempts()
    return { userId: credential.user_id, email, role: credential.role, displayName: credential.display_name }
  }
}
