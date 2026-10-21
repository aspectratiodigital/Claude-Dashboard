import { create } from 'zustand'
import type { Note, NoteKind, Project, Setup, Snapshot } from './types'
import { applyDemo, demoNote, demoProjects, startSimulator } from './demo'

// One store for live data. It listens to the local API's event stream; if
// there's no API (or GitHub isn't connected yet) it falls back to demo data
// with a simulator, so every concept always has something real-shaped to draw.

type Mode = 'loading' | 'live' | 'demo'

interface DataState {
  mode: Mode
  /** the local API answered */
  api: boolean
  projects: Project[]
  notes: Note[]
  toasts: Note[]
  setup: Setup | null
  errors: string[]
  rate: Snapshot['rate']
  dismissToast: (id: string) => void
  markRead: (ids?: string[]) => void
  clearNotes: () => void
  test: (projectId: string, kind: NoteKind) => void
  refresh: () => void
  saveSettings: (patch: Record<string, unknown>) => Promise<boolean>
}

type Listener = (n: Note) => void
const listeners = new Set<Listener>()

/** Subscribe to new notifications as they arrive (scenes use this to play effects). */
export function onNote(fn: Listener) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const TOAST_MS: Record<Note['level'], number> = { info: 5000, progress: 6000, success: 6500, warning: 8000, critical: 12000 }

async function post(path: string, body: unknown) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return r.ok
  } catch {
    return false
  }
}

export const useData = create<DataState>((set, get) => ({
  mode: 'loading',
  api: false,
  projects: [],
  notes: [],
  toasts: [],
  setup: null,
  errors: [],
  rate: null,
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markRead: (ids) => {
    set((s) => ({ notes: s.notes.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)) }))
    if (get().mode === 'live') post('/api/notes/read', ids ? { ids } : {})
  },
  clearNotes: () => {
    set({ notes: [] })
    if (get().mode === 'live') post('/api/notes/clear', {})
  },
  test: (projectId, kind) => {
    if (get().mode === 'live') post('/api/notes/test', { projectId, kind })
    else {
      const p = get().projects.find((x) => x.id === projectId)
      if (p) pushDemo(p, kind, true)
    }
  },
  refresh: () => {
    if (get().mode === 'live') post('/api/refresh', {})
  },
  saveSettings: (patch) => post('/api/settings', patch),
}))

function deliver(n: Note) {
  const s = useData.getState()
  if (s.notes.some((x) => x.id === n.id)) return
  useData.setState({ notes: [n, ...s.notes].slice(0, 150), toasts: [n, ...s.toasts].slice(0, 4) })
  window.setTimeout(() => useData.getState().dismissToast(n.id), TOAST_MS[n.level])
  listeners.forEach((fn) => fn(n))
}

function pushDemo(p: Project, kind: NoteKind, test = false) {
  const s = useData.getState()
  useData.setState({ projects: s.projects.map((x) => (x.id === p.id ? applyDemo(x, kind) : x)) })
  deliver(demoNote(p, kind, test))
}

let stopSim: (() => void) | null = null

function enterDemo() {
  if (useData.getState().mode === 'demo') return
  const projects = demoProjects()
  const seeded: Note[] = [
    demoNote(projects[3], 'build-fail'),
    demoNote(projects[1], 'build'),
    demoNote(projects[4], 'issue'),
    demoNote(projects[0], 'deployed'),
  ].map((n, i) => ({ ...n, read: true, at: new Date(Date.now() - (i + 1) * 23 * 60_000).toISOString() }))
  useData.setState({ mode: 'demo', projects, notes: seeded })
  stopSim?.()
  stopSim = startSimulator(
    () => useData.getState().projects,
    (p, kind) => pushDemo(p, kind),
  )
}

function enterLive(snap: Snapshot) {
  stopSim?.()
  stopSim = null
  useData.setState({ mode: 'live', projects: snap.projects, notes: snap.notes, setup: snap.setup, errors: snap.errors, rate: snap.rate })
}

let started = false

export function startData() {
  if (started) return
  started = true
  let opened = false
  const fallback = window.setTimeout(() => {
    if (!opened) enterDemo()
  }, 2500)
  if (typeof EventSource === 'undefined' || location.protocol === 'file:') {
    enterDemo()
    return
  }
  const es = new EventSource('./api/stream')
  es.onopen = () => {
    opened = true
    window.clearTimeout(fallback)
    useData.setState({ api: true })
  }
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse((e as MessageEvent).data) as Snapshot
    useData.setState({ setup: snap.setup, api: true })
    if (snap.mode === 'live' && (snap.projects.length || snap.errors.length)) enterLive(snap)
    else if (snap.mode === 'demo') enterDemo()
    else if (useData.getState().mode === 'loading') useData.setState({ errors: snap.errors })
  })
  es.addEventListener('note', (e) => {
    if (useData.getState().mode !== 'live') return
    deliver(JSON.parse((e as MessageEvent).data) as Note)
  })
  es.onerror = () => {
    if (!opened) {
      window.clearTimeout(fallback)
      enterDemo()
    }
    useData.setState({ api: false })
  }
}

export const useProjects = () => useData((s) => s.projects)
export const useProject = (id: string | null) => useData((s) => (id ? s.projects.find((p) => p.id === id) ?? null : null))
export const getProject = (id: string | null) => (id ? useData.getState().projects.find((p) => p.id === id) ?? null : null)
