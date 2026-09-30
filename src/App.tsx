import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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
import { clearLocalSession, localFileUrl } from './lib/localFiles'
import { currentLocalUser, localLogin, type LocalUser } from './lib/localAuth'
import { vaccineOptions } from './lib/vaccines'
import type { DetailedPet } from './components/PetDetails'
import { localData, localWrite } from './lib/localApi'
const PetDetails = lazy(() => import('./components/PetDetails').then((module) => ({ default: module.PetDetails })))
const environmentLabel = import.meta.env.MODE === 'production' ? 'PRODUCCIÓN' : 'PRUEBAS'

type Role = 'owner' | 'veterinarian' | 'reception'
type View = 'dashboard' | 'pets' | 'inactive-pets' | 'users'

interface Profile {
  id: string
  display_name: string
  role: Role
  is_active: boolean
  created_at: string
}

type Pet = DetailedPet
type LocalPet = Pet & { row_version: string }

async function localPets(): Promise<LocalPet[]> {
  const pets: LocalPet[] = []
  // ponytail: carga hasta 50 000 mascotas; paginar en el servidor si la apertura se vuelve lenta.
  for (let offset = 0; offset <= 50000; offset += 200) {
    const page = await localData<LocalPet[]>(`pets?status=all&limit=200&offset=${offset}`)
    pets.push(...page)
    if (page.length < 200) return pets
  }
  throw new Error('La lista local supera el límite de 50 000 mascotas. Usa la búsqueda.')
}

