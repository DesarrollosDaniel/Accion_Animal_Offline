import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, ChevronDown, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Info, MoreHorizontal, PawPrint, Pencil, Plus, RotateCcw, ShieldCheck, Stethoscope, Trash2, X } from 'lucide-react'
import { localFileUrl, uploadLocalFile } from '../lib/localFiles'
import { verifyLocalPassword } from '../lib/localAuth'
import { localData, localWrite } from '../lib/localApi'
import { vaccinesForSpecies } from '../lib/vaccines'

type Role = 'owner' | 'veterinarian' | 'reception'

export interface DetailedPet {
  id: string
  row_version: string
  legacy_id: number | null
  name: string
  birth_date: string | null
  color_markings: string | null
  species: string | null
  breed: string | null
  usual_food: string | null
  sex: 'male' | 'female' | 'unknown' | null
  is_sterilized: boolean | null
  sterilization_date: string | null
  photo_path: string | null
  status: 'active' | 'inactive' | 'deceased'
  guardian_name: string
  guardian_phone: string | null
  guardian_address: string | null
  guardian_street: string | null
  guardian_number: string | null
  referral_source: string | null
  created_at: string
}

interface ClinicalFile {
  id: string
  row_version: string
  kind: 'photo' | 'document'
  object_path: string
  original_name: string
  mime_type: string
  size_bytes: number
}

interface ClinicalRecord {
  id: string
  row_version: string
  occurred_at: string
  history: string | null
  physical_exam: string | null
  provisional_diagnosis: string | null
  prognosis: string | null
  treatment: string | null
  estimated_cost: number | null
  budget_notes: string | null
  attending_professional: string | null
  temperature_observation: string | null
  heart_rate_observation: string | null
  respiratory_rate_observation: string | null
  hydration_observation: string | null
  lymph_nodes_observation: string | null
  capillary_refill_observation: string | null
  vomiting: boolean | null
  vomiting_notes: string | null
  diarrhea: boolean | null
  diarrhea_notes: string | null
  legacy_photo_directory: string | null
  legacy_file_directory: string | null
  clinical_files: ClinicalFile[]
}

interface WeightRecord {
  weight_kg: number
  measured_at: string
}

interface Vaccination {
  id: string
  row_version?: string
  vaccine_name: string
  administered_on: string
}

interface PetNote {
  id: string
  row_version: string
  body: string
}

function formatDate(value: string, withTime = false) {
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(value.includes('T') ? value : `${value}T12:00:00`))
}

function localDateTimeValue(value?: string) {
  const date = value ? new Date(value) : new Date()
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function displaySex(value: DetailedPet['sex']) {
  if (value === 'female') return 'Hembra'
  if (value === 'male') return 'Macho'
  return 'Sin especificar'
}

function displayStatus(value: DetailedPet['status']) {
  if (value === 'active') return 'Activo'
  if (value === 'inactive') return 'Inactivo'
  return 'Deceso'
}

function ageLabel(birthDate: string | null) {
  if (!birthDate) return 'Sin fecha registrada'
  const birth = new Date(`${birthDate}T12:00:00`)
  const today = new Date()
  let years = today.getFullYear() - birth.getFullYear()
  let months = today.getMonth() - birth.getMonth()
  if (today.getDate() < birth.getDate()) months -= 1
  if (months < 0) { years -= 1; months += 12 }
  if (years > 0) return `${years} año${years === 1 ? '' : 's'}${months ? `, ${months} mes${months === 1 ? '' : 'es'}` : ''}`
  return `${Math.max(0, months)} mes${months === 1 ? '' : 'es'}`
}

function valueOrDash(value: string | null | undefined) {
  return value?.trim() || '—'
}

function safeFileName(value: string) {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  return normalized.slice(0, 160) || 'archivo'
}

function randomUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>
}

function Observation({ label, value }: { label: string; value: string | null }) {
  if (!value?.trim()) return null
  return <div><span>{label}</span><p>{value}</p></div>
}

