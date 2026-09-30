export type LocalUser = { id: string; email?: string }

async function authRequest(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json() as { error?: string; user: LocalUser }
  if (!response.ok) throw new Error(result.error || 'No fue posible verificar el acceso.')
  return result
}

export async function localLogin(email: string, password: string) {
  const result = await authRequest('/api/local-auth', { email, password })
  return result.user
}

export async function verifyLocalPassword(password: string) {
  await authRequest('/api/local-auth/verify', { password })
}

export async function currentLocalUser(): Promise<LocalUser | null> {
  const response = await fetch('/api/local-session', { credentials: 'same-origin' })
  if (!response.ok) throw new Error('No fue posible consultar la sesión local.')
  const result = await response.json() as { user: LocalUser | null }
  return result.user
}
