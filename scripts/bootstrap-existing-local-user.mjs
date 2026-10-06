import { randomBytes } from 'node:crypto'
import { createLocalPool } from '../server/local-api.mjs'
import { passwordHash } from '../server/local-auth.mjs'

const userId = process.argv[2]
const email = (process.env.AA_BOOTSTRAP_EMAIL || '').trim().toLowerCase()
const password = process.env.AA_BOOTSTRAP_PASSWORD || ''

if (!process.env.AA_DB_PASSWORD
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId || '')
  || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
  || password.length < 10 || password.length > 1024
  || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
  throw new Error('Indica UUID, AA_DB_PASSWORD, AA_BOOTSTRAP_EMAIL y una contraseña fuerte.')
}

const pool = createLocalPool()
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const { rows } = await client.query(
    "SELECT display_name, role FROM aa_local.profiles WHERE id = $1 AND is_active AND role IN ('veterinarian', 'reception') FOR UPDATE",
    [userId],
  )
  if (!rows.length) throw new Error('No existe un perfil activo de veterinaria o recepción con ese UUID.')
  const existing = await client.query('SELECT 1 FROM aa_local.login_credentials WHERE user_id = $1 OR email = $2', [userId, email])
  if (existing.rows.length) throw new Error('El perfil o el correo ya tiene acceso local; no se cambió ninguna contraseña.')
  const salt = randomBytes(16).toString('hex')
  await client.query(
    "INSERT INTO aa_local.login_credentials (user_id, email, password_salt, password_hash, valid_until) VALUES ($1, $2, $3, $4, 'infinity'::timestamptz)",
    [userId, email, salt, await passwordHash(password, salt)],
  )
  await client.query('COMMIT')
  console.log(`Acceso local preparado para ${rows[0].display_name} (${rows[0].role}).`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
}
