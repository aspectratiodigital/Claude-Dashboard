import { create } from 'zustand'

export type ConceptId = 'jarvis' | 'helix' | 'orbit' | 'blueprint'

export const CONCEPTS: { id: ConceptId; name: string; blurb: string; key: string }[] = [
  { id: 'jarvis', name: 'Nexus', blurb: 'Holographic HUD around a living Claude core', key: '1' },
  { id: 'helix', name: 'Helix', blurb: 'Glass slabs on a scrolling spiral', key: '2' },
  { id: 'orbit', name: 'Orbit', blurb: 'Every site is a planet around one sun', key: '3' },
  { id: 'blueprint', name: 'Blueprint', blurb: 'Your sites drawn as an isometric city', key: '4' },
]

export type Device = 'desktop' | 'mobile'

interface State {
  concept: ConceptId
  selectedId: string | null
  hoveredId: string | null
  paletteOpen: boolean
  showFps: boolean
  device: Device
  setConcept: (c: ConceptId) => void
  select: (id: string | null) => void
  hover: (id: string | null) => void
  setPalette: (open: boolean) => void
  toggleFps: () => void
  setDevice: (d: Device) => void
}

const saved = (() => {
  try {
    return localStorage.getItem('ard.concept') as ConceptId | null
  } catch {
    return null
  }
})()

export const useApp = create<State>((set) => ({
  concept: saved && CONCEPTS.some((c) => c.id === saved) ? saved : 'jarvis',
  selectedId: null,
  hoveredId: null,
  paletteOpen: false,
  showFps: false,
  device: 'desktop',
  setConcept: (concept) => {
    try {
      localStorage.setItem('ard.concept', concept)
    } catch {
      /* storage unavailable */
    }
    set({ concept, hoveredId: null })
  },
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  toggleFps: () => set((s) => ({ showFps: !s.showFps })),
  setDevice: (device) => set({ device }),
}))

export const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
