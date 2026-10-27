import { create } from 'zustand'
import type { Project } from '../../data/types'
import { useData } from '../../data/store'
import { buildIndex, generate, isMap, newer, withSites, type Index, type MiniMap, type Tool } from './map'

// The Mini map's state: one map for the demo projects and one for your own
// (so trying things out on the demo never touches yours), the tool in hand,
// and undo. Maps are saved in this browser and through the local API, which
// keeps a copy in the sync folder so the laptop and the PC share one city.

export type World = 'demo' | 'live'

/** A building or home on its way to a new spot. */
export interface Carry {
  kind: 'site' | 'home'
  id: string
  x: number
  z: number
  ok: boolean
}

interface MiniState {
  world: World | null
  maps: Partial<Record<World, MiniMap>>
  /** the saved copies have been read, so a new layout won't replace one you made */
  ready: boolean
  tool: Tool
  /** the site a new home belongs to */
  brush: string | null
  undo: MiniMap[]
  redo: MiniMap[]
  carry: Carry | null
  /** cars that have reached their building since the app opened */
  trips: number
  setTool: (t: Tool) => void
  setBrush: (id: string | null) => void
  setCarry: (c: Carry | null) => void
  /** replace the map: an 'edit' is one step of undo, a 'stroke' joins the drag it's part of, 'auto' is the app's own */
  commit: (next: MiniMap, how?: 'edit' | 'stroke' | 'auto') => void
  beginStroke: () => void
  endStroke: () => void
  undoStep: () => void
  redoStep: () => void
  /** a fresh layout for these projects (you can undo it) */
  reset: (projects: Project[]) => void
  trip: () => void
}

const worldOf = (mode: string): World | null => (mode === 'live' ? 'live' : mode === 'demo' ? 'demo' : null)
const KEY = (w: World) => `ard.mini.${w}`
const UNDO = 60

function readLocal(w: World): MiniMap | undefined {
  try {
    const m = JSON.parse(localStorage.getItem(KEY(w)) ?? 'null')
    return isMap(m) ? m : undefined
  } catch {
    return undefined
  }
}

const timers: Partial<Record<World, number>> = {}
const unsaved: Partial<Record<World, MiniMap>> = {}

function writeNow(w: World) {
  const m = unsaved[w]
  if (!m) return
  delete unsaved[w]
  window.clearTimeout(timers[w])
  try {
    localStorage.setItem(KEY(w), JSON.stringify(m))
  } catch {
    /* storage full or unavailable */
  }
  if (useData.getState().api) fetch('./api/mini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world: w, map: m }) }).catch(() => {})
}

function save(w: World, m: MiniMap) {
  unsaved[w] = m
  window.clearTimeout(timers[w])
  timers[w] = window.setTimeout(() => writeNow(w), 500)
}

let strokeFrom: MiniMap | null = null

export const useMini = create<MiniState>((set, get) => {
  const current = () => {
    const w = get().world
    return w ? get().maps[w] : undefined
  }
  const put = (m: MiniMap) => {
    const w = get().world
    if (!w) return
    set((s) => ({ maps: { ...s.maps, [w]: m } }))
    save(w, m)
  }
  return {
    world: worldOf(useData.getState().mode),
    maps: { demo: readLocal('demo'), live: readLocal('live') },
    ready: false,
    tool: 'look',
    brush: null,
    undo: [],
    redo: [],
    carry: null,
    trips: 0,
    setTool: (tool) => set({ tool, carry: null }),
    setBrush: (brush) => set({ brush }),
    setCarry: (carry) => set({ carry }),
    commit: (next, how = 'edit') => {
      const cur = current()
      if (!cur || next === cur) {
        if (!cur && how === 'auto') put(next)
        return
      }
      if (how === 'edit') set((s) => ({ undo: [...s.undo.slice(-UNDO + 1), cur], redo: [] }))
      put(next)
    },
    beginStroke: () => {
      strokeFrom = current() ?? null
    },
    endStroke: () => {
      const cur = current()
      if (strokeFrom && cur && cur !== strokeFrom) set((s) => ({ undo: [...s.undo.slice(-UNDO + 1), strokeFrom!], redo: [] }))
      strokeFrom = null
    },
    undoStep: () => {
      const { undo } = get()
      const cur = current()
      if (!undo.length || !cur) return
      const prev = undo[undo.length - 1]
      set((s) => ({ undo: s.undo.slice(0, -1), redo: [...s.redo, cur] }))
      put({ ...prev, at: Date.now(), edited: true })
    },
    redoStep: () => {
      const { redo } = get()
      const cur = current()
      if (!redo.length || !cur) return
      const next = redo[redo.length - 1]
      set((s) => ({ redo: s.redo.slice(0, -1), undo: [...s.undo, cur] }))
      put({ ...next, at: Date.now(), edited: true })
    },
    reset: (projects) => {
      if (!projects.length) return
      const m = generate(projects, Math.floor(Math.random() * 1e9))
      get().commit({ ...m, edited: true }, 'edit')
    },
    trip: () => set((s) => ({ trips: s.trips + 1 })),
  }
})

useData.subscribe((s, prev) => {
  if (s.mode === prev.mode) return
  const world = worldOf(s.mode)
  if (world !== useMini.getState().world) useMini.setState({ world, undo: [], redo: [], carry: null })
})

if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => {
    writeNow('demo')
    writeNow('live')
  })

/** The map for the projects on screen now. */
export const useMap = () => useMini((s) => (s.world ? (s.maps[s.world] ?? null) : null))

/** Read the copies the local API keeps (this computer's, and the sync folder's), keeping whichever is newer. */
export async function pullMini() {
  if (!useData.getState().api) {
    useMini.setState({ ready: true })
    return
  }
  try {
    const r = await fetch('./api/mini')
    const remote = r.ok ? ((await r.json()) as Partial<Record<World, unknown>>) : {}
    const s = useMini.getState()
    const maps = { ...s.maps }
    let changed = false
    for (const w of ['demo', 'live'] as World[]) {
      const m = remote[w]
      // never swap the map out from under a drag
      if (w === s.world && (strokeFrom || s.carry)) continue
      if (isMap(m) && newer(m, maps[w])) {
        maps[w] = m
        changed = true
        try {
          localStorage.setItem(KEY(w), JSON.stringify(m))
        } catch {
          /* ignore */
        }
      }
    }
    if (changed) useMini.setState({ maps })
  } catch {
    /* the API is away; the browser's copy will do */
  }
  useMini.setState({ ready: true })
}

/** Lay out a city the first time, and make room for sites that are new since. */
export function settleMap(projects: Project[]) {
  const s = useMini.getState()
  if (!s.ready || !s.world || !projects.length) return
  const cur = s.maps[s.world]
  if (!cur) return s.commit(generate(projects, Math.floor(Math.random() * 1e9)), 'auto')
  const next = withSites(cur, projects)
  if (next !== cur) s.commit(next, 'auto')
}

let cached: { map: MiniMap; key: string; ix: Index } | null = null

/** The lookups for a map, built once per change. */
export function indexFor(map: MiniMap, active: Set<string>): Index {
  const key = [...active].join('\n')
  if (cached && cached.map === map && cached.key === key) return cached.ix
  const ix = buildIndex(map, active)
  cached = { map, key, ix }
  return ix
}
