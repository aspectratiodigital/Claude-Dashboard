import { lazy, Suspense, useEffect, useState } from 'react'
import { CONCEPTS, useApp, type ConceptId } from './store'
import { CommandPalette } from './shared/CommandPalette'
import { FpsMeter } from './shared/FpsMeter'
import './app.css'

const views: Record<ConceptId, React.LazyExoticComponent<() => React.JSX.Element>> = {
  jarvis: lazy(() => import('./concepts/jarvis/Jarvis')),
  helix: lazy(() => import('./concepts/helix/Helix')),
  orbit: lazy(() => import('./concepts/orbit/Orbit')),
  blueprint: lazy(() => import('./concepts/blueprint/Blueprint')),
}

export default function App() {
  const concept = useApp((s) => s.concept)
  const setConcept = useApp((s) => s.setConcept)
  const setPalette = useApp((s) => s.setPalette)
  const toggleFps = useApp((s) => s.toggleFps)
  const select = useApp((s) => s.select)
  const [shown, setShown] = useState<ConceptId>(concept)
  const [wipe, setWipe] = useState<'idle' | 'cover' | 'reveal'>('idle')

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
    // Preload every concept chunk after first paint.
    const id = window.setTimeout(() => {
      import('./concepts/jarvis/Jarvis')
      import('./concepts/helix/Helix')
      import('./concepts/orbit/Orbit')
      import('./concepts/blueprint/Blueprint')
    }, 1500)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!useApp.getState().paletteOpen)
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const c = CONCEPTS.find((x) => x.key === e.key)
      if (c) setConcept(c.id)
      if (e.key === 'f' || e.key === 'F') toggleFps()
      if (e.key === 'Escape') select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setConcept, setPalette, toggleFps, select])

  const View = views[shown]

  return (
    <div className="app" data-concept={shown}>
      <Suspense fallback={<div className="boot">Loading {CONCEPTS.find((c) => c.id === shown)?.name}</div>}>
        <View />
      </Suspense>

      <nav className="switcher" aria-label="Dashboard concept">
        {CONCEPTS.map((c) => (
          <button
            key={c.id}
            aria-pressed={c.id === concept}
            onClick={() => setConcept(c.id)}
            title={`${c.blurb} (press ${c.key})`}
          >
            <kbd>{c.key}</kbd>
            {c.name}
          </button>
        ))}
        <button className="switcher-k" onClick={() => setPalette(true)} title="Command palette (Ctrl K)">
          <kbd>Ctrl K</kbd>
        </button>
      </nav>

      <div className={`wipe wipe-${wipe}`} data-to={concept} aria-hidden>
        <span>{CONCEPTS.find((c) => c.id === concept)?.name}</span>
      </div>

      <CommandPalette />
      <FpsMeter />
    </div>
  )
}
