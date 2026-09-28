import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { LocalApiError } from './local-writes.mjs'
import { saveVerifiedProfile } from './local-api.mjs'

const deriveKey = promisify(scrypt)
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
export const offlineLifetime = 7 * 24 * 60 * 60 * 1000

export async function passwordHash(password, salt) {
  return (await deriveKey(password, salt, 64, options)).toString('hex')
}

export async function passwordMatches(password, credential) {
  if (!/^[a-f0-9]{32}$/.test(credential.password_salt) || !/^[a-f0-9]{128}$/.test(credential.password_hash)) return false
  return timingSafeEqual(Buffer.from(await passwordHash(password, credential.password_salt), 'hex'), Buffer.from(credential.password_hash, 'hex'))
}

export function createLocalAuth(pool, url, key, fetchImpl = fetch) {
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

  async function authenticate(input, address, expectedUserId = null) {
    if (!pool) throw new LocalApiError(503, 'La base de datos local no está configurada.')
    if (typeof input?.email !== 'string' || input.email.length > 254
      || typeof input.password !== 'string' || !input.password || input.password.length > 1024) {
      throw new LocalApiError(400, 'Correo o contraseña no válidos.')
    }
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new LocalApiError(400, 'Correo no válido.')
    const clearAttempts = throttle(email, address)
    // ponytail: revocaciones remotas pueden tardar hasta siete días sin red;
    // renovar perfiles mediante sincronización cuando ese trabajador exista.
    let cloudSession = null
    if (!expectedUserId) {
      const signal = AbortSignal.timeout(3000)
      const cloud = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (target, init) => fetchImpl(target, { ...init, signal }) },
      })
      const { data, error } = await cloud.auth.signInWithPassword({ email, password: input.password })
      if (error && error.name !== 'AuthRetryableFetchError' && !(error.status >= 500)) {
        // Nunca aceptar la clave antigua si Supabase rechaza la cuenta o clave.
        throw new LocalApiError(error.status === 429 ? 429 : 401, 'No fue posible iniciar sesión. Revisa tu cuenta o inténtalo más tarde.')
      }
      if (data.session) {
        const { data: profile, error: profileError } = await cloud.from('profiles')
          .select('id,display_name,role,is_active').eq('id', data.user.id).single()
        if (profileError) throw new LocalApiError(503, 'No fue posible verificar el perfil en Supabase.')
        if (!profile?.is_active || !['owner', 'veterinarian', 'reception'].includes(profile.role)) {
          await pool.query('DELETE FROM aa_local.login_credentials WHERE email = $1', [email])
          await pool.query('UPDATE aa_local.profiles SET is_active = false WHERE id = $1', [data.user.id])
          throw new LocalApiError(403, 'La cuenta no está activa.')
        }
        await saveVerifiedProfile(pool, { userId: profile.id, role: profile.role, displayName: profile.display_name })
        const salt = randomBytes(16).toString('hex')
        const hash = await passwordHash(input.password, salt)
        await pool.query(`INSERT INTO aa_local.login_credentials
          (user_id, email, password_salt, password_hash, verified_at, valid_until)
          VALUES ($1, $2, $3, $4, now(), now() + interval '7 days')
          ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email,
          password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash,
          verified_at = EXCLUDED.verified_at, valid_until = EXCLUDED.valid_until`,
        [profile.id, email, salt, hash])
        cloudSession = { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
      }
    }
    const { rows } = await pool.query(`SELECT c.*, p.role, p.display_name, p.is_active
      FROM aa_local.login_credentials c JOIN aa_local.profiles p ON p.id = c.user_id
      WHERE c.email = $1`, [email])
    const credential = rows[0]
    if (!credential?.is_active || (expectedUserId && credential.user_id !== expectedUserId)
      || new Date(credential.valid_until).getTime() <= Date.now()) {
      throw new LocalApiError(401, 'El acceso local no está habilitado o venció. Inicia sesión con internet para renovarlo.')
    }
    if (!await passwordMatches(input.password, credential)) throw new LocalApiError(401, 'Correo o contraseña incorrectos.')
    clearAttempts()
    return { userId: credential.user_id, email, role: credential.role, displayName: credential.display_name,
      validUntil: new Date(credential.valid_until).getTime(), cloudSession }
  }
  return authenticate
}
