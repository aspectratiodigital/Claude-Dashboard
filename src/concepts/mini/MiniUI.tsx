import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Project } from '../../data/types'
import { useData } from '../../data/store'
import { STATUS_LABEL, floorsIn, signals } from '../../data/derive'
import { useApp } from '../../store'
import { useClock } from '../../shared/bits'
import { NoteChip } from '../../shared/pulse'
import { useClaude } from '../../shared/claude'
import { colorOf, type Tool } from './map'
import { useMap, useMini } from './state'
import './mini.css'

// The Mini theme's controls, laid over the map: the city's name and clock, a
// toolbar of map tools like the game's, the key, and a name tag over each
// building.

const I = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)

const ICONS: Record<Tool | 'undo' | 'redo' | 'reset', ReactNode> = {
  look: (
    <I>
      <path d="M5 3l13 7-6 1.6L9.5 18z" />
    </I>
  ),
  move: (
    <I>
      <path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
    </I>
  ),
  road: (
    <I>
      <path d="M4 20c0-7 4-9 8-9s8-2 8-8" strokeWidth="5" opacity=".28" />
      <path d="M4 20c0-7 4-9 8-9s8-2 8-8" strokeDasharray="2.5 3" />
    </I>
  ),
  roundabout: (
    <I>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
    </I>
  ),
  house: (
    <I>
      <path d="M4 11l8-6 8 6M6 9.5V19h12V9.5" />
      <path d="M10 19v-5h4v5" />
    </I>
  ),
  tree: (
    <I>
      <circle cx="12" cy="9.5" r="6" />
      <path d="M12 15.5V21M9.5 21h5" />
    </I>
  ),
  water: (
    <I>
      <path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
    </I>
  ),
  erase: (
    <I>
      <path d="M8.5 19 3.8 14.3a1.6 1.6 0 0 1 0-2.3L12 3.8a1.6 1.6 0 0 1 2.3 0l5.9 5.9a1.6 1.6 0 0 1 0 2.3L13 19.2M8.5 19H20M7.5 10.3l6.2 6.2" />
    </I>
  ),
  undo: (
    <I>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </I>
  ),
  redo: (
    <I>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </I>
  ),
  reset: (
    <I>
      <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6M20 3.5v5.1h-5.1" />
    </I>
  ),
}

export const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'look', label: 'Look', key: 'V', hint: 'Click a building to see its site, click again to open it up. Drag to look around, scroll to zoom.' },
  { id: 'move', label: 'Move', key: 'M', hint: 'Pick up a building or a home and drop it on free ground. Its drive goes with it, and it joins a road it lands next to.' },
  { id: 'road', label: 'Road', key: 'R', hint: 'Drag from tile to tile to lay a road. Across water it becomes a bridge. Right-drag rubs roads out.' },
  { id: 'roundabout', label: 'Roundabout', key: 'O', hint: 'Click a junction to put a roundabout on it, or click one to take it away. Cars go round clockwise.' },
  { id: 'house', label: 'Home', key: 'H', hint: 'Click an empty tile to build a home. Its two cars drive to the site you pick below.' },
  { id: 'tree', label: 'Trees', key: 'T', hint: 'Click or drag to plant trees. Start on a tree to clear them instead.' },
  { id: 'water', label: 'Water', key: 'W', hint: 'Drag to dig a river or a lake. Start on water to fill it back in.' },
  { id: 'erase', label: 'Erase', key: 'X', hint: 'Drag over roads, homes, trees or water to take them away. Right-drag erases with any tool but Look. Buildings for your sites stay.' },
]

/** Everything the Mini theme adds over the map. */
export function MiniHud() {
  useMiniKeys()
  return (
    <>
      <Header />
      <Toolbar />
      <Key />
    </>
  )
}