const roleLabels: Record<Role, string> = {
  owner: 'Dueño',
  veterinarian: 'Veterinario',
  reception: 'Recepción',
}

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard; ownerOnly?: boolean }> = [
  { id: 'dashboard', label: 'Resumen', icon: LayoutDashboard },
  { id: 'pets', label: 'Mascotas', icon: PawPrint },
  { id: 'inactive-pets', label: 'Mascotas inactivas', icon: PawPrint },
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

function Login({ onLogin }: { onLogin: (user: LocalUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      onLogin(await localLogin(email, password))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible iniciar sesión.')
    } finally {
      setPassword('')
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="Acción Animal">
        <div className="login-brand-inner">
          <img src="./logo.jpg" alt="Logotipo de Acción Animal" className="login-logo" />
          <h1>Acción Animal</h1>
          <p className="environment-badge">ENTORNO DE {environmentLabel}</p>
          <p className="login-copy">Sistema de gestión</p>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="mobile-logo"><img src="./logo.jpg" alt="Acción Animal" /></div>
          <p className="environment-badge environment-badge-dark">ENTORNO DE {environmentLabel}</p>
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
          <p className="login-help">El primer acceso requiere internet. Después podrás ingresar sin conexión durante siete días.</p>
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
    try {
      const insertedPet = await localData<LocalPet>('pets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pet: payload, vaccinations: selectedVaccinations.map((entry) => ({ ...entry, administered_on: entry.administered_on || todayDateValue() })), note: observation || null }),
      })
      await onSaved(insertedPet.id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible guardar la mascota local.')
    } finally {
      setSaving(false)
    }
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
    try {
      await localWrite('users', 'POST', {
        displayName: String(data.get('display_name') || '').trim(),
        email: String(data.get('email') || '').trim(),
        role: String(data.get('role') || ''),
        password,
      })
      await onCreated()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible crear el acceso.')
      setSaving(false)
    }
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
      <p className="form-note span-2"><ShieldCheck size={17} /> Mínimo 10 caracteres, con mayúscula, minúscula y número. Solo se guarda una huella segura en PostgreSQL local.</p>
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

    try {
      await localWrite(`users/${user.id}`, 'DELETE', {})
      await onDeleted()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible desactivar el usuario.')
      setDeleting(false)
    }
  }

  return (
    <form className="delete-confirm" onSubmit={submit}>
      <span className="delete-confirm-icon"><Trash2 size={26} /></span>
      <div>
        <h3>¿Desactivar a {user.display_name}?</h3>
        <p>Se desactivará su acceso local. No podrá iniciar sesión.</p>
      </div>
      <div className="retention-note">
        <ShieldCheck size={19} />
        <p><strong>El historial se conservará.</strong> No se borrarán mascotas, expedientes, notas, auditorías ni archivos creados por esta persona.</p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button danger" disabled={deleting}>{deleting ? 'Desactivando…' : 'Desactivar usuario'}</button>
      </div>
    </form>
  )
}

function Workspace({ session, onSignOut }: { session: { user: LocalUser }; onSignOut: () => Promise<void> }) {
  const workspaceStorageKey = `accion-animal:workspace:${session.user.id}`
  const restoredWorkspace = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) || '{}') as { view?: unknown; search?: unknown; selectedPetId?: unknown; expandedPetId?: unknown }
      return {
        view: saved.view === 'pets' || saved.view === 'inactive-pets' || saved.view === 'users' ? saved.view : 'dashboard' as View,
        search: typeof saved.search === 'string' ? saved.search : '',
        selectedPetId: typeof saved.selectedPetId === 'string' ? saved.selectedPetId : typeof saved.expandedPetId === 'string' ? saved.expandedPetId : null,
      }
    } catch {
      return { view: 'dashboard' as View, search: '', selectedPetId: null }
    }
  }, [workspaceStorageKey])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [usersError, setUsersError] = useState('')
  const [pets, setPets] = useState<LocalPet[]>([])
  const [dashboardCounts, setDashboardCounts] = useState({ activePets: 0, clinicalRecords: 0, inactivePets: 0 })
  const [searchResults, setSearchResults] = useState<LocalPet[] | null>(null)
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
    try {
      const [localProfile, petList, counts] = await Promise.all([
        localData<Profile>('profile'),
        localPets(),
        localData<{ activePets: number; inactivePets: number; clinicalRecords: number }>('summary'),
      ])
      setProfile(localProfile)
      setPets(petList)
      setDashboardCounts(counts)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible cargar los datos locales.')
    }
    setLoading(false)
  }, [session.user.id])

  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    if (view !== 'users' || profile?.role !== 'owner') return
    setUsersError('')
    let cancelled = false
    void localData<Profile[]>('profiles').then((data) => {
        if (cancelled) return
        setProfiles(data)
      }, () => {
        if (!cancelled) {
          setProfiles([])
          setUsersError('No fue posible cargar los usuarios locales.')
        }
      })
    return () => { cancelled = true }
  }, [view, profile?.role, loading])

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
    const term = search.trim().slice(0, 100)
    if (!term) {
      setSearchResults(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const statuses = view === 'inactive-pets' ? ['inactive', 'deceased'] : ['active']
        const results = await Promise.all(statuses.map((status) => localData<LocalPet[]>(`pets?status=${status}&limit=200&search=${encodeURIComponent(term)}`, { signal: controller.signal })))
        setSearchResults(results.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)))
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'No fue posible buscar mascotas.')
      }
    }, 250)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [search, view])

  const filteredPets = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    if (term && searchResults) return searchResults
    const petsInView = pets.filter((pet) => view === 'inactive-pets' ? pet.status !== 'active' : pet.status === 'active')
    if (!term) return petsInView.slice(0, 200)
    return petsInView.filter((pet) => [pet.name, pet.species, pet.breed, pet.guardian_name, pet.guardian_phone].some((value) => value?.toLocaleLowerCase('es').includes(term))).slice(0, 200)
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
    return <div className="app-loader"><p className="form-error">{error || 'Tu perfil no está disponible o se encuentra desactivado.'}</p><button className="button primary" onClick={() => void loadData()}>Reintentar</button><button className="button secondary" onClick={() => void onSignOut()}>Cerrar sesión</button></div>
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img src="./logo.jpg" alt="Acción Animal" />
          <div><strong>Acción Animal</strong><span>ENTORNO DE {environmentLabel}</span></div>
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
              <div className="search-box"><input value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setSelectedPetId(null) }} placeholder="Buscar por ID, mascota, especie, raza, tutor o teléfono" /><Search size={19} /></div>
              {selectedPet ? (
                <section className="pet-detail-section" aria-labelledby="selected-pet-title">
                  <header className="pet-detail-header">
                    <button className="button primary" onClick={() => setSelectedPetId(null)}><ArrowLeft size={18} /> Volver a resultados</button>
                    <div><p className="eyebrow">Detalle de mascota</p><h3 id="selected-pet-title">{selectedPet.name}</h3></div>
                  </header>
                  <Suspense fallback={<p>Cargando ficha…</p>}><PetDetails key={selectedPet.id} pet={selectedPet} role={profile.role} professionalName={profile.display_name} onPetChanged={(updatedPet, movedList = false) => { setPets((current) => current.map((item) => item.id === updatedPet.id ? updatedPet : item)); setSearchResults((current) => current?.map((item) => item.id === updatedPet.id ? updatedPet : item) || null); if (movedList) { setSelectedPetId(null); void loadData() } }} onPetDeleted={() => { setSelectedPetId(null); setSearchResults(null); void loadData() }} onRecordsChanged={() => void localData<{ activePets: number; inactivePets: number; clinicalRecords: number }>('summary').then(setDashboardCounts).catch((cause) => setError(String(cause)))} /></Suspense>
                </section>
              ) : filteredPets.length === 0 ? <EmptyState icon={PawPrint} title="Sin resultados" text={search ? 'Prueba con otro término de búsqueda.' : 'Todavía no hay mascotas registradas.'} /> : (
                <div className="table-wrap responsive-table pet-table-wrap"><table><thead><tr><th>Mascota</th><th>Tutor</th><th>Teléfono</th><th>Especie / raza</th><th>Estado</th><th>Registro</th><th className="actions-column">Acción</th></tr></thead><tbody>{filteredPets.map((pet) => <tr className="clickable-row" key={pet.id} tabIndex={0} onClick={() => setSelectedPetId(pet.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedPetId(pet.id) } }}><td data-label="Mascota"><div className="name-cell"><PetAvatar pet={pet} size={17} /><strong>{pet.name}</strong></div></td><td data-label="Tutor">{pet.guardian_name}</td><td data-label="Teléfono">{pet.guardian_phone || '—'}</td><td data-label="Especie / raza">{[pet.species, pet.breed].filter(Boolean).join(' · ') || '—'}</td><td data-label="Estado"><span className={`status ${pet.status}`}>{pet.status === 'active' ? 'Activo' : 'Deceso'}</span></td><td data-label="Registro">{formatDate(pet.created_at)}</td><td className="actions-column"><button className="text-button detail-button" onClick={() => setSelectedPetId(pet.id)} aria-label={`Ver detalle de ${pet.name}`}>Abrir ficha</button></td></tr>)}</tbody></table></div>
              )}
            </section>
          )}

          {view === 'users' && profile.role === 'owner' && (
            <section className="panel page-panel">
              <div className="page-actions"><div><p className="eyebrow">Administración</p><h2>Usuarios y roles</h2><p className="muted">Solo el dueño puede crear o desactivar accesos.</p></div><button className="button primary" onClick={() => { setNotice(''); setModal('create-user') }}><Plus size={18} /> Crear acceso</button></div>
              {usersError && <div className="alert error" role="alert"><span>{usersError}</span></div>}
              <div className="alert"><ShieldCheck size={18} /><span>Las cuentas pueden tener el rol Veterinario o Recepción. Al desactivarlas, su historial permanece.</span></div>
              <div className="table-wrap responsive-table"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Registro</th><th className="actions-column">Acciones</th></tr></thead><tbody>{profiles.map((user) => <tr key={user.id}><td data-label="Usuario"><div className="name-cell"><span className="avatar table-avatar">{initials(user.display_name)}</span><strong>{user.display_name}</strong></div></td><td data-label="Rol">{roleLabels[user.role]}</td><td data-label="Estado"><span className={`status ${user.is_active ? 'active' : 'inactive'}`}>{user.is_active ? 'Activo' : 'Inactivo'}</span></td><td data-label="Registro">{formatDate(user.created_at)}</td><td className="actions-column" data-label="Acciones">{user.role === 'owner' ? <span className="muted">Protegido</span> : user.is_active ? <button className="icon-button danger-icon" onClick={() => { setNotice(''); setUserToDelete(user) }} aria-label={`Desactivar a ${user.display_name}`} title="Desactivar usuario"><Trash2 size={17} /></button> : <span className="muted">Sin acceso</span>}</td></tr>)}</tbody></table></div>
            </section>
          )}
        </div>
      </main>

      {modal === 'pet' && <Modal title="Registrar mascota" onClose={() => setModal(null)}><PetForm onClose={() => setModal(null)} onSaved={async (petId) => { await loadData(); setView('pets'); setSearch(''); setSearchResults(null); setSelectedPetId(petId); setNotice('Mascota, tutor y vacunas registrados.') }} /></Modal>}
      {modal === 'create-user' && <Modal title="Crear acceso" onClose={() => setModal(null)}><CreateUserForm onClose={() => setModal(null)} onCreated={async () => { await loadData(); setNotice('Acceso creado y validado. La persona ya puede iniciar sesión con el correo y la contraseña definidos.') }} /></Modal>}
      {userToDelete && <Modal title="Desactivar usuario" onClose={() => setUserToDelete(null)}><DeleteUserForm user={userToDelete} onClose={() => setUserToDelete(null)} onDeleted={async () => { await loadData(); setNotice('Usuario desactivado. Sus acciones, expedientes y archivos se conservaron.') }} /></Modal>}
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<LocalUser | null>(null)
  const [ready, setReady] = useState(false)
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    void currentLocalUser().then(setUser).catch((cause) => setLocalError(String(cause))).finally(() => setReady(true))
  }, [])

  const connectLocalStorage = useCallback(async () => {
    setLocalError('')
    try {
      setUser(await currentLocalUser())
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No fue posible conectar con el almacenamiento local.')
    }
  }, [])

  const signOut = useCallback(async () => {
    await clearLocalSession()
    setUser(null)
    setLocalError('')
  }, [])

  if (!ready) return <div className="app-loader"><span className="loader" /><p>Preparando acceso seguro…</p></div>
  if (localError) {
    return (
      <div className="app-loader local-error">
        <p className="form-error"><strong>El almacenamiento local no está disponible.</strong><br />{localError}</p>
        <p>Comprueba que abriste la aplicación desde la PC servidor o desde su dirección de red.</p>
        <div className="local-error-actions">
          <button className="button primary" onClick={() => void connectLocalStorage()}>Reintentar</button>
          <button className="button secondary" onClick={() => void signOut()}>Cerrar sesión</button>
        </div>
      </div>
    )
  }
  return user ? <Workspace session={{ user }} onSignOut={signOut} /> : <Login onLogin={setUser} />
}
