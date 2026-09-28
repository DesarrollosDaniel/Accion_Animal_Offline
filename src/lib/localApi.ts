export async function localData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/local/${path}`, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string }
  if (!response.ok || body.data === undefined) throw new Error(body.error || 'No fue posible consultar PostgreSQL local.')
  return body.data
}

export function localWrite<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
  return localData<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
