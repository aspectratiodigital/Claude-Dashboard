import { useRef, useState } from 'react'
import { ReefScene, useSites, CLAUDE } from './Scene'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { signals } from '../../data/derive'
import { useApp } from '../../store'
import { LabelLayer } from '../../shared/Labels'
import { Glow, SceneCanvas } from '../../shared/SceneCanvas'
import { useTier } from '../../shared/quality'
import { NoteChip } from '../../shared/pulse'
import { ProjectSheet } from '../../shared/sheet'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import './reef.css'

type Tone = 'info' | 'progress' | 'success' | 'warning' | 'critical' | 'muted'

/** How the colony is doing, in reef words. */
export function reefState(p: Project): { word: string; tone: Tone } {
  const s = signals(p)
  if (s.down) return { word: 'Silted up: site down', tone: 'critical' }
  if (s.broken) return { word: 'Bleached: build failing', tone: 'critical' }
  if (s.deploying) return { word: 'Spawning: deploying', tone: 'success' }
  if (s.building) return { word: 'Bubbling: building', tone: 'progress' }
  if (s.fresh) return { word: 'Glowing: just shipped', tone: 'success' }
  if (s.attention) return { word: 'Needs a look', tone: 'warning' }
  if (p.status === 'quiet') return { word: 'Resting', tone: 'muted' }
  return { word: 'Thriving', tone: 'info' }
}

export default function Reef() {
  const tier = useTier()
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const { sites } = useSites()
  const downAt = useRef({ x: 0, y: 0 })
  return (
    <div className="rf" data-selected={!!selectedId}>
      <SceneCanvas
        className="rf-canvas"
        flat
        camera={{ fov: 38, position: [0, 14, 40], near: 0.1, far: 200 }}
        effects={(t) => <Glow tier={t} intensity={0.85} threshold={0.62} />}
        onPointerDown={(e) => (downAt.current = { x: e.clientX, y: e.clientY })}
        onPointerMissed={(e) => {
          if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) < 6) useApp.getState().select(null)
        }}
      >
        <ReefScene tier={tier} />
      </SceneCanvas>

      <LabelLayer>
        {sites.map((s) => (
          <Tag key={s.project.id} id={s.project.id} />
        ))}
      </LabelLayer>

      <header className="rf-head">
        <h1>Reef</h1>
        <p>
          Aspect Ratio Digital · {sites.length} {sites.length === 1 ? 'colony' : 'colonies'}
        </p>
      </header>
      <Health />
      <Guide />
      <Sonar />
      <aside className="rf-sheet" data-open={!!selectedId}>
        {selectedId && <ProjectSheet key={selectedId} id={selectedId} onClose={() => select(null)} labels={{ threads: 'Claude', activity: 'Log', issues: 'Visitors' }} />}
      </aside>
    </div>
  )
}

function Tag({ id }: { id: string }) {
  const p = useProject(id)
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  const dim = useApp((s) => !!s.selectedId && s.selectedId !== id)
  if (!p) return null
  const st = reefState(p)
  const claude = p.threads.some((t) => t.status === 'working')
  return (
    <div id={`lbl-rf-${id}`} className="rf-tag-wrap" data-dim={dim}>
      <NoteChip projectId={id} className="rf-chip" />
      <div className="rf-tag" data-active={active} data-tone={st.tone}>
        <b>
          <i style={{ background: p.accent }} />
          {p.name}
        </b>
        <span>
          {st.word}
          {claude && <em> · Claude's sub</em>}
        </span>
      </div>
    </div>
  )
}

function Health() {
  const projects = useData((s) => s.projects)
  const sigs = projects.map(signals)
  const count = (f: (s: ReturnType<typeof signals>) => boolean | number) => sigs.reduce((a, s) => a + Number(f(s)), 0)
  const thriving = projects.filter((p, i) => !sigs[i].broken && !sigs[i].down && p.status !== 'quiet').length
  const rows: { label: string; value: number; tone: Tone }[] = [
    { label: 'Thriving', value: thriving, tone: 'info' },
    { label: 'Bubbling', value: count((s) => s.building), tone: 'progress' },
    { label: 'Spawning', value: count((s) => s.deploying), tone: 'success' },
    { label: 'Bleached', value: count((s) => s.broken || s.down), tone: 'critical' },
    { label: 'Visitors', value: count((s) => s.issues), tone: 'warning' },
    { label: 'Pearls', value: count((s) => s.prs), tone: 'muted' },
  ]
  return (
    <section className="rf-card rf-health">
      <h2>Reef health</h2>
      <dl>
        {rows.map((r) => (
          <div key={r.label} data-tone={r.tone}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="rf-sub">
        <i style={{ background: CLAUDE }} /> Claude is diving on {count((s) => s.claude)} {count((s) => s.claude) === 1 ? 'colony' : 'colonies'}
      </p>
    </section>
  )
}

function Guide() {
  const [open, setOpen] = useState(false)
  return (
    <section className="rf-card rf-guide" data-open={open}>
      <button className="rf-guide-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2>Field guide</h2>
        <span>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul>
          <li>
            <i style={{ background: '#c8f6ff' }} /> Bubbles rising: a build is running
          </li>
          <li>
            <i style={{ background: '#d8fff0' }} /> A school of fish spiralling up: it's deploying
          </li>
          <li>
            <i style={{ background: '#7dffe8' }} /> A glowing jellyfish and a plankton bloom: it just shipped
          </li>
          <li>
            <i style={{ background: '#e8e4d8' }} /> Bleached white coral: a build or deploy failed
          </li>
          <li>
            <i style={{ background: '#1d2a2c' }} /> Dark silt: the live site isn't answering
          </li>
          <li>
            <i style={{ background: '#e2553f' }} /> Crabs (and spiky urchins for bugs): open issues
          </li>
          <li>
            <i style={{ background: '#fff4fb' }} /> Clams with pearls: pull requests waiting
          </li>
          <li>
            <i style={{ background: CLAUDE }} /> The orange submarine: Claude is working on it
          </li>
          <li>
            <i style={{ background: 'transparent', boxShadow: 'inset 0 0 0 2px #5fffe0' }} /> A sonar ring: something just happened
          </li>
        </ul>
      )}
    </section>
  )
}

function Sonar() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const last = claude.messages.at(-1)
  return (
    <section className="rf-card rf-sonar">
      <p aria-live="polite">
        <b>Claude</b> {last?.text || 'Down here with you. Ask me how any colony is doing.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          claude.send(text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Claude about the reef" aria-label="Message Claude" />
        <button disabled={!text.trim()}>Send</button>
      </form>
      <div className="rf-chips">
        {SUGGESTIONS.slice(0, 3).map((s) => (
          <button key={s} onClick={() => claude.send(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}
