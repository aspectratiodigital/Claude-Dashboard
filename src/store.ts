import { create } from 'zustand'

export type Device = 'desktop' | 'mobile'
export type Source = 'live' | 'preview' | 'local'
export type Quality = 'auto' | 'high' | 'balanced' | 'battery'
export type Theme = 'blueprint' | 'light' | 'dark' | 'mini'
export const THEME_IDS: Theme[] = ['blueprint', 'light', 'dark', 'mini']
export type Font = 'blueprint' | 'jetbrains' | 'grotesk' | 'inter' | 'hud' | 'system'

/** UI fonts for Settings > Appearance: body text and headings (code stays monospace). */
export const FONTS: { id: Font; label: string; note: string; text: string; display: string }[] = [
  { id: 'blueprint', label: 'IBM Plex Mono', note: 'The original, Archivo headings', text: "'IBM Plex Mono', monospace", display: "'Archivo', sans-serif" },
  { id: 'jetbrains', label: 'JetBrains Mono', note: "A coder's monospace", text: "'JetBrains Mono', monospace", display: "'JetBrains Mono', monospace" },
  { id: 'grotesk', label: 'Space Grotesk', note: 'Clean and a little techy', text: "'Space Grotesk', sans-serif", display: "'Space Grotesk', sans-serif" },
  { id: 'inter', label: 'Inter', note: 'Plain and easy to read', text: "'Inter', sans-serif", display: "'Inter', sans-serif" },
  { id: 'hud', label: 'HUD', note: 'Rajdhani, Orbitron headings', text: "'Rajdhani', sans-serif", display: "'Orbitron', sans-serif" },
  { id: 'system', label: 'System', note: 'Segoe UI, like Windows', text: "'Segoe UI', system-ui, sans-serif", display: "'Segoe UI', system-ui, sans-serif" },
]

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
  font: Font
  /** the little cars running on the roads */
  cars: boolean
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
  setFont: (f: Font) => void
  setCars: (on: boolean) => void
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
  theme: load<Theme>('ard.theme', (v) => THEME_IDS.includes(v as Theme), 'blueprint'),
  font: load<Font>('ard.font', (v) => FONTS.some((f) => f.id === v), 'blueprint'),
  cars: load<'on' | 'off'>('ard.cars', (v) => v === 'on' || v === 'off', 'on') === 'on',
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
  setFont: (font) => {
    save('ard.font', font)
    set({ font })
  },
  setCars: (cars) => {
    save('ard.cars', cars ? 'on' : 'off')
    set({ cars })
  },
  openStage: (stage) => set({ stage }),
  closeStage: () => set({ stage: null }),
}))

export const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
