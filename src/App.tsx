import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  ClipboardPlus,
  Eye,
  EyeOff,
  LayoutDashboard,
  LogOut,
  Menu,
  PawPrint,
  Plus,
  Search,
  ShieldCheck,
  Stethoscope,
  Trash2,
  X,
} from 'lucide-react'
import { supabase } from './lib/supabase'
import { clearLocalSession, establishLocalSession, localFileUrl } from './lib/localFiles'
import { vaccineOptions } from './lib/vaccines'
import { PetDetails, type DetailedPet } from './components/PetDetails'

type Role = 'owner' | 'veterinarian' | 'reception'
type View = 'dashboard' | 'pets' | 'inactive-pets' | 'local-preview' | 'users'

interface Profile {
  id: string
  display_name: string
  role: Role
  is_active: boolean
  created_at: string
}

type Pet = DetailedPet

const petFields = 'id, legacy_id, name, birth_date, color_markings, species, breed, usual_food, sex, is_sterilized, sterilization_date, status, photo_path, guardian_name, guardian_phone, guardian_address, guardian_street, guardian_number, referral_source, created_at'

const roleLabels: Record<Role, string> = {
  owner: 'Dueño',
  veterinarian: 'Veterinario',
  reception: 'Recepción',
}

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard; ownerOnly?: boolean }> = [
  { id: 'dashboard', label: 'Resumen', icon: LayoutDashboard },
  { id: 'pets', label: 'Mascotas', icon: PawPrint },
  { id: 'inactive-pets', label: 'Mascotas inactivas', icon: PawPrint },
  { id: 'local-preview', label: 'Datos locales (prueba)', icon: PawPrint },
  { id: 'users', label: 'Usuarios', icon: ShieldCheck, ownerOnly: true },
]

function formatDate(value: string, withTime = false) {
  const date = new Date(value)
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}

function todayDateValue() {
  const today = new Date()
  const offset = today.getTimezoneOffset() * 60_000
  return new Date(today.getTime() - offset).toISOString().slice(0, 10)
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) setError('No fue posible iniciar sesión. Revisa tu correo y contraseña.')
    setLoading(false)
  }

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="Acción Animal">
        <div className="login-brand-inner">
          <img src="./logo.jpg" alt="Logotipo de Acción Animal" className="login-logo" />
          <h1>Acción Animal</h1>
          <p className="environment-badge">ENTORNO DE PRUEBAS</p>
          <p className="login-copy">Sistema de gestión</p>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="mobile-logo"><img src="./logo.jpg" alt="Acción Animal" /></div>
          <p className="environment-badge environment-badge-dark">ENTORNO DE PRUEBAS</p>
          <p className="eyebrow">Bienvenido</p>
          <h2>Inicia sesión</h2>
          <p className="muted">Usa la cuenta proporcionada por el administrador.</p>
          <label>
            Correo electrónico
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="nombre@correo.com"
              required
            />
          </label>
          <label>
            Contraseña
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="••••••••••"
                required
              />
              <button
                className="password-toggle"
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary full" type="submit" disabled={loading}>
            {loading ? 'Ingresando…' : 'Ingresar'}
            {!loading && <ChevronRight size={18} />}
          </button>
          <p className="login-help">¿Problemas para acceder? Contacta al usuario dueño.</p>
        </form>
      </section>
    </main>
  )
}

