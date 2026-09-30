import { randomBytes } from 'node:crypto'
import { createLocalPool } from '../server/local-api.mjs'
import { passwordHash } from '../server/local-auth.mjs'

const email = (process.env.AA_BOOTSTRAP_EMAIL || '').trim().toLowerCase()
const password = process.env.AA_BOOTSTRAP_PASSWORD || ''
const ownerId = process.argv[2]
if (!process.env.AA_DB_PASSWORD || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
  || password.length < 10 || password.length > 1024 || !/[a-z]/.test(password)
  || !/[A-Z]/.test(password) || !/\d/.test(password)
  || ownerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
  throw new Error('Indica AA_DB_PASSWORD, AA_BOOTSTRAP_EMAIL y una contraseña fuerte; UUID de owner opcional.')
}

const pool = createLocalPool()
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const { rows } = await client.query("SELECT id FROM aa_local.profiles WHERE role = 'owner' AND is_active AND ($1::uuid IS NULL OR id = $1) ORDER BY id", [ownerId || null])
  if (rows.length !== 1) throw new Error('Debe haber exactamente un owner activo seleccionado; indica su UUID si hay varios.')
  const existing = await client.query('SELECT 1 FROM aa_local.login_credentials WHERE user_id = $1 OR email = $2', [rows[0].id, email])
  if (existing.rows.length) throw new Error('Ese owner o correo ya tiene acceso local; no se cambiará su contraseña.')
  const salt = randomBytes(16).toString('hex')
  await client.query('INSERT INTO aa_local.login_credentials (user_id, email, password_salt, password_hash) VALUES ($1, $2, $3, $4)',
    [rows[0].id, email, salt, await passwordHash(password, salt)])
  await client.query('COMMIT')
  console.log('Acceso local del owner preparado.')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
}
