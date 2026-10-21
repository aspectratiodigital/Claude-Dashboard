import { lazy, Suspense, useEffect, useState } from 'react'
import { CONCEPTS, useApp, type ConceptId } from './store'
import { useData } from './data/store'
import { CommandPalette } from './shared/CommandPalette'
import { FpsMeter } from './shared/FpsMeter'
import { NotesDrawer, Toasts, Tray } from './shared/Notifications'
import { Settings } from './shared/Settings'
import { Stage } from './shared/Preview'
import { useTier } from './shared/quality'
import './app.css'
import './shared/shell.css'

const load: Record<ConceptId, () => Promise<{ default: () => React.JSX.Element }>> = {
  nexus: () => import('./concepts/nexus/Nexus'),
  helix: () => import('./concepts/helix/Helix'),
  blueprint: () => import('./concepts/blueprint/Blueprint'),
  township: () => import('./concepts/township/Township'),
  gallery: () => import('./concepts/gallery/Gallery'),
  arcade: () => import('./concepts/arcade/Arcade'),
  reef: () => import('./concepts/reef/Reef'),
}
const views = Object.fromEntries(Object.entries(load).map(([k, f]) => [k, lazy(f)])) as Record<ConceptId, React.LazyExoticComponent<() => React.JSX.Element>>

export default function App() {
  const concept = useApp((s) => s.concept)
  const setConcept = useApp((s) => s.setConcept)
  const setPalette = useApp((s) => s.setPalette)
  const toggleFps = useApp((s) => s.toggleFps)
  const select = useApp((s) => s.select)
  const [shown, setShown] = useState<ConceptId>(concept)
  const [wipe, setWipe] = useState<'idle' | 'cover' | 'reveal'>('idle')
  useTier()

  // Two-step wipe: cover the old concept, swap, then reveal the new one.
  useEffect(() => {
    if (concept === shown) return
    setWipe('cover')
    const t1 = window.setTimeout(() => {
      setShown(concept)
      select(null)
      setWipe('reveal')
    }, 420)
    const t2 = window.setTimeout(() => setWipe('idle'), 1100)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [concept, shown, select])

  useEffect(() => {
    // Warm every concept chunk in the background after first paint.
    const id = window.setTimeout(() => Object.values(load).forEach((f, i) => window.setTimeout(f, i * 400)), 2500)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!useApp.getState().paletteOpen)
        return
      }
      if (e.key === 'Escape') {
        const s = useApp.getState()
        if (s.stage) s.closeStage()
        else if (s.settingsOpen) s.setSettings(false)
        else if (s.notesOpen) s.setNotes(false)
        else s.select(null)
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || useApp.getState().stage) return
      const c = CONCEPTS.find((x) => x.key === e.key)
      if (c) setConcept(c.id)
      if (e.key === 'f' || e.key === 'F') toggleFps()
      if (e.key === 'n' || e.key === 'N') useApp.getState().setNotes(!useApp.getState().notesOpen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setConcept, setPalette, toggleFps])

  const View = views[shown]

  return (
    <div className="app" data-concept={shown}>
      <Suspense fallback={<div className="boot">Loading {CONCEPTS.find((c) => c.id === shown)?.name}</div>}>
        <View />
      </Suspense>

      <nav className="switcher" aria-label="Dashboard concept">
        {CONCEPTS.map((c) => (
          <button key={c.id} aria-pressed={c.id === concept} onClick={() => setConcept(c.id)} title={`${c.name}: ${c.blurb} (press ${c.key})`}>
            <kbd>{c.key}</kbd>
            <span>{c.name}</span>
          </button>
        ))}
        <button className="switcher-k" onClick={() => setPalette(true)} title="Command palette (Ctrl K)">
          <kbd>Ctrl K</kbd>
        </button>
      </nav>

      <Tray />
      <Toasts />
      <Banner />
      <NotesDrawer />

      <div className={`wipe wipe-${wipe}`} data-to={concept} aria-hidden>
        <span>{CONCEPTS.find((c) => c.id === concept)?.name}</span>
      </div>

      <Settings />
      <CommandPalette />
      <Stage />
      <FpsMeter />
    </div>
  )
}

/** Tells you when you're looking at demo data, and how to get your real projects in. */
function Banner() {
  const mode = useData((s) => s.mode)
  const api = useData((s) => s.api)
  const setup = useData((s) => s.setup)
  const setSettings = useApp((s) => s.setSettings)
  if (mode === 'live') return null
  if (mode === 'loading' && setup?.github !== 'none' && api)
    return (
      <div className="banner" data-mode="loading">
        <i /> Loading your projects from GitHub…
      </div>
    )
  if (mode !== 'demo') return null
  return (
    <div className="banner">
      <i />
      {api ? 'Demo data. Connect GitHub to see your real projects' : 'Demo data. Run npm run dev to load your projects'}
      <button onClick={() => setSettings(true)}>{api ? 'Connect' : 'How'}</button>
    </div>
  )
}