function EmptyState({ icon: Icon, title, text }: { icon: typeof PawPrint; title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={25} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

function ReceptionCalendar() {
  const today = new Date()
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const firstWeekday = (month.getDay() + 6) % 7
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const monthLabel = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(month)

  return (
    <article className="panel calendar-panel">
      <div className="panel-header calendar-header">
        <div><p className="eyebrow">Calendario</p><h2 className="calendar-month">{monthLabel}</h2></div>
        <div className="calendar-controls">
          <button className="icon-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Mes anterior"><ChevronLeft size={19} /></button>
          <button className="text-button" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Hoy</button>
          <button className="icon-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Mes siguiente"><ChevronRight size={19} /></button>
        </div>
      </div>
      <div className="calendar-grid" aria-label={monthLabel}>
        {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}
        {Array.from({ length: firstWeekday }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1
          const isToday = day === today.getDate() && month.getMonth() === today.getMonth() && month.getFullYear() === today.getFullYear()
          return <time className={isToday ? 'calendar-day today' : 'calendar-day'} key={day} dateTime={`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`}>{day}</time>
        })}
      </div>
    </article>
  )
}

function PetAvatar({ pet, size = 18 }: { pet: Pet; size?: number }) {
  const [failed, setFailed] = useState(false)
  const source = localFileUrl(pet.photo_path)
  return (
    <span className={`pet-avatar ${source && !failed ? 'has-photo' : ''}`}>
      {source && !failed
        ? <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <PawPrint size={size} />}
    </span>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}

function PetForm({ onClose, onSaved }: { onClose: () => void; onSaved: (petId: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [species, setSpecies] = useState<keyof typeof vaccineOptions | ''>('')
  const [vaccinations, setVaccinations] = useState([{ vaccine_name: '', administered_on: todayDateValue() }])

  function changeVaccine(index: number, vaccineName: string) {
    setVaccinations((current) => {
      const next = current.map((entry, entryIndex) => entryIndex === index ? { ...entry, vaccine_name: vaccineName } : entry)
      if (vaccineName && species && index === current.length - 1 && current.length < vaccineOptions[species].length) next.push({ vaccine_name: '', administered_on: todayDateValue() })
      return next
    })
  }

  function removeVaccine(index: number) {
    setVaccinations((current) => {
      const next = current.filter((_, entryIndex) => entryIndex !== index)
      if (species && next.every((entry) => entry.vaccine_name) && next.length < vaccineOptions[species].length) next.push({ vaccine_name: '', administered_on: todayDateValue() })
      return next
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const sterilizedValue = String(data.get('is_sterilized') || '')
    const sterilizationDate = String(data.get('sterilization_date') || '')
    const observation = String(data.get('observation') || '').trim()
    if (!species) {
      setError('Selecciona la especie de la mascota.')
      setSaving(false)
      return
    }
    if (sterilizationDate && sterilizedValue !== 'true') {
      setError('Para guardar una fecha de esterilización, selecciona “Sí” en esterilización.')
      setSaving(false)
      return
    }
    const payload = {
      name: String(data.get('name') || '').trim(),
      guardian_name: String(data.get('guardian_name') || '').trim(),
      guardian_phone: String(data.get('guardian_phone') || '').trim() || null,
      species,
      breed: String(data.get('breed') || '').trim() || null,
      sex: String(data.get('sex') || 'unknown'),
      color_markings: String(data.get('color_markings') || '').trim() || null,
      birth_date: String(data.get('birth_date') || '') || todayDateValue(),
      usual_food: String(data.get('usual_food') || '').trim() || null,
      is_sterilized: sterilizedValue === '' ? null : sterilizedValue === 'true',
      sterilization_date: sterilizationDate || null,
      guardian_address: String(data.get('guardian_address') || '').trim() || null,
      guardian_street: String(data.get('guardian_street') || '').trim() || null,
      guardian_number: String(data.get('guardian_number') || '').trim() || null,
      referral_source: String(data.get('referral_source') || '').trim() || null,
    }
    const selectedVaccinations = vaccinations.filter((entry) => entry.vaccine_name)
    if (selectedVaccinations.some((entry) => !(vaccineOptions[species] as readonly string[]).includes(entry.vaccine_name))) {
      setError('La vacuna seleccionada no corresponde a la especie de la mascota.')
      setSaving(false)
      return
    }
    const { data: insertedPet, error: insertError } = await supabase.from('pets').insert(payload).select('id').single()
    if (insertError || !insertedPet) {
      setError(insertError?.message || 'No fue posible guardar la mascota.')
      setSaving(false)
      return
    }
    let relatedError: { message: string } | null = null
    if (selectedVaccinations.length) {
      const result = await supabase.from('vaccinations').insert(selectedVaccinations.map((entry) => ({ pet_id: insertedPet.id, vaccine_name: entry.vaccine_name, administered_on: entry.administered_on || todayDateValue() })))
      relatedError = result.error
    }
    if (!relatedError && observation) {
      const result = await supabase.from('pet_notes').insert({ pet_id: insertedPet.id, body: observation })
      relatedError = result.error
    }
    if (relatedError) {
      const { error: cleanupError } = await supabase.from('pets').delete().eq('id', insertedPet.id)
      setError(cleanupError ? `${relatedError.message} La mascota quedó creada de forma incompleta; elimínala antes de intentar nuevamente.` : relatedError.message)
      setSaving(false)
      return
    }
    await onSaved(insertedPet.id)
    onClose()
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <label>Nombre de la mascota<input name="name" required maxLength={200} autoFocus /></label>
      <label>Especie<select name="species" required value={species} onChange={(event) => { setSpecies(event.target.value as keyof typeof vaccineOptions); setVaccinations([{ vaccine_name: '', administered_on: todayDateValue() }]) }}><option value="" disabled>Selecciona una especie</option><option value="perro">Perro</option><option value="gato">Gato</option></select></label>
      <label>Raza<input name="breed" maxLength={120} /></label>
      <label>Sexo
        <select name="sex" defaultValue="unknown">
          <option value="unknown">Sin especificar</option>
          <option value="female">Hembra</option>
          <option value="male">Macho</option>
        </select>
      </label>
      <label>Fecha de nacimiento<input name="birth_date" type="date" defaultValue={todayDateValue()} /></label>
      <label>Color y señas<input name="color_markings" /></label>
      <label>Alimento habitual<input name="usual_food" maxLength={200} /></label>
      <label>Esterilización<select name="is_sterilized" defaultValue=""><option value="">Sin especificar</option><option value="true">Sí</option><option value="false">No</option></select></label>
      <label>Fecha de esterilización<input name="sterilization_date" type="date" /></label>
      <label className="span-2">Observaciones de mascota o propietario<textarea name="observation" rows={3} maxLength={2000} placeholder="Ej. Cliente de trato difícil o mascota con parvovirus" /></label>
      <div className="form-section-title span-2"><span>Vacunas</span><small>Opcional</small></div>
      {vaccinations.map((vaccination, index) => <div className="vaccine-entry span-2" key={index}>
        <label>Tipo de vacuna<select value={vaccination.vaccine_name} disabled={!species} onChange={(event) => changeVaccine(index, event.target.value)}><option value="">{species ? 'Selecciona una vacuna' : 'Selecciona primero la especie'}</option>{species && vaccineOptions[species].filter((name) => name === vaccination.vaccine_name || !vaccinations.some((entry) => entry.vaccine_name === name)).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Fecha de aplicación<input type="date" value={vaccination.administered_on} onChange={(event) => setVaccinations((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, administered_on: event.target.value } : entry))} /></label>
        {vaccination.vaccine_name && <button type="button" className="icon-button danger-icon" aria-label={`Quitar vacuna ${vaccination.vaccine_name}`} title="Quitar vacuna" onClick={() => removeVaccine(index)}><X size={17} /></button>}
      </div>)}
      <div className="form-section-title span-2"><span>Tutor de esta mascota</span><small>Los datos pueden repetirse en otras mascotas.</small></div>
      <label>Nombre del tutor<input name="guardian_name" required maxLength={200} /></label>
      <label>Teléfono del tutor<input name="guardian_phone" type="tel" maxLength={40} /></label>
      <label>Colonia<input name="guardian_address" maxLength={200} /></label>
      <label>Calle<input name="guardian_street" maxLength={200} /></label>
      <label>Número<input name="guardian_number" maxLength={40} /></label>
      <label className="span-2">¿Cómo conoció la clínica?<input name="referral_source" maxLength={200} /></label>
      {error && <p className="form-error span-2">{error}</p>}
      <div className="form-actions span-2">
        <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar mascota'}</button>
      </div>
    </form>
  )
}

async function functionErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: Response }).context
    try {
      const body = await context?.clone().json() as { error?: string }
      if (body?.error) return body.error
    } catch {
      // The fallback below is intentionally user-friendly when the response has no JSON body.
    }
  }
  return fallback
}

function CreateUserForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const password = String(data.get('password') || '')
    const confirmation = String(data.get('confirmation') || '')
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.')
      setSaving(false)
      return
    }
    if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      setError('Usa al menos 10 caracteres, una mayúscula, una minúscula y un número.')
      setSaving(false)
      return
    }
    const { error: invokeError } = await supabase.functions.invoke('manage-users', {
      body: {
        displayName: String(data.get('display_name') || '').trim(),
        email: String(data.get('email') || '').trim(),
        role: String(data.get('role') || ''),
        password,
      },
    })

    if (invokeError) {
      setError(await functionErrorMessage(invokeError, 'No fue posible crear el acceso. Intenta de nuevo.'))
      setSaving(false)
      return
    }

    await onCreated()
    onClose()
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <p className="form-intro span-2">Define las credenciales. La cuenta quedará activa inmediatamente y no se enviará una invitación.</p>
      <label className="span-2">Nombre completo<input name="display_name" required minLength={2} maxLength={120} autoFocus /></label>
      <label className="span-2">Correo electrónico<input name="email" type="email" required maxLength={254} autoComplete="off" placeholder="nombre@correo.com" /></label>
      <label className="span-2">Rol
        <select name="role" defaultValue="reception" required>
          <option value="reception">Recepción</option>
          <option value="veterinarian">Veterinario</option>
        </select>
      </label>
      <label>Contraseña<input name="password" type="password" minLength={10} autoComplete="new-password" required /></label>
      <label>Confirmar contraseña<input name="confirmation" type="password" minLength={10} autoComplete="new-password" required /></label>
      <p className="form-note span-2"><ShieldCheck size={17} /> Mínimo 10 caracteres, con mayúscula, minúscula y número. La contraseña no se guarda en esta aplicación.</p>
      <p className="form-note span-2"><ShieldCheck size={17} /> Por seguridad, desde aquí no se puede crear otro usuario dueño.</p>
      {error && <p className="form-error span-2" role="alert">{error}</p>}
      <div className="form-actions span-2">
        <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button primary" disabled={saving}>{saving ? 'Validando…' : 'Crear acceso'}</button>
      </div>
    </form>
  )
}

