import test from 'node:test'
import assert from 'node:assert/strict'
import { testProjectRef, validateLocalDatabaseUrl, validateTestConfiguration } from './test-environment.mjs'

const testUrl = `https://${testProjectRef}.supabase.co`

test('acepta el proyecto de pruebas enlazado', () => {
  assert.doesNotThrow(() => validateTestConfiguration({ configuredUrl: testUrl, linkedRef: testProjectRef }))
})

test('bloquea una URL de producción aunque el enlace CLI sea de pruebas', () => {
  assert.throws(() => validateTestConfiguration({ configuredUrl: 'https://hvfubwyzarikudisbwfy.supabase.co', linkedRef: testProjectRef }), /URL de Supabase incorrecta/)
})

test('bloquea un proyecto CLI distinto aunque la URL sea de pruebas', () => {
  assert.throws(() => validateTestConfiguration({ configuredUrl: testUrl, linkedRef: 'hvfubwyzarikudisbwfy' }), /Proyecto Supabase enlazado incorrecto/)
})

test('bloquea una variable de entorno que sobrescriba la URL', () => {
  assert.throws(() => validateTestConfiguration({ configuredUrl: testUrl, linkedRef: testProjectRef, activeUrls: ['https://hvfubwyzarikudisbwfy.supabase.co'] }), /URL de Supabase incorrecta/)
})

test('permite la base local y bloquea una URL PostgreSQL remota', () => {
  assert.doesNotThrow(() => validateLocalDatabaseUrl('postgresql://postgres:clave@127.0.0.1:5432/accion_animal_dev'))
  assert.throws(() => validateLocalDatabaseUrl('postgresql://postgres:clave@db.hvfubwyzarikudisbwfy.supabase.co:5432/postgres'), /DATABASE_URL/)
})