function PetEditForm({ pet, latestWeight, vaccinations, note, onSaved, onCancel }: { pet: DetailedPet; latestWeight: WeightRecord | null; vaccinations: Vaccination[]; note: PetNote | null; onSaved: (pet: DetailedPet, refresh?: boolean) => void; onCancel: () => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedVaccinations, setSavedVaccinations] = useState(vaccinations)
  const [savedNote, setSavedNote] = useState(note)
  const [savedWeight, setSavedWeight] = useState(latestWeight?.weight_kg)
  const availableVaccines = [...new Set([...vaccinesForSpecies(pet.species), ...vaccinations.map((entry) => entry.vaccine_name)])]
  const [vaccinationRows, setVaccinationRows] = useState<Vaccination[]>(() => {
    const rows = [...vaccinations]
    if (rows.length < availableVaccines.length) rows.push({ id: randomUuid(), vaccine_name: '', administered_on: localDateTimeValue().slice(0, 10) })
    return rows.length ? rows : [{ id: randomUuid(), vaccine_name: '', administered_on: localDateTimeValue().slice(0, 10) }]
  })

  function changeVaccine(index: number, vaccineName: string) {
    setVaccinationRows((current) => {
      const next = current.map((entry, entryIndex) => entryIndex === index ? { ...entry, vaccine_name: vaccineName } : entry)
      if (vaccineName && index === current.length - 1 && current.length < availableVaccines.length) next.push({ id: randomUuid(), vaccine_name: '', administered_on: localDateTimeValue().slice(0, 10) })
      return next
    })
  }

  function removeVaccine(index: number) {
    setVaccinationRows((current) => {
      const next = current.filter((_, entryIndex) => entryIndex !== index)
      if (next.every((entry) => entry.vaccine_name) && next.length < availableVaccines.length) next.push({ id: randomUuid(), vaccine_name: '', administered_on: localDateTimeValue().slice(0, 10) })
      return next.length ? next : [{ id: randomUuid(), vaccine_name: '', administered_on: localDateTimeValue().slice(0, 10) }]
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const sterilizedValue = String(data.get('is_sterilized') || '')
    const sterilizationDate = String(data.get('sterilization_date') || '')
    const weightValue = String(data.get('weight_kg') || '').trim()
    const observation = String(data.get('observation') || '').trim()
    const selectedVaccinations = vaccinationRows.filter((entry) => entry.vaccine_name)
    if (sterilizationDate && sterilizedValue !== 'true') {
      setError('Para guardar una fecha de esterilización, selecciona “Sí”.')
      setSaving(false)
      return
    }
    if (new Set(selectedVaccinations.map((entry) => entry.vaccine_name)).size !== selectedVaccinations.length) {
      setError('No se puede registrar dos veces el mismo tipo de vacuna.')
      setSaving(false)
      return
    }
    if (note && !observation) {
      setError('La observación existente no puede quedar vacía; escribe el texto que debe mostrarse.')
      setSaving(false)
      return
    }
    const changes = {
      name: String(data.get('name') || '').trim(),
      species: String(data.get('species') || '').trim() || null,
      breed: String(data.get('breed') || '').trim() || null,
      sex: String(data.get('sex') || 'unknown'),
      birth_date: String(data.get('birth_date') || '') || localDateTimeValue().slice(0, 10),
      color_markings: String(data.get('color_markings') || '').trim() || null,
      usual_food: String(data.get('usual_food') || '').trim() || null,
      is_sterilized: sterilizedValue === '' ? null : sterilizedValue === 'true',
      sterilization_date: sterilizationDate || null,
      guardian_name: String(data.get('guardian_name') || '').trim(),
      guardian_phone: String(data.get('guardian_phone') || '').trim() || null,
      guardian_address: String(data.get('guardian_address') || '').trim() || null,
      guardian_street: String(data.get('guardian_street') || '').trim() || null,
      guardian_number: String(data.get('guardian_number') || '').trim() || null,
      referral_source: String(data.get('referral_source') || '').trim() || null,
    }
    let updated: DetailedPet | null = null
    try {
      updated = await localWrite<DetailedPet>(`pets/${pet.id}`, 'PATCH', { expected_version: pet.row_version, changes })
      onSaved(updated, false)
      if (weightValue && Number(weightValue) !== savedWeight) {
        await localWrite(`pets/${pet.id}/weight-records`, 'POST', { weight_kg: Number(weightValue), measured_at: new Date().toISOString(), notes: 'Peso actualizado desde la ficha de la mascota' })
        setSavedWeight(Number(weightValue))
      }
      if (observation !== (savedNote?.body || '')) {
        setSavedNote(await localWrite<PetNote>(savedNote ? `pet-notes/${savedNote.id}` : `pets/${pet.id}/pet-notes`, savedNote ? 'PATCH' : 'POST', savedNote ? { expected_version: savedNote.row_version, changes: { body: observation } } : { body: observation }))
      }
      for (const entry of selectedVaccinations) {
        const original = savedVaccinations.find((item) => item.id === entry.id)
        if (original && entry.vaccine_name === original.vaccine_name && entry.administered_on === original.administered_on) continue
        const fields = { vaccine_name: entry.vaccine_name, administered_on: entry.administered_on }
        const saved = await localWrite<Vaccination>(original ? `vaccinations/${original.id}` : `pets/${pet.id}/vaccinations`, original ? 'PATCH' : 'POST', original ? { expected_version: original.row_version, changes: fields } : fields)
        setSavedVaccinations((current) => [...current.filter((item) => item.id !== entry.id), saved])
        setVaccinationRows((current) => current.map((item) => item.id === entry.id ? saved : item))
      }
      for (const removed of savedVaccinations.filter((item) => !selectedVaccinations.some((entry) => entry.id === item.id))) {
        await localWrite(`vaccinations/${removed.id}`, 'DELETE', { expected_version: removed.row_version })
        setSavedVaccinations((current) => current.filter((item) => item.id !== removed.id))
      }
      onSaved(updated)
      onCancel()
    } catch (cause) {
      setError(`${updated ? 'Los datos de la mascota se guardaron; falta completar los datos relacionados. ' : ''}${cause instanceof Error ? cause.message : 'No fue posible guardar los cambios.'}`)
    } finally {
      setSaving(false)
    }
  }

  return <form className="clinical-form pet-edit-form" onSubmit={submit}>
    <div className="clinical-form-header"><div><p className="eyebrow">Edición</p><h3>Información de la mascota</h3></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Cerrar edición"><X size={19} /></button></div>
    <div className="clinical-form-grid">
      <label>Nombre<input name="name" defaultValue={pet.name} required maxLength={200} /></label>
      <label>Especie<input name="species" defaultValue={pet.species || ''} maxLength={100} /></label>
      <label>Raza<input name="breed" defaultValue={pet.breed || ''} maxLength={120} /></label>
      <label>Sexo<select name="sex" defaultValue={pet.sex || 'unknown'}><option value="unknown">Sin especificar</option><option value="female">Hembra</option><option value="male">Macho</option></select></label>
      <label>Fecha de nacimiento<input name="birth_date" type="date" defaultValue={pet.birth_date || localDateTimeValue().slice(0, 10)} /></label>
      <label>Color y señas<input name="color_markings" defaultValue={pet.color_markings || ''} /></label>
      <label>Alimento habitual<input name="usual_food" defaultValue={pet.usual_food || ''} maxLength={200} /></label>
      <label>Peso actual (kg)<input name="weight_kg" type="number" defaultValue={latestWeight?.weight_kg ?? ''} min="0.001" max="9999.999" step="0.001" /></label>
      <label>Esterilización<select name="is_sterilized" defaultValue={pet.is_sterilized === null ? '' : String(pet.is_sterilized)}><option value="">Sin especificar</option><option value="true">Sí</option><option value="false">No</option></select></label>
      <label>Fecha de esterilización<input name="sterilization_date" type="date" defaultValue={pet.sterilization_date || ''} /></label>
      <label className="span-2">Observaciones de mascota o propietario<textarea name="observation" rows={3} maxLength={2000} defaultValue={note?.body || ''} placeholder="Ej. Cliente de trato difícil o mascota con parvovirus" /></label>
      <div className="form-section-title span-2"><span>Vacunas</span><small>Agrega, cambia o elimina vacunas</small></div>
      {vaccinationRows.map((vaccination, index) => <div className="vaccine-entry span-2" key={vaccination.id}>
        <label>Tipo de vacuna<select value={vaccination.vaccine_name} onChange={(event) => changeVaccine(index, event.target.value)}><option value="">Selecciona una vacuna</option>{availableVaccines.filter((name) => name === vaccination.vaccine_name || !vaccinationRows.some((entry) => entry.vaccine_name === name)).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Fecha de aplicación<input type="date" value={vaccination.administered_on} onChange={(event) => setVaccinationRows((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, administered_on: event.target.value } : entry))} /></label>
        {vaccination.vaccine_name && <button type="button" className="icon-button danger-icon" aria-label={`Eliminar vacuna ${vaccination.vaccine_name}`} title="Eliminar vacuna" onClick={() => removeVaccine(index)}><Trash2 size={17} /></button>}
      </div>)}
      <div className="form-section-title span-2"><span>Responsable</span></div>
      <label>Nombre<input name="guardian_name" defaultValue={pet.guardian_name} required maxLength={200} /></label>
      <label>Teléfono<input name="guardian_phone" type="tel" defaultValue={pet.guardian_phone || ''} maxLength={40} /></label>
      <label>Colonia<input name="guardian_address" defaultValue={pet.guardian_address || ''} maxLength={200} /></label>
      <label>Calle<input name="guardian_street" defaultValue={pet.guardian_street || ''} maxLength={200} /></label>
      <label>Número<input name="guardian_number" defaultValue={pet.guardian_number || ''} maxLength={40} /></label>
      <label className="span-2">Cómo conoció la clínica<input name="referral_source" defaultValue={pet.referral_source || ''} maxLength={200} /></label>
      {error && <p className="form-error span-2" role="alert">{error}</p>}
      <div className="form-actions span-2"><button type="button" className="button secondary" onClick={onCancel} disabled={saving}>Cancelar</button><button type="submit" className="button primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </div>
  </form>
}

function ClinicalRecordCard({ record, canEdit, onEdit, onDelete, onDeleteFile }: { record: ClinicalRecord; canEdit: boolean; onEdit: () => void; onDelete: () => void; onDeleteFile: (file: ClinicalFile) => Promise<boolean> }) {
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null)
  const [files, setFiles] = useState<ClinicalFile[]>([])
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [moreFiles, setMoreFiles] = useState(false)
  async function loadFiles(append = false) {
    if (loadingFiles) return
    setLoadingFiles(true)
    setFilesError('')
    try {
      const page = await localData<ClinicalFile[]>(`clinical-records/${record.id}/files?limit=50&offset=${append ? files.length : 0}`)
      setFiles((current) => append ? [...current, ...page] : page)
      setMoreFiles(page.length === 50)
      setFilesLoaded(true)
    } catch (cause) {
      setFilesError(cause instanceof Error ? cause.message : 'No fue posible cargar los adjuntos.')
    } finally {
      setLoadingFiles(false)
    }
  }
  async function removeFile(file: ClinicalFile) {
    if (await onDeleteFile(file)) {
      setFiles((current) => current.filter((item) => item.id !== file.id))
      setSelectedPhotoIndex(null)
    }
  }
  const observations = [
    ['Temperatura', record.temperature_observation],
    ['Frecuencia cardiaca', record.heart_rate_observation],
    ['Frecuencia respiratoria', record.respiratory_rate_observation],
    ['Hidratación', record.hydration_observation],
    ['Ganglios linfáticos', record.lymph_nodes_observation],
    ['Llenado capilar', record.capillary_refill_observation],
  ] as const
  const photos = files.filter((file) => file.kind === 'photo').flatMap((file) => {
    const url = localFileUrl(file.object_path)
    return url ? [{ ...file, url }] : []
  })
  const documents = files.filter((file) => file.kind === 'document')
  const selectedPhoto = selectedPhotoIndex === null ? null : photos[selectedPhotoIndex]
  const changePhoto = (offset: number) => setSelectedPhotoIndex((current) => current === null ? 0 : (current + offset + photos.length) % photos.length)

  return (
    <details className="clinical-record-card" onToggle={(event) => { if (event.currentTarget.open && !filesLoaded) void loadFiles() }}>
      <summary>
        <span className="record-date"><Stethoscope size={18} /><span><strong>{formatDate(record.occurred_at, true)}</strong><small>{record.attending_professional || 'Profesional no indicado'}</small></span></span>
        <span className="record-summary">{record.provisional_diagnosis || record.history || 'Consulta clínica'}</span>
        <ChevronDown size={18} className="details-chevron" />
      </summary>
      <div className="record-body">
        {filesError && <p className="form-error" role="alert">{filesError}<button type="button" className="text-button" onClick={() => void loadFiles()}>Reintentar adjuntos</button></p>}
        {loadingFiles && <p role="status">Cargando adjuntos…</p>}
        {moreFiles && <button type="button" className="text-button" disabled={loadingFiles} onClick={() => void loadFiles(true)}>Cargar más adjuntos</button>}
        {canEdit && <div className="record-actions"><details className="action-menu"><summary className="icon-button action-menu-trigger" aria-label="Acciones del expediente" title="Acciones"><MoreHorizontal size={19} /></summary><div className="action-menu-popover" role="menu"><button type="button" role="menuitem" onClick={onEdit}><Pencil size={15} /> Editar expediente</button><button type="button" role="menuitem" className="destructive" onClick={onDelete}><Trash2 size={15} /> Eliminar expediente</button></div></details></div>}
        <section className="record-text-grid">
          <Observation label="Historia clínica" value={record.history} />
          <Observation label="Examen físico general" value={record.physical_exam} />
          <Observation label="Diagnóstico provisional" value={record.provisional_diagnosis} />
          <Observation label="Pronóstico" value={record.prognosis} />
          <Observation label="Tratamiento" value={record.treatment} />
          <Observation label="Notas del presupuesto" value={record.budget_notes} />
        </section>
        <section className="observation-grid">
          {observations.map(([label, value]) => <Observation key={label} label={label} value={value} />)}
          <div><span>Vómito</span><p>{record.vomiting ? `Sí${record.vomiting_notes ? ` · ${record.vomiting_notes}` : ''}` : 'No'}</p></div>
          <div><span>Diarrea</span><p>{record.diarrhea ? `Sí${record.diarrhea_notes ? ` · ${record.diarrhea_notes}` : ''}` : 'No'}</p></div>
          {record.estimated_cost !== null && <div><span>Costo estimado</span><p>{new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(record.estimated_cost)}</p></div>}
        </section>
        {(photos.length > 0 || documents.length > 0) && <section className="record-media">
          {photos.length > 0 && <details className="record-files-group">
            <summary><span><ImageIcon size={17} /> Fotos <small>{photos.length}</small></span><ChevronDown size={17} className="media-chevron" /></summary>
            <div className="record-photos">
              {photos.map((photo, index) => <div className="record-file-item" key={photo.id}><button type="button" onClick={() => setSelectedPhotoIndex(index)} aria-label={`Abrir ${photo.original_name} en la galería`}><img src={photo.url} alt={photo.original_name} loading="lazy" /><span><strong>{photo.original_name}</strong><small>{fileSize(photo.size_bytes)}</small></span></button>{canEdit && <button type="button" className="file-delete" onClick={() => void removeFile(photo)} aria-label={`Eliminar ${photo.original_name}`} title="Eliminar foto"><Trash2 size={15} /></button>}</div>)}
            </div>
          </details>}
          {documents.length > 0 && <details className="record-files-group">
            <summary><span><FileText size={17} /> Archivos <small>{documents.length}</small></span><ChevronDown size={17} className="media-chevron" /></summary>
            <div className="record-documents">
              {documents.map((file) => {
                const url = localFileUrl(file.object_path)
                return url && <div className="record-file-item" key={file.id}><a href={url} target="_blank" rel="noreferrer"><FileText size={17} /><span><strong>{file.original_name}</strong><small>{fileSize(file.size_bytes)}</small></span></a>{canEdit && <button type="button" className="file-delete" onClick={() => void removeFile(file)} aria-label={`Eliminar ${file.original_name}`} title="Eliminar archivo"><Trash2 size={15} /></button>}</div>
              })}
            </div>
          </details>}
        </section>}
      </div>
      {selectedPhoto && createPortal(<div className="gallery-backdrop" role="presentation" onMouseDown={() => setSelectedPhotoIndex(null)}>
        <section className="photo-gallery" role="dialog" aria-modal="true" aria-label={`Galería de fotos de ${formatDate(record.occurred_at)}`} onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" className="icon-button gallery-close" onClick={() => setSelectedPhotoIndex(null)} aria-label="Cerrar galería"><X size={22} /></button>
          {photos.length > 1 && <button type="button" className="gallery-arrow previous" onClick={() => changePhoto(-1)} aria-label="Foto anterior"><ChevronLeft size={30} /></button>}
          <img src={selectedPhoto.url} alt={selectedPhoto.original_name} />
          {photos.length > 1 && <button type="button" className="gallery-arrow next" onClick={() => changePhoto(1)} aria-label="Foto siguiente"><ChevronRight size={30} /></button>}
          <p><strong>{selectedPhoto.original_name}</strong><span>{selectedPhotoIndex! + 1} de {photos.length}</span></p>
        </section>
      </div>, document.body)}
    </details>
  )
}

function PasswordDeleteDialog({ title, description, confirmLabel, onClose, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDeleting(true)
    setError('')
    const password = String(new FormData(event.currentTarget).get('password') || '')
    try {
      await verifyLocalPassword(password)
      await onConfirm()
      onClose()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'No fue posible completar la eliminación.')
      setDeleting(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={deleting ? undefined : onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><h2 id="delete-dialog-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} disabled={deleting} aria-label="Cerrar"><X size={20} /></button></header>
        <form className="delete-confirm" onSubmit={submit}>
          <span className="delete-confirm-icon"><Trash2 size={26} /></span>
          <div><h3>Esta acción es permanente</h3><p>{description}</p></div>
          <label className="span-2">Contraseña de tu cuenta<input name="password" type="password" autoComplete="current-password" autoFocus required /></label>
          <p className="form-note span-2"><ShieldCheck size={17} /> Confirma con la contraseña de la cuenta que tiene la sesión abierta.</p>
          {error && <p className="form-error span-2" role="alert">{error}</p>}
          <div className="form-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={deleting}>Cancelar</button><button type="submit" className="button danger" disabled={deleting}>{deleting ? 'Eliminando…' : confirmLabel}</button></div>
        </form>
      </section>
    </div>,
    document.body,
  )
}

function ClinicalRecordForm({ pet, professionalName, record, onSaved, onCancel }: {
  pet: DetailedPet
  professionalName: string
  record?: ClinicalRecord
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedRecord, setSavedRecord] = useState<ClinicalRecord | null>(null)
  const [weightSaved, setWeightSaved] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState(new Map<File, string>())
  const [registeredFiles, setRegisteredFiles] = useState(new Set<File>())
  const [creationUnconfirmed, setCreationUnconfirmed] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const photos = Array.from((form.elements.namedItem('photos') as HTMLInputElement).files || [])
    const documents = Array.from((form.elements.namedItem('documents') as HTMLInputElement).files || [])
    const occurredAt = new Date(String(data.get('occurred_at'))).toISOString()
    const folderStamp = String(Date.now())
    const petFolder = String(pet.legacy_id || pet.id)
    const photoDirectory = photos.length ? `uploaded/clinicos/${petFolder}/fotos/${folderStamp}` : null
    const fileDirectory = documents.length ? `uploaded/clinicos/${petFolder}/archivos/${folderStamp}` : null
    const estimatedCost = String(data.get('estimated_cost') || '').trim()
    const weight = String(data.get('weight_kg') || '').trim()
    const recordValues = {
      occurred_at: occurredAt,
      history: String(data.get('history') || '').trim() || null,
      physical_exam: String(data.get('physical_exam') || '').trim() || null,
      provisional_diagnosis: String(data.get('provisional_diagnosis') || '').trim() || null,
      prognosis: String(data.get('prognosis') || '').trim() || null,
      treatment: String(data.get('treatment') || '').trim() || null,
      estimated_cost: estimatedCost ? Number(estimatedCost) : null,
      budget_notes: String(data.get('budget_notes') || '').trim() || null,
      attending_professional: String(data.get('attending_professional') || '').trim() || null,
      temperature_observation: String(data.get('temperature_observation') || '').trim() || null,
      heart_rate_observation: String(data.get('heart_rate_observation') || '').trim() || null,
      respiratory_rate_observation: String(data.get('respiratory_rate_observation') || '').trim() || null,
      hydration_observation: String(data.get('hydration_observation') || '').trim() || null,
      lymph_nodes_observation: String(data.get('lymph_nodes_observation') || '').trim() || null,
      capillary_refill_observation: String(data.get('capillary_refill_observation') || '').trim() || null,
      vomiting: data.get('vomiting') === 'on',
      vomiting_notes: String(data.get('vomiting_notes') || '').trim() || null,
      diarrhea: data.get('diarrhea') === 'on',
      diarrhea_notes: String(data.get('diarrhea_notes') || '').trim() || null,
    }

    let recordWasSaved = Boolean(savedRecord || record)
    try {
      const currentRecord = savedRecord || record
      const saved = await localWrite<ClinicalRecord>(currentRecord ? `clinical-records/${currentRecord.id}` : `pets/${pet.id}/clinical-records`, currentRecord ? 'PATCH' : 'POST', currentRecord ? { expected_version: currentRecord.row_version, changes: recordValues } : { record: recordValues, weight: weight ? { weight_kg: Number(weight) } : null })
      setSavedRecord(saved)
      recordWasSaved = true
      if (!currentRecord) setWeightSaved(true)
      if (currentRecord && weight && !weightSaved) {
        await localWrite(`pets/${pet.id}/weight-records`, 'POST', { weight_kg: Number(weight), measured_at: occurredAt, notes: `Registrado con el expediente ${saved.id}` })
        setWeightSaved(true)
      }
      const pendingFiles = [
        ...photos.map((file, index) => ({ file, kind: 'photo' as const, directory: photoDirectory!, index })),
        ...documents.map((file, index) => ({ file, kind: 'document' as const, directory: fileDirectory!, index })),
      ]
      for (const item of pendingFiles) {
        if (registeredFiles.has(item.file)) continue
        let storedPath = uploadedFiles.get(item.file)
        if (!storedPath) {
          storedPath = await uploadLocalFile(`${item.directory}/${randomUuid()}-${safeFileName(item.file.name)}`, item.file)
          setUploadedFiles((current) => new Map(current).set(item.file, storedPath!))
        }
        await localWrite(`clinical-records/${saved.id}/files`, 'POST', {
          kind: item.kind, object_path: storedPath, original_name: item.file.name,
          mime_type: item.file.type || 'application/octet-stream', size_bytes: item.file.size,
        })
        setRegisteredFiles((current) => new Set(current).add(item.file))
      }
      await onSaved()
      onCancel()
    } catch (caught) {
      // Keep saved records and physical uploads on failure: a lost response must not erase clinical data.
      setCreationUnconfirmed(!recordWasSaved)
      setError(`${recordWasSaved ? 'El expediente está guardado; puedes reintentar los adjuntos pendientes. ' : 'No se pudo confirmar el alta. Cierra el formulario y revisa el historial antes de crear otro expediente. '}${caught instanceof Error ? caught.message : 'No fue posible guardar el expediente.'}`)
      await onSaved()
      setSaving(false)
    }
  }

  return (
    <form className="clinical-form" onSubmit={submit}>
      <div className="clinical-form-header"><div><p className="eyebrow">{record ? 'Edición' : 'Nuevo registro'}</p><h3>Expediente médico</h3></div><button type="button" className="icon-button" onClick={onCancel} disabled={saving} aria-label="Cerrar formulario"><X size={19} /></button></div>
      <div className="clinical-form-grid">
        <label>Fecha y hora<input name="occurred_at" type="datetime-local" defaultValue={localDateTimeValue(record?.occurred_at)} required /></label>
        <label>Profesional responsable<input name="attending_professional" defaultValue={record?.attending_professional || professionalName} maxLength={200} /></label>
        <label>Peso (kg)<input name="weight_kg" type="number" min="0.001" max="9999.999" step="0.001" placeholder="Ej. 12.500" /></label>
        <label>Temperatura<input name="temperature_observation" defaultValue={record?.temperature_observation || ''} maxLength={100} placeholder="Ej. 38.5 °C" /></label>
        <label className="span-2">Historia clínica<textarea name="history" defaultValue={record?.history || ''} rows={4} placeholder="Motivo de consulta, antecedentes y evolución" /></label>
        <label className="span-2">Examen físico general<textarea name="physical_exam" defaultValue={record?.physical_exam || ''} rows={4} /></label>
        <label className="span-2">Diagnóstico provisional<textarea name="provisional_diagnosis" defaultValue={record?.provisional_diagnosis || ''} rows={3} /></label>
        <label className="span-2">Pronóstico<textarea name="prognosis" defaultValue={record?.prognosis || ''} rows={2} /></label>
        <label className="span-2">Tratamiento<textarea name="treatment" defaultValue={record?.treatment || ''} rows={4} /></label>
        <div className="form-section-title span-2"><span>Signos y observaciones</span></div>
        <label>Frecuencia cardiaca<input name="heart_rate_observation" defaultValue={record?.heart_rate_observation || ''} maxLength={100} /></label>
        <label>Frecuencia respiratoria<input name="respiratory_rate_observation" defaultValue={record?.respiratory_rate_observation || ''} maxLength={100} /></label>
        <label>Hidratación<input name="hydration_observation" defaultValue={record?.hydration_observation || ''} maxLength={100} /></label>
        <label>Ganglios linfáticos<input name="lymph_nodes_observation" defaultValue={record?.lymph_nodes_observation || ''} maxLength={100} /></label>
        <label>Tiempo de llenado capilar<input name="capillary_refill_observation" defaultValue={record?.capillary_refill_observation || ''} maxLength={100} /></label>
        <div className="symptom-field"><label className="checkbox-label"><input name="vomiting" type="checkbox" defaultChecked={record?.vomiting || false} /> Vómito</label><input name="vomiting_notes" defaultValue={record?.vomiting_notes || ''} placeholder="Observaciones" /></div>
        <div className="symptom-field"><label className="checkbox-label"><input name="diarrhea" type="checkbox" defaultChecked={record?.diarrhea || false} /> Diarrea</label><input name="diarrhea_notes" defaultValue={record?.diarrhea_notes || ''} placeholder="Observaciones" /></div>
        <div className="form-section-title span-2"><span>Presupuesto</span></div>
        <label>Costo estimado (MXN)<input name="estimated_cost" type="number" defaultValue={record?.estimated_cost ?? ''} min="0" step="0.01" /></label>
        <label>Notas del presupuesto<input name="budget_notes" defaultValue={record?.budget_notes || ''} maxLength={500} placeholder="Conceptos, anticipo o condiciones" /></label>
        <div className="form-section-title span-2"><span>Fotos y documentos locales</span></div>
        <label>Fotografías<input name="photos" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" multiple /></label>
        <label>Documentos<input name="documents" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.pptx,video/mp4" multiple /></label>
        <p className="form-note span-2"><FileText size={17} /> {record ? 'Los archivos seleccionados se agregarán al expediente; los actuales se conservan hasta que los elimines.' : 'Adjuntos privados de esta consulta. Máximo 50 MB por archivo.'}</p>
        {error && <p className="form-error span-2" role="alert">{error}</p>}
        <div className="form-actions span-2"><button type="button" className="button secondary" onClick={onCancel} disabled={saving}>Cancelar</button><button type="submit" className="button primary" disabled={saving || creationUnconfirmed}>{saving ? 'Guardando expediente…' : record ? 'Guardar cambios' : 'Guardar expediente'}</button></div>
      </div>
    </form>
  )
}

export function PetDetails({ pet, role, professionalName, onPetChanged, onPetDeleted, onRecordsChanged }: {
  pet: DetailedPet
  role: Role
  professionalName: string
  onPetChanged: (pet: DetailedPet, movedList?: boolean) => void
  onPetDeleted: () => void
  onRecordsChanged: () => void
}) {
  const [records, setRecords] = useState<ClinicalRecord[]>([])
  const [latestWeight, setLatestWeight] = useState<WeightRecord | null>(null)
  const [vaccinations, setVaccinations] = useState<Vaccination[]>([])
  const [note, setNote] = useState<PetNote | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingPet, setEditingPet] = useState(false)
  const [editingRecord, setEditingRecord] = useState<ClinicalRecord | null>(null)
  const [changingStatus, setChangingStatus] = useState(false)
  const [changingPhoto, setChangingPhoto] = useState(false)
  const [photoFailed, setPhotoFailed] = useState(false)
  const [photoExpanded, setPhotoExpanded] = useState(false)
  const [photoMessage, setPhotoMessage] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'pet' } | { kind: 'record'; record: ClinicalRecord } | null>(null)
  const canEdit = role === 'owner' || role === 'veterinarian'
  const photoUrl = useMemo(() => localFileUrl(pet.photo_path), [pet.photo_path])

  useEffect(() => setPhotoFailed(false), [photoUrl])

  useEffect(() => {
    if (!photoExpanded) return
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setPhotoExpanded(false)
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [photoExpanded])

  async function changePhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!['.bmp', '.gif', '.jfif', '.jpeg', '.jpg', '.png', '.webp'].includes(extension)) {
      setPhotoMessage('Selecciona una imagen JPG, PNG, WEBP, GIF, BMP o JFIF.')
      input.value = ''
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      setPhotoMessage('La imagen supera el límite de 50 MB.')
      input.value = ''
      return
    }

    const folder = String(pet.legacy_id || pet.id)
    const target = `uploaded/mascotas/${folder}/${Date.now()}-${safeFileName(file.name)}`
    setChangingPhoto(true)
    setPhotoMessage('')
    let storedPath = ''
    try {
      storedPath = await uploadLocalFile(target, file)
      const updated = await localWrite<DetailedPet>(`pets/${pet.id}`, 'PATCH', { expected_version: pet.row_version, changes: { photo_path: storedPath } })
      onPetChanged(updated)
      setPhotoMessage('Foto actualizada. La anterior se conserva hasta confirmar la sincronización.')
    } catch (changeError) {
      // Preserve an upload when its database response may have been lost.
      setPhotoMessage(changeError instanceof Error ? changeError.message : 'No fue posible cambiar la foto.')
    } finally {
      setChangingPhoto(false)
      input.value = ''
    }
  }

  const [hasMore, setHasMore] = useState(false)
  const loadRecords = useCallback(async (append = false) => {
    setLoading(true)
    setError('')
    try {
      const prefix = `pets/${pet.id}`
      const page = await localData<ClinicalRecord[]>(`${prefix}/clinical-records?limit=25&offset=${append ? records.length : 0}`)
      if (!append) {
        const [weights, vaccines, notes] = await Promise.all([
          localData<WeightRecord[]>(`${prefix}/weight-records?limit=1`),
          localData<Vaccination[]>(`${prefix}/vaccinations?limit=200`),
          localData<PetNote[]>(`${prefix}/pet-notes?limit=1`),
        ])
        setLatestWeight(weights[0] || null)
        setVaccinations(vaccines)
        setNote(notes[0] || null)
      }
      setRecords((current) => append ? [...current, ...page] : page)
      setHasMore(page.length === 25)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible cargar la ficha.')
    } finally {
      setLoading(false)
    }
  }, [pet.id, records.length])
  useEffect(() => { void loadRecords() }, [pet.id])

  async function changeStatus() {
    const nextStatus: DetailedPet['status'] = pet.status === 'active' ? 'deceased' : 'active'
    const question = nextStatus === 'deceased'
      ? `¿Enviar a ${pet.name} a decesos?`
      : `¿Reactivar a ${pet.name} y devolverla a la búsqueda normal?`
    if (!window.confirm(question)) return
    setChangingStatus(true)
    setError('')
    try {
      const updated = await localWrite<DetailedPet>(`pets/${pet.id}`, 'PATCH', { expected_version: pet.row_version, changes: { status: nextStatus } })
      onPetChanged(updated, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible cambiar el estado.')
    }
    setChangingStatus(false)
  }

  async function deleteClinicalFile(file: ClinicalFile) {
    if (!window.confirm(`¿Eliminar ${file.original_name} de este expediente? El archivo físico se conserva para sincronización.`)) return false
    setError('')
    try {
      await localWrite(`clinical-files/${file.id}`, 'DELETE', { expected_version: file.row_version })
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible eliminar el adjunto.')
      return false
    }
  }

  async function deleteRecord(record: ClinicalRecord) {
    await localWrite(`clinical-records/${record.id}`, 'DELETE', { expected_version: record.row_version })
    setEditingRecord(null)
    await loadRecords()
    onRecordsChanged()
  }

  async function deletePet() {
    await localWrite(`pets/${pet.id}`, 'DELETE', { expected_version: pet.row_version })
    onPetDeleted()
  }

  async function recordsSaved() {
    await loadRecords()
    onRecordsChanged()
  }
  return (
    <div className="pet-details">
      {editingPet ? <PetEditForm pet={pet} latestWeight={latestWeight} vaccinations={vaccinations} note={note} onSaved={(updatedPet, refresh = true) => { onPetChanged(updatedPet); if (refresh) void loadRecords() }} onCancel={() => setEditingPet(false)} /> : <section className="pet-profile-card">
        <div className="pet-photo-control">
          {photoUrl && !photoFailed ? <button type="button" className="pet-photo-large" onClick={() => setPhotoExpanded(true)} aria-label={`Ampliar fotografía de ${pet.name}`} title="Ampliar fotografía"><img src={photoUrl} alt={`Fotografía de ${pet.name}`} onError={() => setPhotoFailed(true)} /></button> : <div className="pet-photo-large"><PawPrint size={42} /></div>}
          {canEdit && <label className="photo-change-button"><Camera size={15} /> {changingPhoto ? 'Cambiando…' : 'Cambiar foto'}<input type="file" accept=".bmp,.gif,.jfif,.jpeg,.jpg,.png,.webp,image/*" disabled={changingPhoto} onChange={(event) => void changePhoto(event)} /></label>}
          {photoMessage && <span className="photo-message" role="status">{photoMessage}</span>}
        </div>
        <div className="pet-profile-heading"><p className="eyebrow">Ficha completa</p><h3>{pet.name}</h3><span className={`status ${pet.status}`}>{displayStatus(pet.status)}</span>{canEdit && <div className="pet-profile-actions"><details className="action-menu"><summary className="icon-button action-menu-trigger" aria-label={`Acciones de ${pet.name}`} title="Acciones"><MoreHorizontal size={20} /></summary><div className="action-menu-popover" role="menu"><button type="button" role="menuitem" onClick={() => setEditingPet(true)}><Pencil size={15} /> Editar información</button><button type="button" role="menuitem" className={pet.status === 'active' ? 'warning' : ''} disabled={changingStatus} onClick={() => void changeStatus()}>{pet.status === 'active' ? <><span aria-hidden="true">🌈</span> Mandar a decesos</> : <><RotateCcw size={15} /> Reactivar mascota</>}</button><button type="button" role="menuitem" className="destructive" onClick={() => setDeleteTarget({ kind: 'pet' })}><Trash2 size={15} /> Eliminar mascota</button></div></details></div>}</div>
        {note && <div className="pet-alert-note"><Info size={22} /><div><strong>Información clave sobre la mascota o tutor</strong><p>{note.body}</p></div></div>}
        <div className="detail-grid">
          <DetailItem label="Especie" value={valueOrDash(pet.species)} />
          <DetailItem label="Raza" value={valueOrDash(pet.breed)} />
          <DetailItem label="Sexo" value={displaySex(pet.sex)} />
          <DetailItem label="Nacimiento" value={pet.birth_date ? formatDate(pet.birth_date) : '—'} />
          <DetailItem label="Edad" value={ageLabel(pet.birth_date)} />
          <DetailItem label="Peso actual" value={latestWeight ? `${latestWeight.weight_kg} kg · ${formatDate(latestWeight.measured_at)}` : '—'} />
          <DetailItem label="Color y señas" value={valueOrDash(pet.color_markings)} />
          <DetailItem label="Alimento habitual" value={valueOrDash(pet.usual_food)} />
          <DetailItem label="Esterilización" value={pet.is_sterilized === null ? '—' : pet.is_sterilized ? `Sí${pet.sterilization_date ? ` · ${formatDate(pet.sterilization_date)}` : ''}` : 'No'} />
          <DetailItem label="ID histórico" value={pet.legacy_id ? String(pet.legacy_id) : 'Nuevo registro'} />
        </div>
        <div className="guardian-card"><h4>Responsable</h4><div className="detail-grid"><DetailItem label="Nombre" value={pet.guardian_name} /><DetailItem label="Teléfono" value={valueOrDash(pet.guardian_phone)} /><DetailItem label="Colonia" value={valueOrDash(pet.guardian_address)} /><DetailItem label="Calle" value={valueOrDash(pet.guardian_street)} /><DetailItem label="Número" value={valueOrDash(pet.guardian_number)} /><DetailItem label="Cómo conoció la clínica" value={valueOrDash(pet.referral_source)} /></div></div>
        <div className="vaccination-card"><h4>Vacunas</h4>{loading ? <span className="muted">Cargando vacunas…</span> : vaccinations.length === 0 ? <span className="muted">Sin vacunas registradas.</span> : <table className="vaccination-table"><thead><tr><th>Fecha</th><th>Tipo de vacuna</th></tr></thead><tbody>{vaccinations.map((vaccination) => <tr key={vaccination.id}><td>{formatDate(vaccination.administered_on)}</td><td>{vaccination.vaccine_name}</td></tr>)}</tbody></table>}</div>
      </section>}

      <section className="clinical-section">
        <div className="clinical-section-header"><div><p className="eyebrow">Historial</p><h3>Expedientes médicos</h3></div>{canEdit && !showForm && !editingRecord && <button className="button primary" onClick={() => setShowForm(true)}><Plus size={17} /> Nuevo expediente</button>}</div>
        {!canEdit && <p className="form-note"><Stethoscope size={17} /> Recepción puede consultar el historial; solo Dueño y Veterinaria pueden modificarlo.</p>}
        {showForm && <ClinicalRecordForm pet={pet} professionalName={professionalName} onSaved={recordsSaved} onCancel={() => setShowForm(false)} />}
        {editingRecord && <ClinicalRecordForm pet={pet} professionalName={professionalName} record={editingRecord} onSaved={recordsSaved} onCancel={() => setEditingRecord(null)} />}
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && records.length === 0 ? <div className="inline-loader"><span className="loader" /> Cargando historial…</div> : records.length === 0 ? <div className="clinical-empty"><Stethoscope size={25} /><strong>Sin expedientes médicos</strong><span>Registra la primera consulta de esta mascota.</span></div> : <div className="clinical-records">{records.map((record) => <ClinicalRecordCard key={`${record.id}:${record.row_version}`} record={record} canEdit={canEdit} onEdit={() => { setShowForm(false); setEditingRecord(record) }} onDelete={() => setDeleteTarget({ kind: 'record', record })} onDeleteFile={deleteClinicalFile} />)}</div>}
      </section>
      {hasMore && <button className="button secondary" disabled={loading} onClick={() => void loadRecords(true)}>{loading ? 'Cargando…' : 'Cargar más expedientes'}</button>}
      {deleteTarget && <PasswordDeleteDialog
        title={deleteTarget.kind === 'pet' ? `Eliminar a ${pet.name}` : 'Eliminar expediente médico'}
        description={deleteTarget.kind === 'pet' ? `Se eliminarán ${pet.name}, sus expedientes y los enlaces a sus archivos. Los archivos físicos se conservarán hasta confirmar la sincronización.` : `Se eliminará el expediente del ${formatDate(deleteTarget.record.occurred_at, true)} y los enlaces a sus archivos. Los archivos físicos se conservarán hasta confirmar la sincronización.`}
        confirmLabel={deleteTarget.kind === 'pet' ? 'Eliminar mascota' : 'Eliminar expediente'}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget.kind === 'pet' ? deletePet() : deleteRecord(deleteTarget.record)}
      />}
      {photoExpanded && photoUrl && createPortal(<div className="gallery-backdrop" role="presentation" onMouseDown={() => setPhotoExpanded(false)}>
        <section className="photo-gallery" role="dialog" aria-modal="true" aria-label={`Fotografía ampliada de ${pet.name}`} onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" className="icon-button gallery-close" onClick={() => setPhotoExpanded(false)} aria-label="Cerrar fotografía ampliada"><X size={22} /></button>
          <img src={photoUrl} alt={`Fotografía ampliada de ${pet.name}`} />
          <p><strong>{pet.name}</strong></p>
        </section>
      </div>, document.body)}
    </div>
  )
}