function DeleteUserForm({ user, onClose, onDeleted }: { user: Profile; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDeleting(true)
    setError('')

    const { error: invokeError } = await supabase.functions.invoke('manage-users', {
      method: 'DELETE',
      body: { userId: user.id },
    })

    if (invokeError) {
      setError(await functionErrorMessage(invokeError, 'No fue posible eliminar el usuario. Intenta de nuevo.'))
      setDeleting(false)
      return
    }

    await onDeleted()
    onClose()
  }

  return (
    <form className="delete-confirm" onSubmit={submit}>
      <span className="delete-confirm-icon"><Trash2 size={26} /></span>
      <div>
        <h3>¿Eliminar a {user.display_name}?</h3>
        <p>La cuenta y su acceso se eliminarán definitivamente de Supabase.</p>
      </div>
      <div className="retention-note">
        <ShieldCheck size={19} />
        <p><strong>El historial se conservará.</strong> No se borrarán mascotas, expedientes, notas, auditorías ni archivos creados por esta persona.</p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button danger" disabled={deleting}>{deleting ? 'Eliminando…' : 'Eliminar usuario'}</button>
      </div>
    </form>
  )
}

function LocalPreview() {
  const [pets, setPets] = useState<Pet[]>([])
  const [selected, setSelected] = useState<Pet | null>(null)
  const [records, setRecords] = useState<Array<{ id: string; occurred_at: string; provisional_diagnosis: string | null; treatment: string | null }>>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingRecords, setLoadingRecords] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/local/pets?status=all&limit=200', { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'No fue posible consultar PostgreSQL local.')
        setPets(body.data as Pet[])
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Error de consulta local.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setRecords([])
    setLoadingRecords(true)
    void fetch(`/api/local/pets/${selected.id}/clinical-records?limit=200`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'No fue posible consultar los expedientes locales.')
        setRecords(body.data)
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Error de consulta local.') })
      .finally(() => { if (!controller.signal.aborted) setLoadingRecords(false) })
    return () => controller.abort()
  }, [selected])

  return <section className="panel page-panel">
    <div className="page-actions"><div><p className="eyebrow">PostgreSQL local</p><h2>Datos locales de prueba</h2><p className="muted">Vista de solo lectura, limitada a 200 mascotas. La pantalla principal todavía usa Supabase.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <p>Cargando datos locales…</p> : pets.length === 0 ? <p>No hay mascotas en PostgreSQL local.</p> : <div className="table-wrap responsive-table"><table><thead><tr><th>Mascota</th><th>Tutor</th><th>Especie</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{pets.map((pet) => <tr key={pet.id}><td>{pet.name}</td><td>{pet.guardian_name}</td><td>{pet.species}</td><td>{pet.status}</td><td><button className="text-button" onClick={() => { setError(''); setSelected(pet) }}>Ver expedientes</button></td></tr>)}</tbody></table></div>}
    {selected && <div><h3>{selected.name}</h3><p>Tutor: {selected.guardian_name} · Fecha de nacimiento: {selected.birth_date || '—'}</p><h4>Expedientes locales</h4>{loadingRecords ? <p>Cargando expedientes…</p> : records.length ? records.map((record) => <p key={record.id}>{formatDate(record.occurred_at, true)} · {record.provisional_diagnosis || 'Sin diagnóstico'} · {record.treatment || 'Sin tratamiento'}</p>) : <p>Sin expedientes registrados.</p>}</div>}
  </section>
}

