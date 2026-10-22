import { create } from 'zustand'

export type Device = 'desktop' | 'mobile'
export type Source = 'live' | 'preview' | 'local'
export type Quality = 'auto' | 'high' | 'balanced' | 'battery'
export type Theme = 'blueprint' | 'light' | 'dark'

export interface StageState {
  projectId: string
  device: Device
  source: Source
  path: string
}

interface State {
  selectedId: string | null
  hoveredId: string | null
  paletteOpen: boolean
  notesOpen: boolean
  settingsOpen: boolean
  showFps: boolean
  quality: Quality
  theme: Theme
  /** fullscreen preview of a site */
  stage: StageState | null
  select: (id: string | null) => void
  hover: (id: string | null) => void
  setPalette: (open: boolean) => void
  setNotes: (open: boolean) => void
  setSettings: (open: boolean) => void
  toggleFps: () => void
  setQuality: (q: Quality) => void
  setTheme: (t: Theme) => void
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
  selectedId: null,
  hoveredId: null,
  paletteOpen: false,
  notesOpen: false,
  settingsOpen: false,
  showFps: false,
  quality: load<Quality>('ard.quality', (v) => ['auto', 'high', 'balanced', 'battery'].includes(v), 'auto'),
  theme: load<Theme>('ard.theme', (v) => ['blueprint', 'light', 'dark'].includes(v), 'blueprint'),
  stage: null,
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
  setTheme: (theme) => {
    save('ard.theme', theme)
    set({ theme })
  },
  openStage: (stage) => set({ stage }),
  closeStage: () => set({ stage: null }),
}))

export const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
