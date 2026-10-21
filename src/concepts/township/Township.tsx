import { useEffect, useRef, useState } from 'react'
import { TownshipScene, usePlots } from './Scene'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, domainOf, signals } from '../../data/derive'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { DevicePair } from '../../shared/Preview'
import { useClock } from '../../shared/bits'
import { LabelLayer } from '../../shared/Labels'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { useTier } from '../../shared/quality'
import { NoteChip } from '../../shared/pulse'
import { ActivityFeed, Facts, HealthBlock, IssueList, Links, StatusPill, ThreadList } from '../../shared/sheet'
import './township.css'

export default function Township() {
  const tier = useTier()
  const selectedId = useApp((s) => s.selectedId)
  const plots = usePlots()
  const downAt = useRef({ x: 0, y: 0 })
  return (
    <div className="tw" data-selected={!!selectedId}>
      <SceneCanvas
        className="tw-canvas"
        flat
        shadows={tier === 'high'}
        alwaysSmooth
        camera={{ fov: 26, position: [0, 30, 40], near: 0.5, far: 220 }}
        onPointerDown={(e) => (downAt.current = { x: e.clientX, y: e.clientY })}
        onPointerMissed={(e) => {
          if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) < 6) useApp.getState().select(null)
        }}
      >
        <TownshipScene tier={tier} />
      </SceneCanvas>

      <LabelLayer>
        {plots.map((p) => (
          <Sign key={p.project.id} id={p.project.id} />
        ))}
      </LabelLayer>

      <header className="tw-top">
        <div className="tw-brand">
          <b>Township</b>
          <span>Aspect Ratio Digital</span>
        </div>
      </header>
      <Census />
      <Legend />
      <Crier />
      <aside className="tw-ledger" data-open={!!selectedId}>
        {selectedId && <Ledger key={selectedId} id={selectedId} />}
      </aside>
    </div>
  )
}

function Sign({ id }: { id: string }) {
  const p = useProject(id)
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  if (!p) return null
  return (
    <div id={`lbl-tw-${id}`} className="tw-sign-wrap">
      <NoteChip projectId={id} className="tw-chip" />
      <div className="tw-sign" data-active={active} data-status={p.status}>
        <i />
        <b>{p.name}</b>
      </div>
    </div>
  )
}

function Census() {
  const projects = useData((s) => s.projects)
  const now = useClock()
  const count = (f: (s: ReturnType<typeof signals>) => boolean | number) => projects.reduce((a, p) => a + Number(f(signals(p))), 0)
  const workers = projects.reduce((a, p) => a + p.threads.filter((t) => t.status === 'working').length, 0)
  const h = now.getHours()
  const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'
  return (
    <section className="tw-card tw-census">
      <h2>
        {part} in town, Dylan
      </h2>
      <dl>
        <div>
          <dt>Houses</dt>
          <dd>{projects.length}</dd>
        </div>
        <div data-tone="claude">
          <dt>Claude at work</dt>
          <dd>{workers}</dd>
        </div>
        <div data-tone="progress">
          <dt>Building</dt>
          <dd>{count((s) => s.building || s.deploying)}</dd>
        </div>
        <div data-tone="critical">
          <dt>In trouble</dt>
          <dd>{count((s) => s.broken || s.down)}</dd>
        </div>
        <div data-tone="warning">
          <dt>Complaints</dt>
          <dd>{count((s) => s.issues)}</dd>
        </div>
        <div>
          <dt>Post waiting</dt>
          <dd>{count((s) => s.prs)}</dd>
        </div>
      </dl>
    </section>
  )
}