function Workspace({ session, onSignOut }: { session: Session; onSignOut: () => Promise<void> }) {
  const workspaceStorageKey = `accion-animal:workspace:${session.user.id}`
  const restoredWorkspace = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) || '{}') as { view?: unknown; search?: unknown; selectedPetId?: unknown; expandedPetId?: unknown }
      return {
        view: saved.view === 'pets' || saved.view === 'inactive-pets' || saved.view === 'local-preview' || saved.view === 'users' ? saved.view : 'dashboard' as View,
        search: typeof saved.search === 'string' ? saved.search : '',
        selectedPetId: typeof saved.selectedPetId === 'string' ? saved.selectedPetId : typeof saved.expandedPetId === 'string' ? saved.expandedPetId : null,
      }
    } catch {
      return { view: 'dashboard' as View, search: '', selectedPetId: null }
    }
  }, [workspaceStorageKey])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [pets, setPets] = useState<Pet[]>([])
  const [dashboardCounts, setDashboardCounts] = useState({ activePets: 0, clinicalRecords: 0, inactivePets: 0 })
  const [searchResults, setSearchResults] = useState<Pet[] | null>(null)
  const [view, setView] = useState<View>(restoredWorkspace.view)
  const [search, setSearch] = useState(restoredWorkspace.search)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [modal, setModal] = useState<'pet' | 'create-user' | null>(null)
  const [userToDelete, setUserToDelete] = useState<Profile | null>(null)
  const [selectedPetId, setSelectedPetId] = useState<string | null>(restoredWorkspace.selectedPetId)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    const [profileResult, profilesResult, activePetListResult, inactivePetListResult, totalPetsResult, activePetsResult, clinicalRecordsResult] = await Promise.all([
      supabase.from('profiles').select('id, display_name, role, is_active, created_at').eq('id', session.user.id).single(),
      supabase.from('profiles').select('id, display_name, role, is_active, created_at').order('created_at', { ascending: true }),
      supabase.from('pets').select(petFields).eq('status', 'active').order('created_at', { ascending: false }).limit(500),
      supabase.from('pets').select(petFields).neq('status', 'active').order('created_at', { ascending: false }).limit(500),
      supabase.from('pets').select('id', { count: 'exact', head: true }),
      supabase.from('pets').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('clinical_records').select('id', { count: 'exact', head: true }),
    ])

    const firstError = profileResult.error || profilesResult.error || activePetListResult.error || inactivePetListResult.error || totalPetsResult.error || activePetsResult.error || clinicalRecordsResult.error
    if (firstError) setError(firstError.message)
    if (profileResult.data) setProfile(profileResult.data as Profile)
    if (profilesResult.data) setProfiles(profilesResult.data as Profile[])
    if (activePetListResult.data || inactivePetListResult.data) setPets([...(activePetListResult.data || []), ...(inactivePetListResult.data || [])] as Pet[])
    const totalPets = totalPetsResult.count || 0
    const activePets = activePetsResult.count || 0
    setDashboardCounts({ activePets, clinicalRecords: clinicalRecordsResult.count || 0, inactivePets: totalPets - activePets })
    setLoading(false)
  }, [session.user.id])

  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    try {
      localStorage.setItem(workspaceStorageKey, JSON.stringify({ view, search, selectedPetId }))
    } catch {
      // La app sigue funcionando aunque el navegador bloquee el almacenamiento local.
    }
  }, [workspaceStorageKey, view, search, selectedPetId])

  useEffect(() => {
    if (profile && profile.role !== 'owner' && view === 'users') setView('dashboard')
  }, [profile, view])

  useEffect(() => {
    const term = search.trim().replace(/[,%()]/g, ' ').trim()
    if (!term) {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const pattern = `%${term}%`
      const filters = ['name', 'species', 'breed', 'guardian_name', 'guardian_phone'].map((field) => `${field}.ilike.${pattern}`)
      if (/^\d+$/.test(term)) filters.push(`legacy_id.eq.${term}`)
      let query = supabase
        .from('pets')
        .select(petFields)
        .or(filters.join(','))
        .order('created_at', { ascending: false })
        .limit(200)
      query = view === 'inactive-pets' ? query.neq('status', 'active') : query.eq('status', 'active')
      const { data, error: searchError } = await query
      if (cancelled) return
      if (searchError) setError(searchError.message)
      setSearchResults((data || []) as Pet[])
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, view])

  const filteredPets = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    if (term && searchResults) return searchResults
    const petsInView = pets.filter((pet) => view === 'inactive-pets' ? pet.status !== 'active' : pet.status === 'active')
    if (!term) return petsInView
    return petsInView.filter((pet) => [pet.name, pet.species, pet.breed, pet.guardian_name, pet.guardian_phone].some((value) => value?.toLocaleLowerCase('es').includes(term)))
  }, [pets, search, searchResults, view])

  const selectedPet = selectedPetId
    ? searchResults?.find((pet) => pet.id === selectedPetId) || pets.find((pet) => pet.id === selectedPetId) || null
    : null

  const openView = (nextView: View) => {
    setView(nextView)
    setSearch('')
    setSelectedPetId(null)
    setMobileNav(false)
  }

  const todayLabel = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())

  if (loading && !profile) return <div className="app-loader"><span className="loader" /><p>Cargando espacio de trabajo…</p></div>

  if (!profile || !profile.is_active) {
    return <div className="app-loader"><p className="form-error">Tu perfil no está disponible o se encuentra desactivado.</p><button className="button secondary" onClick={() => void onSignOut()}>Cerrar sesión</button></div>
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img src="./logo.jpg" alt="Acción Animal" />
          <div><strong>Acción Animal</strong><span>ENTORNO DE PRUEBAS</span></div>
        </div>
        <nav aria-label="Navegación principal">
          <p className="nav-caption">MENÚ</p>
          {navItems.filter((item) => !item.ownerOnly || profile.role === 'owner').map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => openView(item.id)}>
                <Icon size={19} /><span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-profile">
          <span className="avatar">{initials(profile.display_name)}</span>
          <div><strong>{profile.display_name}</strong><span>{roleLabels[profile.role]}</span></div>
          <button className="icon-button dark" onClick={() => void onSignOut()} aria-label="Cerrar sesión"><LogOut size={18} /></button>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" aria-label="Cerrar menú" onClick={() => setMobileNav(false)} />}

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="Abrir menú"><Menu /></button>
          <div>
            <p className="eyebrow">{todayLabel}</p>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-user"><CircleUserRound size={20} /><span>{roleLabels[profile.role]}</span></div>
        </header>

        <div className="content">
          {error && <div className="alert error"><strong>No se pudo cargar toda la información.</strong><span>{error}</span></div>}
          {notice && <div className="alert success" role="status"><ShieldCheck size={18} /><span>{notice}</span></div>}

          {view === 'local-preview' && <LocalPreview />}

          {view === 'dashboard' && (
            <>
              <section className="stat-grid">
                <article className="stat-card"><span className="stat-icon green"><PawPrint /></span><div><strong>{dashboardCounts.activePets}</strong><span>Mascotas activas</span></div></article>
                <article className="stat-card"><span className="stat-icon blue"><ClipboardPlus /></span><div><strong>{dashboardCounts.clinicalRecords}</strong><span>Total de expedientes</span></div></article>
                <article className="stat-card"><span className="stat-icon amber"><PawPrint /></span><div><strong>{dashboardCounts.inactivePets}</strong><span>Mascotas inactivas</span></div></article>
              </section>
              <section className="dashboard-grid">
                <ReceptionCalendar />
                <article className="panel tools-panel">
                  <div className="panel-header"><div><p className="eyebrow">Herramientas</p><h2>Accesos rápidos</h2></div><CalendarDays size={22} aria-hidden="true" /></div>
                  <div className="quick-actions">
                    <button className="quick-action" onClick={() => openView('pets')}><span className="stat-icon green"><Search size={20} /></span><span><strong>Buscar mascota</strong><small>Consulta datos y expedientes clínicos</small></span><ChevronRight size={18} /></button>
                    <button className="quick-action" onClick={() => openView('inactive-pets')}><span className="stat-icon amber"><PawPrint size={20} /></span><span><strong>Decesos</strong><small>Consulta mascotas enviadas a decesos</small></span><ChevronRight size={18} /></button>
                    {profile.role !== 'reception' && <button className="quick-action" onClick={() => setModal('pet')}><span className="stat-icon blue"><Plus size={20} /></span><span><strong>Registrar mascota</strong><small>Crea un expediente nuevo</small></span><ChevronRight size={18} /></button>}
                    {profile.role === 'owner' && <button className="quick-action" onClick={() => openView('users')}><span className="stat-icon amber"><ShieldCheck size={20} /></span><span><strong>Administrar usuarios</strong><small>Gestiona accesos y roles</small></span><ChevronRight size={18} /></button>}
                  </div>
                </article>
              </section>
            </>
          )}

          {(view === 'pets' || view === 'inactive-pets') && (
            <section className="panel page-panel">
              <div className="page-actions"><div><p className="eyebrow">Expedientes</p><h2>{view === 'inactive-pets' ? 'Decesos' : 'Mascotas'}</h2><p className="muted">{view === 'inactive-pets' ? 'Mascotas enviadas a decesos. El estado se puede revertir.' : 'La búsqueda muestra únicamente mascotas activas.'}</p></div>{view === 'pets' && profile.role !== 'reception' && <button className="button primary" onClick={() => setModal('pet')}><Plus size={18} /> Nueva mascota</button>}</div>
              <div className="search-box"><input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedPetId(null) }} placeholder="Buscar por ID, mascota, especie, raza, tutor o teléfono" /><Search size={19} /></div>
              {selectedPet ? (
                <section className="pet-detail-section" aria-labelledby="selected-pet-title">
                  <header className="pet-detail-header">
                    <button className="button primary" onClick={() => setSelectedPetId(null)}><ArrowLeft size={18} /> Volver a resultados</button>
                    <div><p className="eyebrow">Detalle de mascota</p><h3 id="selected-pet-title">{selectedPet.name}</h3></div>
                  </header>
                  <PetDetails pet={selectedPet} role={profile.role} userId={session.user.id} professionalName={profile.display_name} onPetChanged={(updatedPet, movedList = false) => { setPets((current) => current.map((item) => item.id === updatedPet.id ? updatedPet : item)); setSearchResults((current) => current?.map((item) => item.id === updatedPet.id ? updatedPet : item) || null); if (movedList) { setSelectedPetId(null); void loadData(); setNotice(updatedPet.status === 'active' ? 'La mascota volvió a la lista de mascotas activas.' : 'La mascota fue enviada a la lista de inactivas.') } }} onPetDeleted={() => { setSelectedPetId(null); setSearchResults(null); void loadData(); setNotice('La mascota y sus expedientes fueron eliminados.') }} />
                </section>
              ) : filteredPets.length === 0 ? <EmptyState icon={PawPrint} title="Sin resultados" text={search ? 'Prueba con otro término de búsqueda.' : 'Todavía no hay mascotas registradas.'} /> : (
                <div className="table-wrap responsive-table pet-table-wrap"><table><thead><tr><th>Mascota</th><th>Tutor</th><th>Teléfono</th><th>Especie / raza</th><th>Estado</th><th>Registro</th><th className="actions-column">Acción</th></tr></thead><tbody>{filteredPets.map((pet) => <tr className="clickable-row" key={pet.id} tabIndex={0} onClick={() => setSelectedPetId(pet.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedPetId(pet.id) } }}><td data-label="Mascota"><div className="name-cell"><PetAvatar pet={pet} size={17} /><strong>{pet.name}</strong></div></td><td data-label="Tutor">{pet.guardian_name}</td><td data-label="Teléfono">{pet.guardian_phone || '—'}</td><td data-label="Especie / raza">{[pet.species, pet.breed].filter(Boolean).join(' · ') || '—'}</td><td data-label="Estado"><span className={`status ${pet.status}`}>{pet.status === 'active' ? 'Activo' : 'Deceso'}</span></td><td data-label="Registro">{formatDate(pet.created_at)}</td><td className="actions-column"><button className="text-button detail-button" onClick={() => setSelectedPetId(pet.id)} aria-label={`Ver detalle de ${pet.name}`}>Abrir ficha</button></td></tr>)}</tbody></table></div>
              )}
            </section>
          )}

          {view === 'users' && profile.role === 'owner' && (
            <section className="panel page-panel">
              <div className="page-actions"><div><p className="eyebrow">Administración</p><h2>Usuarios y roles</h2><p className="muted">Solo el dueño puede crear o eliminar accesos.</p></div><button className="button primary" onClick={() => { setNotice(''); setModal('create-user') }}><Plus size={18} /> Crear acceso</button></div>
              <div className="alert"><ShieldCheck size={18} /><span>Las cuentas pueden tener el rol Veterinario o Recepción. Al eliminarlas, su historial permanece.</span></div>
              <div className="table-wrap responsive-table"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Registro</th><th className="actions-column">Acciones</th></tr></thead><tbody>{profiles.map((user) => <tr key={user.id}><td data-label="Usuario"><div className="name-cell"><span className="avatar table-avatar">{initials(user.display_name)}</span><strong>{user.display_name}</strong></div></td><td data-label="Rol">{roleLabels[user.role]}</td><td data-label="Estado"><span className={`status ${user.is_active ? 'active' : 'inactive'}`}>{user.is_active ? 'Activo' : 'Inactivo'}</span></td><td data-label="Registro">{formatDate(user.created_at)}</td><td className="actions-column" data-label="Acciones">{user.role === 'owner' ? <span className="muted">Protegido</span> : <button className="icon-button danger-icon" onClick={() => { setNotice(''); setUserToDelete(user) }} aria-label={`Eliminar a ${user.display_name}`} title="Eliminar usuario"><Trash2 size={17} /></button>}</td></tr>)}</tbody></table></div>
            </section>
          )}
        </div>
      </main>

      {modal === 'pet' && <Modal title="Registrar mascota" onClose={() => setModal(null)}><PetForm onClose={() => setModal(null)} onSaved={async (petId) => { await loadData(); setView('pets'); setSearch(''); setSearchResults(null); setSelectedPetId(petId); setNotice('Mascota, tutor y vacunas registrados.') }} /></Modal>}
      {modal === 'create-user' && <Modal title="Crear acceso" onClose={() => setModal(null)}><CreateUserForm onClose={() => setModal(null)} onCreated={async () => { await loadData(); setNotice('Acceso creado y validado. La persona ya puede iniciar sesión con el correo y la contraseña definidos.') }} /></Modal>}
      {userToDelete && <Modal title="Eliminar usuario" onClose={() => setUserToDelete(null)}><DeleteUserForm user={userToDelete} onClose={() => setUserToDelete(null)} onDeleted={async () => { await loadData(); setNotice('Usuario eliminado. Sus acciones, expedientes y archivos se conservaron.') }} /></Modal>}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [localReady, setLocalReady] = useState(false)
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => data.subscription.unsubscribe()
  }, [])

  const connectLocalStorage = useCallback(async (activeSession: Session) => {
    setLocalError('')
    try {
      await establishLocalSession(activeSession.access_token)
      setLocalReady(true)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No fue posible conectar con el almacenamiento local.')
    }
  }, [])

  useEffect(() => {
    if (session) void connectLocalStorage(session)
    else {
      setLocalReady(false)
      setLocalError('')
      void clearLocalSession()
    }
  }, [session, session?.access_token, connectLocalStorage])

  const signOut = useCallback(async () => {
    await clearLocalSession()
    await supabase.auth.signOut()
  }, [])

  if (!ready) return <div className="app-loader"><span className="loader" /><p>Preparando acceso seguro…</p></div>
  if (session && localError) {
    return (
      <div className="app-loader local-error">
        <p className="form-error"><strong>El almacenamiento local no está disponible.</strong><br />{localError}</p>
        <p>Comprueba que abriste la aplicación desde la PC servidor o desde su dirección de red.</p>
        <div className="local-error-actions">
          <button className="button primary" onClick={() => void connectLocalStorage(session)}>Reintentar</button>
          <button className="button secondary" onClick={() => void signOut()}>Cerrar sesión</button>
        </div>
      </div>
    )
  }
  if (session && !localReady) return <div className="app-loader"><span className="loader" /><p>Conectando archivos locales…</p></div>
  return session ? <Workspace session={session} onSignOut={signOut} /> : <Login />
}
