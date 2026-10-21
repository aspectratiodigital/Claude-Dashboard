import { useEffect, useRef, useState } from 'react'
import { ArcadeScene, useSlots } from './Scene'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { signals } from '../../data/derive'
import { useApp } from '../../store'
import { usePointer } from '../../shared/bits'
import { LabelLayer } from '../../shared/Labels'
import { Glow, SceneCanvas } from '../../shared/SceneCanvas'
import { useTier } from '../../shared/quality'
import { NoteChip } from '../../shared/pulse'
import { ProjectSheet } from '../../shared/sheet'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import './arcade.css'

/** What the cabinet's screen is saying, in words, with its colour. */
export function machineState(p: Project): { word: string; color: string } {
  const s = signals(p)
  if (s.down) return { word: 'OUT OF ORDER', color: '#a99bc4' }
  if (s.broken) return { word: 'GAME OVER', color: '#ff3d5e' }
  if (s.deploying) return { word: 'LEVEL UP', color: '#3dff8b' }
  if (s.building) return { word: 'LOADING', color: '#ffe53d' }
  if (s.fresh) return { word: 'HIGH SCORE', color: '#3df5ff' }
  if (s.attention) return { word: 'PLAYER NEEDED', color: '#ff9d3d' }
  if (p.status === 'quiet') return { word: 'INSERT COIN', color: '#c18fe0' }
  return { word: 'READY', color: '#ff3df0' }
}

