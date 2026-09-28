import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY')
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    // La sesión clínica vive en el servidor local. Supabase solo se usa
    // durante el acceso con internet y la administración de cuentas.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
})
