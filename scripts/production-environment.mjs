import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const productionRef = 'hvfubwyzarikudisbwfy'

export function assertProductionEnvironment(env = process.env) {
  if (env.AA_MODE !== 'production' || env.AA_DB_NAME !== 'accion_animal_produ'
    || env.VITE_SUPABASE_URL !== `https://${productionRef}.supabase.co`
    || !env.VITE_SUPABASE_PUBLISHABLE_KEY || env.AA_STORAGE_ROOT !== 'uploaded/production') {
    throw new Error('Configuración de PRODUCCIÓN incompleta o cruzada; no se inició.')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  assertProductionEnvironment()
  if (process.argv[2] === '--mark') await writeFile('dist-production/project-ref', productionRef)
  else if (process.argv.length !== 2) throw new Error('Opción no admitida.')
  console.log(`Entorno: PRODUCCIÓN | Supabase: ${productionRef}`)
}