function useMiniKeys() {
  useEffect(() => {
    const busy = (e: KeyboardEvent) => {
      const a = useApp.getState()
      return !!(e.target as HTMLElement)?.closest?.('input, textarea, select') || !!a.stage || a.settingsOpen || a.paletteOpen || !!useClaude.getState().full || !!document.querySelector('.ap-box')
    }
    const k = (e: KeyboardEvent) => {
      if (busy(e)) return
      const m = useMini.getState()
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
        e.preventDefault()
        if (key === 'y' || e.shiftKey) m.redoStep()
        else m.undoStep()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = TOOLS.find((x) => x.key.toLowerCase() === key)
      if (t) m.setTool(m.tool === t.id ? 'look' : t.id)
    }
    // Escape puts the tool down first (capture, so it runs before the building closes)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy(e) || useApp.getState().notesOpen) return
      const m = useMini.getState()
      if (m.tool === 'look') return
      e.stopImmediatePropagation()
      m.setTool('look')
    }
    window.addEventListener('keydown', k)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('keydown', esc, true)
    }
  }, [])
}

/** ISO week number, as the game counts weeks. */
function weekOf(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)
}

function Header() {
  const now = useClock()
  const projects = useData((s) => s.projects)
  const trips = useMini((s) => s.trips)
  const map = useMap()
  const ids = new Set(projects.map((p) => p.id))
  const homes = map?.homes.filter((h) => ids.has(h.site)).length ?? 0
  const hour = now.getHours() + now.getMinutes() / 60
  return (
    <header className="mm-head">
      <div className="mm-clock" title={now.toLocaleString()}>
        <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
          <circle cx="17" cy="17" r="15" />
          <path d={`M17 17 L${17 + Math.sin((hour / 24) * Math.PI * 2) * 11} ${17 - Math.cos((hour / 24) * Math.PI * 2) * 11}`} />
        </svg>
        <div>
          <b>{now.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</b>
          <span>Week {weekOf(now)}</span>
        </div>
      </div>
      <div className="mm-name">
        <h1>Aspect Ratio Digital</h1>
        <p>
          {projects.length} site{projects.length === 1 ? '' : 's'} · {homes} home{homes === 1 ? '' : 's'}
        </p>
      </div>
      <div className="mm-trips" title="Cars that have reached their building since the app opened">
        <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden>
          <rect x="1" y="2" width="20" height="10" rx="3.5" />
          <rect x="11" y="4" width="6" height="6" rx="1.5" />
        </svg>
        <b>{trips.toLocaleString()}</b>
      </div>
    </header>
  )
}

function Toolbar() {
  const tool = useMini((s) => s.tool)
  const setTool = useMini((s) => s.setTool)
  const canUndo = useMini((s) => s.undo.length > 0)
  const canRedo = useMini((s) => s.redo.length > 0)
  const undo = useMini((s) => s.undoStep)
  const redo = useMini((s) => s.redoStep)
  const reset = useMini((s) => s.reset)
  const projects = useData((s) => s.projects)
  const [sure, setSure] = useState(false)
  useEffect(() => {
    if (!sure) return
    const t = window.setTimeout(() => setSure(false), 3500)
    return () => window.clearTimeout(t)
  }, [sure])
  const hint = TOOLS.find((t) => t.id === tool)?.hint
  // the detail panel is open on the right: keep the top clear for it (new homes go to that site)
  const selected = useApp((s) => !!s.selectedId)
  return (
    <div className="mm-tools-wrap">
      <nav className="mm-tools" aria-label="Map tools">
        {TOOLS.map((t) => (
          <button key={t.id} aria-pressed={tool === t.id} onClick={() => setTool(tool === t.id && t.id !== 'look' ? 'look' : t.id)} title={`${t.label} (${t.key})`}>
            {ICONS[t.id]}
            <span>{t.label}</span>
          </button>
        ))}
        <i className="mm-sep" />
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          {ICONS.undo}
          <span>Undo</span>
        </button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          {ICONS.redo}
          <span>Redo</span>
        </button>
        <button
          data-sure={sure}
          onClick={() => {
            if (!sure) return setSure(true)
            setSure(false)
            reset(projects)
          }}
          title="Lay the city out again from scratch (you can undo it)"
        >
          {ICONS.reset}
          <span>{sure ? 'Sure?' : 'New map'}</span>
        </button>
      </nav>
      {tool !== 'look' && !selected && <p className="mm-hint">{hint}</p>}
      {tool === 'house' && !selected && <Brush projects={projects} />}
    </div>
  )
}

/** Which site a new home is for. */
function Brush({ projects }: { projects: Project[] }) {
  const map = useMap()
  const brush = useMini((s) => s.brush)
  const setBrush = useMini((s) => s.setBrush)
  const on = brush && map?.sites[brush] ? brush : projects.find((p) => map?.sites[p.id])?.id
  // one row that scrolls sideways, so a long list of sites doesn't cover the map; its edges fade where there's more
  const row = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState('')
  const edges = () => {
    const el = row.current
    if (!el) return
    const m = `${el.scrollLeft > 2 ? 'l' : ''}${el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? 'r' : ''}`
    setMore(m)
  }
  useEffect(() => {
    edges()
    window.addEventListener('resize', edges)
    return () => window.removeEventListener('resize', edges)
  }, [projects.length]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={row}
      className="mm-brush"
      role="radiogroup"
      aria-label="New homes are for"
      data-more={more}
      onScroll={edges}
      onWheel={(e) => {
        if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY
      }}
    >
      {projects
        .filter((p) => map?.sites[p.id])
        .map((p) => (
          <button key={p.id} role="radio" aria-checked={on === p.id} onClick={() => setBrush(p.id)} style={{ '--c': colorOf(map!.sites[p.id].color) } as CSSProperties}>
            <i />
            {p.name}
          </button>
        ))}
    </div>
  )
}

function Key() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('ard.mini.key') !== 'closed'
    } catch {
      return true
    }
  })
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem('ard.mini.key', open ? 'closed' : 'open')
    } catch {
      /* ignore */
    }
  }
  return (
    <section className="mm-key" data-open={open}>
      <button className="mm-key-head" onClick={toggle} aria-expanded={open}>
        Key <span>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul>
          <li>
            <i className="mm-k-site" /> A building for each site: bigger when it's busier, one storey a page
          </li>
          <li>
            <i className="mm-k-home" /> Homes in the same colour: their cars drive to it and back
          </li>
          <li>
            <i className="mm-k-pin" /> Pins on the roof: open issues
          </li>
          <li>
            <i className="mm-k-ring" style={{ '--c': 'var(--mm-build)' } as CSSProperties} /> Yellow badge: a build is running
          </li>
          <li>
            <i className="mm-k-ring" style={{ '--c': 'var(--mm-deploy)' } as CSSProperties} /> Green badge: deploying
          </li>
          <li>
            <i className="mm-k-ring" style={{ '--c': 'var(--mm-bad)' } as CSSProperties} /> Red badge: broken or down
          </li>
          <li>
            <i className="mm-k-dot" /> Purple dot round the roof: Claude is working
          </li>
        </ul>
      )}
    </section>
  )
}

