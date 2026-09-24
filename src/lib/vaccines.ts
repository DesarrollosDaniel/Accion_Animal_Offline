export const vaccineOptions = {
  perro: ['Puppy', 'Quintuple', 'Sextuple', 'Rabia', 'Bordetella nasal', 'Bordetella oral'],
  gato: ['Tricat', 'Rabia', 'Leucemia'],
} as const

export function vaccinesForSpecies(species: string | null | undefined): readonly string[] {
  const key = species?.trim().toLocaleLowerCase('es')
  return key === 'perro' || key === 'gato' ? vaccineOptions[key] : []
}
