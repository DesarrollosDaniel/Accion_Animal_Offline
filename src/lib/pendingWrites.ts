import { localData, localWrite } from './localApi'
import { localFileUrl, uploadLocalFile } from './localFiles'

type PendingWrite = {
  id: string
  userId: string
  createdAt: number
  kind: 'pet' | 'record' | 'file' | 'petPhoto'
  path: string
  body?: Record<string, unknown>
  file?: File
  expectedVersion?: string
}

const databaseName = 'accion-animal-pending-writes'
const storeName = 'writes'
let running = false

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    tx.addEventListener('complete', () => db.close())
    tx.addEventListener('abort', () => { db.close(); reject(tx.error) })
    action(tx.objectStore(storeName), resolve, reject)
  })
}

export async function queueWrites(writes: PendingWrite[]) {
  if (!writes.length) return
  await transaction<void>('readwrite', (store, resolve, reject) => {
    for (const write of writes) store.put(write)
    store.transaction.oncomplete = () => resolve()
    store.transaction.onabort = () => reject(store.transaction.error)
  })
  window.dispatchEvent(new Event('pending-writes-changed'))
}

export async function pendingWrites(userId: string): Promise<PendingWrite[]> {
  const all = await transaction<PendingWrite[]>('readonly', (store, resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return all.filter((write) => write.userId === userId).sort((a, b) => a.createdAt - b.createdAt)
}

async function removeWrite(id: string) {
  await transaction<void>('readwrite', (store, resolve, reject) => {
    store.delete(id)
    store.transaction.oncomplete = () => resolve()
    store.transaction.onabort = () => reject(store.transaction.error)
  })
  window.dispatchEvent(new Event('pending-writes-changed'))
}

async function uploadQueuedFile(path: string, file: File) {
  try {
    await uploadLocalFile(path, file)
  } catch (cause) {
    if (!(cause instanceof Error) || cause.message !== 'Ya existe un archivo con esa ruta.') throw cause
    const target = localFileUrl(path)
    if (!target) throw cause
    const response = await fetch(target, { credentials: 'same-origin' })
    if (!response.ok) throw cause
    const existing = new Uint8Array(await response.arrayBuffer())
    if (existing.length !== file.size) throw cause
    const original = new Uint8Array(await file.arrayBuffer())
    for (let index = 0; index < existing.length; index++) if (existing[index] !== original[index]) throw cause
  }
}

export async function flushPendingWrites(userId: string): Promise<{ remaining: number; error: string }> {
  if (running) return { remaining: (await pendingWrites(userId)).length, error: '' }
  running = true
  let error = ''
  let completed = 0
  try {
    for (const write of await pendingWrites(userId)) {
      try {
        if (write.kind === 'pet' || write.kind === 'record') {
          await localWrite(write.path, 'POST', write.body)
        } else if (write.kind === 'file') {
          await uploadQueuedFile(write.path, write.file!)
          await localWrite(write.body!.recordPath as string, 'POST', write.body!.metadata)
        } else {
          await uploadQueuedFile(write.path, write.file!)
          const pet = await localData<{ row_version: string; photo_path: string | null }>(write.body!.petPath as string)
          if (pet.photo_path !== write.path) {
            if (pet.row_version !== write.expectedVersion && pet.photo_path !== write.body!.previousPhoto) {
              throw new Error('La foto de la mascota cambió en el servidor. Revisa esta subida pendiente.')
            }
            await localWrite(write.body!.petPath as string, 'PATCH', { expected_version: pet.row_version, changes: { photo_path: write.path } })
          }
        }
        await removeWrite(write.id)
        completed++
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'No fue posible sincronizar los datos pendientes.'
        break
      }
    }
  } finally {
    running = false
  }
  if (completed) window.dispatchEvent(new Event('pending-writes-synced'))
  return { remaining: (await pendingWrites(userId)).length, error }
}

export type { PendingWrite }