/** A name tag over each building. */
export function MiniTags() {
  const projects = useData((s) => s.projects)
  const map = useMap()
  if (!map) return null
  return (
    <>
      {projects.map((p) => (map.sites[p.id] ? <Tag key={p.id} project={p} color={colorOf(map.sites[p.id].color)} /> : null))}
    </>
  )
}

function Tag({ project: p, color }: { project: Project; color: string }) {
  const active = useApp((s) => s.hoveredId === p.id || s.selectedId === p.id)
  const s = signals(p)
  const floors = Math.max(1, Math.min(10, floorsIn(p) || 1))
  return (
    <div id={`lbl-mini-${p.id}`} className="mm-tag-wrap">
      <NoteChip projectId={p.id} className="mm-chip" />
      <div className="mm-tag" data-active={active} data-status={p.status} style={{ '--c': color } as CSSProperties}>
        <b>
          <i />
          {p.name}
        </b>
        <span>
          {STATUS_LABEL[p.status]} · {floors} floor{floors === 1 ? '' : 's'} · {p.commitsWeek} commits
          {s.issues ? ` · ${s.issues} issue${s.issues === 1 ? '' : 's'}` : ''}
        </span>
      </div>
    </div>
  )
}

/** The colour of a site's building, for the detail panel. */
export function useSiteColor(id: string | null): string | undefined {
  const map = useMap()
  const plot = id ? map?.sites[id] : undefined
  return plot ? colorOf(plot.color) : undefined
}
