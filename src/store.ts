import { create } from 'zustand'

export type ConceptId = 'nexus' | 'helix' | 'blueprint' | 'township' | 'gallery' | 'arcade' | 'reef'

export const CONCEPTS: { id: ConceptId; name: string; blurb: string; key: string }[] = [
  { id: 'nexus', name: 'Nexus', blurb: 'Liquid Claude core with your projects in orbit', key: '1' },
  { id: 'helix', name: 'Helix', blurb: 'Glass slabs on a scrolling spiral', key: '2' },
  { id: 'blueprint', name: 'Blueprint', blurb: 'Your sites as an isometric city you can dissect', key: '3' },
  { id: 'township', name: 'Township', blurb: 'A little town where peg people do the work', key: '4' },
  { id: 'gallery', name: 'Gallery', blurb: 'Your sites hung as artworks in a quiet museum', key: '5' },
  { id: 'arcade', name: 'Arcade', blurb: 'A neon arcade: every site is a cabinet', key: '6' },
  { id: 'reef', name: 'Reef', blurb: 'A living reef where each project is a coral colony', key: '7' },
]

export type Device = 'desktop' | 'mobile'
export type Source = 'live' | 'preview' | 'local'
export type Quality = 'auto' | 'high' | 'balanced' | 'battery'

export interface StageState {
  projectId: string
  device: Device
  source: Source
  path: string
}

interface State {
  concept: ConceptId
  selectedId: string | null
  hoveredId: string | null
  paletteOpen: boolean
  notesOpen: boolean
  settingsOpen: boolean
  showFps: boolean
  quality: Quality
  /** fullscreen preview of a site */
  stage: StageState | null
  setConcept: (c: ConceptId) => void
  select: (id: string | null) => void
  hover: (id: string | null) => void
  setPalette: (open: boolean) => void
  setNotes: (open: boolean) => void
  setSettings: (open: boolean) => void
  toggleFps: () => void
  setQuality: (q: Quality) => void
  openStage: (s: StageState) => void
  closeStage: () => void
}

function load<T extends string>(key: string, ok: (v: string) => boolean, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && ok(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* storage unavailable */
  }
}

export const useApp = create<State>((set) => ({
  concept: load<ConceptId>('ard.concept', (v) => CONCEPTS.some((c) => c.id === v), 'nexus'),
  selectedId: null,
  hoveredId: null,
  paletteOpen: false,
  notesOpen: false,
  settingsOpen: false,
  showFps: false,
  quality: load<Quality>('ard.quality', (v) => ['auto', 'high', 'balanced', 'battery'].includes(v), 'auto'),
  stage: null,
  setConcept: (concept) => {
    save('ard.concept', concept)
    set({ concept, hoveredId: null })
  },
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setNotes: (notesOpen) => set({ notesOpen }),
  setSettings: (settingsOpen) => set({ settingsOpen }),
  toggleFps: () => set((s) => ({ showFps: !s.showFps })),
  setQuality: (quality) => {
    save('ard.quality', quality)
    set({ quality })
  },
  openStage: (stage) => set({ stage }),
  closeStage: () => set({ stage: null }),
}))

export const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
