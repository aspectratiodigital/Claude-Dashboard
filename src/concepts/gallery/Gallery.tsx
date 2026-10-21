import { useCallback, useEffect, useRef, useState } from 'react'
import { GalleryScene } from './Scene'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, relTime, signals } from '../../data/derive'
import { useApp } from '../../store'
import { usePointer } from '../../shared/bits'
import { LabelLayer } from '../../shared/Labels'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { useTier } from '../../shared/quality'
import { NoteChip } from '../../shared/pulse'
import { ProjectSheet } from '../../shared/sheet'
import { useClaude } from '../../shared/useClaude'
import './gallery.css'

export default function Gallery() {
  const tier = useTier()
  const pointer = usePointer()
  const projects = useData((s) => s.projects)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const scroll = useRef(0)
  const target = useRef(0)
  const [focus, setFocus] = useState(0)
  const count = useRef(projects.length)
  count.current = projects.length

  const go = useCallback((i: number) => {
    target.current = Math.max(0, Math.min(count.current - 1, i))
  }, [])

  // stroll: wheel, drag or arrow keys set a target, eased in a light loop
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let idle = 0
    const tick = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, t - last) / 1000)
      last = Math.max(last, t)
      scroll.current += (target.current - scroll.current) * Math.min(1, dt * 4)
      const f = Math.max(0, Math.min(count.current - 1, Math.round(scroll.current)))
      setFocus((p) => (p === f ? p : f))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const snap = () => {
      window.clearTimeout(idle)
      idle = window.setTimeout(() => (target.current = Math.round(target.current)), 160)
    }
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.ga-sheet, .palette, .drawer, .modal, .stage, .ga-curator')) return
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      target.current = Math.max(-0.3, Math.min(count.current - 0.7, target.current + d * 0.0025))
      snap()
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || useApp.getState().stage) return
      if (e.key === 'ArrowRight') go(Math.round(target.current) + 1)
      if (e.key === 'ArrowLeft') go(Math.round(target.current) - 1)
      const p = useData.getState().projects[Math.round(target.current)]
      if (e.key === 'Enter' && p) useApp.getState().select(p.id)
    }
    let dragX: number | null = null
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName === 'CANVAS') dragX = e.clientX
    }
    const move = (e: PointerEvent) => {
      if (dragX === null) return
      target.current -= (e.clientX - dragX) * 0.006
      dragX = e.clientX
    }
    const up = () => {
      if (dragX !== null) target.current = Math.round(Math.max(0, Math.min(count.current - 1, target.current)))
      dragX = null
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(idle)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [go])

  // selecting from elsewhere (palette, notification) walks you over to it
  useEffect(() => {
    const i = useData.getState().projects.findIndex((p) => p.id === selectedId)
    if (i >= 0) go(i)
  }, [selectedId, go])

  const current = projects[focus]

  return (
    <div className="ga" data-selected={!!selectedId}>
      <SceneCanvas className="ga-canvas" flat camera={{ fov: 42, position: [0, 1.75, 9] }} maxDpr={1.75}>
        <GalleryScene scroll={scroll} pointer={pointer} tier={tier} />
      </SceneCanvas>

      <LabelLayer>
        {projects.map((p, i) => (
          <Placard key={p.id} id={p.id} n={i + 1} />
        ))}
      </LabelLayer>

      <header className="ga-head">
        <p>Aspect Ratio Digital</p>
        <h1>
          The <em>Collection</em>
        </h1>
        <span>
          {projects.length} works, each painted from its own commits, pages and pull requests
        </span>
      </header>

      {current && !selectedId && (
        <div className="ga-now" key={current.id}>
          <span>
            {String(focus + 1).padStart(2, '0')} / {String(projects.length).padStart(2, '0')}
          </span>
          <button onClick={() => select(current.id)}>View this work</button>
        </div>
      )}

      <nav className="ga-rail" aria-label="Works">
        {projects.map((p, i) => (
          <button key={p.id} aria-current={i === focus} onClick={() => go(i)} title={p.name} data-status={p.status}>
            <i />
          </button>
        ))}
      </nav>

      <Curator />

      <aside className="ga-sheet" data-open={!!selectedId}>
        {selectedId && <ProjectSheet key={selectedId} id={selectedId} onClose={() => select(null)} labels={{ threads: 'Claude', activity: 'Provenance', issues: 'Condition notes' }} />}
      </aside>
    </div>
  )
}

/** The museum label beside each painting. */
function Placard({ id, n }: { id: string; n: number }) {
  const p = useProject(id)
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  if (!p) return null
  const s = signals(p)
  const note = s.down ? 'Closed: the site is not answering' : s.broken ? 'Closed for restoration' : s.deploying ? 'Being re-hung (deploying)' : s.building ? 'Conservation in progress (building)' : s.claude ? 'Claude is at the easel' : null
  return (
    <div id={`lbl-ga-${id}`} className="ga-placard-wrap">
      <NoteChip projectId={id} className="ga-chip" />
      <div className="ga-placard" data-active={active}>
        <small>No. {n}</small>
        <b>{p.name}</b>
        <span>
          {p.framework}
          {p.host ? ` on ${p.host}` : ''}, {new Date(p.pushedAt).getFullYear()}
        </span>
        <span>
          {p.commitsWeek} commits this week · {STATUS_LABEL[p.status].toLowerCase()} {p.commits[0] ? `· ${relTime(p.commits[0].date)}` : ''}
        </span>
        {note && <em data-status={p.status}>{note}</em>}
      </div>
    </div>
  )
}

function Curator() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const last = claude.messages.at(-1)
  return (
    <section className="ga-curator">
      <p aria-live="polite">
        <b>Curator</b> {last?.text ?? ''}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          claude.send(text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the curator (Claude) about a work" aria-label="Message Claude" />
        <button disabled={!text.trim()}>Ask</button>
      </form>
    </section>
  )
}