const score = (p: Project) => String(p.commitsWeek * 100).padStart(6, '0')
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'ST' : n % 10 === 2 && n % 100 !== 12 ? 'ND' : n % 10 === 3 && n % 100 !== 13 ? 'RD' : 'TH'}`

export default function Arcade() {
  const tier = useTier()
  const pointer = usePointer()
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const { slots } = useSlots()
  const downAt = useRef({ x: 0, y: 0 })

  // left and right arrows walk along the row of machines
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || useApp.getState().stage) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const list = useData.getState().projects
      if (!list.length) return
      const i = list.findIndex((p) => p.id === useApp.getState().selectedId)
      const d = e.key === 'ArrowRight' ? 1 : -1
      const next = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length
      useApp.getState().select(list[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="ar" data-selected={!!selectedId}>
      <SceneCanvas
        className="ar-canvas"
        flat
        camera={{ fov: 40, position: [0, 8, 26], near: 0.1, far: 220 }}
        effects={(t) => <Glow tier={t} intensity={1.05} threshold={0.5} />}
        onPointerDown={(e) => (downAt.current = { x: e.clientX, y: e.clientY })}
        onPointerMissed={(e) => {
          if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) < 6) useApp.getState().select(null)
        }}
      >
        <ArcadeScene tier={tier} pointer={pointer} />
      </SceneCanvas>

      <LabelLayer>
        {slots.map((s) => (
          <Plate key={s.project.id} id={s.project.id} n={s.index + 1} />
        ))}
      </LabelLayer>

      <header className="ar-head">
        <h1>ARCADE</h1>
        <p>
          ASPECT RATIO DIGITAL · {slots.length} MACHINE{slots.length === 1 ? '' : 'S'}
        </p>
      </header>
      <Scores />
      <Player2 />
      <aside className="ar-sheet" data-open={!!selectedId}>
        {selectedId && <ProjectSheet key={selectedId} id={selectedId} onClose={() => select(null)} labels={{ threads: '2P Claude', activity: 'Replay', issues: 'Bugs' }} />}
      </aside>
    </div>
  )
}

/** The name plate on the floor in front of each machine. */
function Plate({ id, n }: { id: string; n: number }) {
  const p = useProject(id)
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  const dim = useApp((s) => !!s.selectedId && s.selectedId !== id)
  if (!p) return null
  const m = machineState(p)
  const claude = p.threads.some((t) => t.status === 'working')
  return (
    <div id={`lbl-ar-${id}`} className="ar-plate-wrap" data-dim={dim}>
      <NoteChip projectId={id} className="ar-chip" />
      <div className="ar-plate" data-active={active} style={{ '--c': m.color } as React.CSSProperties}>
        <b>
          <small>{String(n).padStart(2, '0')}</small> {p.name}
        </b>
        <span>
          {m.word}
          {claude && <em> · 2P</em>}
        </span>
      </div>
    </div>
  )
}

function Scores() {
  const projects = useData((s) => s.projects)
  const select = useApp((s) => s.select)
  const hover = useApp((s) => s.hover)
  const hoveredId = useApp((s) => s.hoveredId)
  const [view, setView] = useState<'scores' | 'help'>('scores')
  const ranked = [...projects].sort((a, b) => b.commitsWeek - a.commitsWeek)
  const sigs = projects.map(signals)
  const count = (f: (s: ReturnType<typeof signals>) => boolean | number) => sigs.reduce((a, s) => a + Number(f(s)), 0)
  return (
    <section className="ar-card ar-scores">
      <div className="ar-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'scores'} onClick={() => setView('scores')}>
          HI-SCORES
        </button>
        <button role="tab" aria-selected={view === 'help'} onClick={() => setView('help')}>
          HOW TO PLAY
        </button>
      </div>
      {view === 'scores' ? (
        <>
          <ol className="ar-table">
            {ranked.map((p, i) => {
              const m = machineState(p)
              return (
                <li key={p.id}>
                  <button onClick={() => select(p.id)} onPointerEnter={() => hover(p.id)} onPointerLeave={() => hover(null)} data-active={hoveredId === p.id} title={`${p.name}: ${m.word.toLowerCase()}`}>
                    <span className="ar-rank">{ordinal(i + 1)}</span>
                    <b>{p.name}</b>
                    <span className="ar-score">{score(p)}</span>
                    <i style={{ background: m.color }} />
                  </button>
                </li>
              )
            })}
          </ol>
          <dl className="ar-stats">
            <div style={{ '--c': '#ffe53d' } as React.CSSProperties}>
              <dt>LOADING</dt>
              <dd>{count((s) => s.building)}</dd>
            </div>
            <div style={{ '--c': '#3dff8b' } as React.CSSProperties}>
              <dt>LEVEL UP</dt>
              <dd>{count((s) => s.deploying)}</dd>
            </div>
            <div style={{ '--c': '#ff3d5e' } as React.CSSProperties}>
              <dt>GAME OVER</dt>
              <dd>{count((s) => s.broken || s.down)}</dd>
            </div>
            <div style={{ '--c': '#ff9d3d' } as React.CSSProperties}>
              <dt>INVADERS</dt>
              <dd>{count((s) => s.issues)}</dd>
            </div>
            <div style={{ '--c': '#3df5ff' } as React.CSSProperties}>
              <dt>CREDITS</dt>
              <dd>{count((s) => s.prs)}</dd>
            </div>
            <div style={{ '--c': '#d97757' } as React.CSSProperties}>
              <dt>2P CLAUDE</dt>
              <dd>{count((s) => s.claude)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <ul className="ar-help">
          <li>
            <i style={{ background: '#ffe53d' }} /> NOW LOADING and amber lights racing round: a build is running
          </li>
          <li>
            <i style={{ background: '#3dff8b' }} /> LEVEL UP and a green beam: it's deploying
          </li>
          <li>
            <i style={{ background: '#ff3d5e' }} /> GAME OVER and red trim: a build or deploy failed
          </li>
          <li>
            <i style={{ background: '#efe6c8' }} /> OUT OF ORDER sign: the live site isn't answering
          </li>
          <li>
            <i style={{ background: '#ff9d3d' }} /> Space invaders overhead: open issues (red ones are bugs)
          </li>
          <li>
            <i style={{ background: '#ffcf4a' }} /> Coins on the panel and CREDIT on screen: pull requests waiting
          </li>
          <li>
            <i style={{ background: '#d97757' }} /> An orange player 2: Claude is working on it
          </li>
          <li>
            <i style={{ background: 'linear-gradient(135deg,#ff3df0,#3df5ff,#ffe53d)' }} /> Fireworks and NEW HIGH SCORE: it shipped
          </li>
          <li>
            <i style={{ background: '#fff' }} /> A ring on the floor and fast lights: something just happened
          </li>
        </ul>
      )}
    </section>
  )
}

function Player2() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const last = claude.messages.at(-1)
  return (
    <section className="ar-card ar-p2">
      <p aria-live="polite">
        <b>2P CLAUDE</b> {last?.text || 'Ready, player one. Ask me about any machine.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          claude.send(text)
          setText('')
        }}
      >
        <span aria-hidden>&gt;</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="ASK CLAUDE" aria-label="Message Claude" />
        <button disabled={!text.trim()}>SEND</button>
      </form>
      <div className="ar-chips">
        {SUGGESTIONS.slice(0, 3).map((s) => (
          <button key={s} onClick={() => claude.send(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}
