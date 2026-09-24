function normalizedParts(value: string) {
  const cleaned = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '')
  const withoutPrefix = cleaned.toLowerCase().startsWith('uploaded/') ? cleaned.slice('uploaded/'.length) : cleaned
  return withoutPrefix.split('/').filter(Boolean)
}

export function localFileUrl(value: string | null) {
  if (!value) return null
  if (/^(?:https?:|data:|blob:)/i.test(value)) return value
  const parts = normalizedParts(value)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null
  return `/uploaded/${parts.map(encodeURIComponent).join('/')}`
}

export async function establishLocalSession(accessToken: string) {
  const response = await fetch('/api/local-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await response.json().catch(() => ({})) as { error?: string; ok?: boolean }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || 'No fue posible conectar con el almacenamiento local.')
  }
}

export async function clearLocalSession() {
  await fetch('/api/local-session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {})
}

export async function uploadLocalFile(path: string, file: File) {
  const target = localFileUrl(path)
  if (!target) throw new Error('La ruta local del archivo no es válida.')
  const response = await fetch(target, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  const body = await response.json().catch(() => ({})) as { error?: string; path?: string }
  if (!response.ok || !body.path) throw new Error(body.error || `No fue posible guardar ${file.name}.`)
  return body.path
}

export async function deleteLocalFile(path: string) {
  if (/^(?:https?:|data:|blob:)/i.test(path)) return false
  const target = localFileUrl(path)
  if (!target) return false
  try {
    const response = await fetch(target, { method: 'DELETE', credentials: 'same-origin' })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}
