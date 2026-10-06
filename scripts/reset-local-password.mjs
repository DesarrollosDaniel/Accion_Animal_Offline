import { randomBytes } from 'node:crypto'
import { createLocalPool } from '../server/local-api.mjs'
import { passwordHash } from '../server/local-auth.mjs'

const email = (process.env.AA_RESET_EMAIL || '').trim().toLowerCase()
const password = process.env.AA_RESET_PASSWORD || ''

if (!process.env.AA_DB_PASSWORD) throw new Error('Falta AA_DB_PASSWORD: contraseña de PostgreSQL del usuario aa_local_app.')
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('AA_RESET_EMAIL no es válido.')
if (password.length < 10 || password.length > 1024 || !/[a-z]/.test(password)
  || !/[A-Z]/.test(password) || !/\d/.test(password)) {
  throw new Error('AA_RESET_PASSWORD debe tener de 10 a 1024 caracteres, mayúscula, minúscula y número.')
}

const pool = createLocalPool()
try {
  const salt = randomBytes(16).toString('hex')
  const hash = await passwordHash(password, salt)
  const { rows } = await pool.query(`
    UPDATE aa_local.login_credentials AS credentials
    SET password_salt = $2, password_hash = $3, valid_until = 'infinity'::timestamptz
    FROM aa_local.profiles AS profile
    WHERE credentials.user_id = profile.id AND credentials.email = $1 AND profile.is_active
    RETURNING credentials.user_id
  `, [email, salt, hash])
  if (rows.length !== 1) throw new Error('No hay una cuenta local activa con ese correo. No se cambió ninguna contraseña.')
  console.log(`Contraseña local restablecida para ${email}.`)
} finally {
  await pool.end()
}