function Legend() {
  const [open, setOpen] = useState(true)
  return (
    <section className="tw-card tw-legend" data-open={open}>
      <button className="tw-legend-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2>Who's who</h2>
        <span>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul>
          <li>
            <i style={{ background: '#d97757' }} /> Claude (orange, with a cap) is working on that house
          </li>
          <li>
            <i style={{ background: '#ffd23f' }} /> Scaffolding and hard hats: a build is running
          </li>
          <li>
            <i style={{ background: '#fff', boxShadow: 'inset 0 0 0 2px #b98a5e' }} /> A delivery van: it's deploying
          </li>
          <li>
            <i style={{ background: '#6b6b74' }} /> Smoke from the chimney: broken. A red barrier: site down
          </li>
          <li>
            <i style={{ background: '#e5484d' }} /> A queue with red bubbles: open issues
          </li>
          <li>
            <i style={{ background: '#e5484d', borderRadius: 2 }} /> Mailbox flag up: a pull request is waiting
          </li>
          <li>
            <i style={{ background: 'linear-gradient(135deg,#ff7a59,#5b8def,#36b37e)' }} /> Confetti and jumping: it shipped
          </li>
        </ul>
      )}
    </section>
  )
}

function Crier() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const last = claude.messages.at(-1)
  return (
    <section className="tw-card tw-crier">
      <div className="tw-crier-say">
        <span className="tw-crier-face" data-speaking={claude.speaking} aria-hidden />
        <p aria-live="polite">{last?.text || 'Hello! Ask me anything about the town.'}</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          claude.send(text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the town crier (Claude)" aria-label="Message Claude" />
        <button disabled={!text.trim()}>Ask</button>
      </form>
      <div className="tw-chips">
        {SUGGESTIONS.slice(0, 3).map((s) => (
          <button key={s} onClick={() => claude.send(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}

type Tab = 'threads' | 'activity' | 'health' | 'issues'

function Ledger({ id }: { id: string }) {
  const p = useProject(id)
  const select = useApp((s) => s.select)
  const [tab, setTab] = useState<Tab>('threads')
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => scroller.current?.scrollTo({ top: 0 }), [id])
  if (!p) return null
  const s = signals(p)
  return (
    <div className="tw-ledger-in" ref={scroller}>
      <header>
        <div>
          <h2>{p.name}</h2>
          <p>
            <StatusPill project={p} /> <span>{p.reason}</span>
          </p>
        </div>
        <button className="tw-x" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </header>
      <DevicePair project={p} className="tw-preview" />
      <Links project={p} />
      <Facts project={p} />
      <p className="tw-story">{story(p.name, s, STATUS_LABEL[p.status], domainOf(p))}</p>
      <div className="tw-tabs" role="tablist">
        {(['threads', 'activity', 'health', 'issues'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'threads' ? `Claude (${p.threads.length})` : t === 'activity' ? 'Goings-on' : t === 'health' ? 'Health' : `Complaints (${p.issues.length})`}
          </button>
        ))}
      </div>
      <div className="tw-tab">
        {tab === 'threads' && <ThreadList project={p} />}
        {tab === 'activity' && <ActivityFeed project={p} limit={12} />}
        {tab === 'health' && <HealthBlock project={p} />}
        {tab === 'issues' && <IssueList project={p} />}
      </div>
    </div>
  )
}

/** One friendly line about what's going on at the house. */
function story(name: string, s: ReturnType<typeof signals>, status: string, domain: string) {
  const bits: string[] = []
  if (s.claude) bits.push('Claude is on site')
  if (s.building) bits.push('builders are in')
  if (s.deploying) bits.push('a delivery is on its way')
  if (s.broken) bits.push('smoke is coming from the chimney')
  if (s.down) bits.push(`${domain} isn't answering`)
  if (s.issues) bits.push(`${s.issues} visitor${s.issues === 1 ? ' is' : 's are'} queueing with complaints`)
  if (s.prs) bits.push(`${s.prs} letter${s.prs === 1 ? '' : 's'} in the mailbox`)
  if (!bits.length) return `All quiet at ${name}. ${status}.`
  const last = bits.pop()
  return `At ${name}, ${bits.length ? `${bits.join(', ')} and ${last}` : last}.`
}
