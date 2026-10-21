import { useEffect, useRef, useState } from 'react'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { NexusScene, NX_COLOR } from './Scene'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, relTime, signals } from '../../data/derive'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { CountUp, Sparkline, useClock, usePointer } from '../../shared/bits'
import { DevicePair } from '../../shared/Preview'
import { LabelLayer } from '../../shared/Labels'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { KindIcon } from '../../shared/icons'
import { ActivityFeed, Facts, HealthBlock, IssueList, Links, StatusPill, ThreadItem, ThreadList } from '../../shared/sheet'
import './nexus.css'

export default function Nexus() {
  const selectedId = useApp((s) => s.selectedId)
  const pointer = usePointer()
  const claude = useClaude(selectedId)
  const projects = useData((s) => s.projects)

  return (
    <div className="nx" data-selected={!!selectedId}>
      <SceneCanvas
        className="nx-canvas"
        camera={{ position: [0, 2.1, 16], fov: 40 }}
        onPointerMissed={() => useApp.getState().select(null)}
        effects={(tier) => (
          <EffectComposer multisampling={tier === 'high' ? 4 : 0} resolutionScale={tier === 'high' ? 1 : 0.6}>
            <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.55} luminanceSmoothing={0.35} radius={0.75} />
          </EffectComposer>
        )}
      >
        <NexusScene level={claude.level} pointer={pointer} />
      </SceneCanvas>

      <LabelLayer>
        {projects.map((p) => (
          <NodeLabel key={p.id} id={p.id} />
        ))}
      </LabelLayer>
      <div className="nx-vignette" aria-hidden />

      <div className="nx-hud">
        <TopBar />
        <aside className="nx-col nx-left">
          <ProjectList />
          <Pulse />
        </aside>
        <aside className="nx-col nx-right">{selectedId ? <Focus key={selectedId} id={selectedId} /> : <Overview />}</aside>
        <Console claude={claude} />
      </div>
    </div>
  )
}

function NodeLabel({ id }: { id: string }) {
  const p = useProject(id)
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  if (!p) return null
  return (
    <div id={`lbl-nx-${id}`}>
      <div className="nx-label" data-active={active} style={{ ['--c' as string]: NX_COLOR[p.status] }}>
        <b>{p.name}</b>
        <span>{active ? p.reason : STATUS_LABEL[p.status]}</span>
      </div>
    </div>
  )
}

function TopBar() {
  const now = useClock()
  const mode = useData((s) => s.mode)
  return (
    <header className="nx-top">
      <div className="nx-brand">
        <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
          <circle cx="15" cy="15" r="13" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".45" />
          <circle cx="15" cy="15" r="6.5" fill="currentColor" opacity=".9" />
          <circle cx="26" cy="11" r="2" fill="currentColor" />
        </svg>
        <div>
          <b>Nexus</b>
          <span>Aspect Ratio Digital{mode === 'live' ? '' : ' · demo'}</span>
        </div>
      </div>
      <div className="nx-clock">
        <b>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
        <span>{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
    </header>
  )
}

function Panel({ title, meta, children, className = '' }: { title: string; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`nx-panel ${className}`}>
      <header>
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </header>
      {children}
    </section>
  )
}

function ProjectList() {
  const projects = useData((s) => s.projects)
  const hoveredId = useApp((s) => s.hoveredId)
  const selectedId = useApp((s) => s.selectedId)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  return (
    <Panel title="Projects" meta={`${projects.length} linked`} className="nx-projects">
      <ul className="nx-list">
        {projects.map((p, i) => (
          <li key={p.id} style={{ ['--i' as string]: i, ['--c' as string]: NX_COLOR[p.status] }}>
            <button
              data-hot={hoveredId === p.id}
              aria-current={selectedId === p.id}
              onPointerEnter={() => hover(p.id)}
              onPointerLeave={() => hover(null)}
              onClick={() => select(selectedId === p.id ? null : p.id)}
            >
              <i className="nx-dot" data-status={p.status} />
              <span className="nx-list-name">
                <b>{p.name}</b>
                <small>{p.reason}</small>
              </span>
              <Sparkline data={p.activity} width={48} height={16} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Pulse() {
  const projects = useData((s) => s.projects)
  const count = (f: (s: ReturnType<typeof signals>) => boolean) => projects.filter((p) => f(signals(p))).length
  const commits = projects.reduce((a, p) => a + p.commitsWeek, 0)
  const prs = projects.reduce((a, p) => a + p.pulls.filter((x) => x.state === 'open').length, 0)
  return (
    <Panel title="Pulse" meta="this week" className="nx-pulse">
      <div className="nx-big">
        <b>
          <CountUp value={commits} duration={1600} />
        </b>
        <span>commits across your projects</span>
      </div>
      <dl className="nx-stats">
        <div data-tone="progress">
          <dt>Building</dt>
          <dd>{count((s) => s.building || s.deploying)}</dd>
        </div>
        <div data-tone="critical">
          <dt>Broken</dt>
          <dd>{count((s) => s.broken)}</dd>
        </div>
        <div data-tone="warning">
          <dt>Issues</dt>
          <dd>{projects.reduce((a, p) => a + p.issues.length, 0)}</dd>
        </div>
        <div>
          <dt>Open PRs</dt>
          <dd>{prs}</dd>
        </div>
      </dl>
    </Panel>
  )
}

function Overview() {
  const projects = useData((s) => s.projects)
  const notes = useData((s) => s.notes)
  const select = useApp((s) => s.select)
  const threads = projects
    .flatMap((p) => p.threads.map((t) => ({ t, p })))
    .sort((a, b) => b.t.updated.localeCompare(a.t.updated))
    .slice(0, 6)
  return (
    <>
      <Panel title="Claude threads" meta={`${threads.filter((x) => x.t.status === 'working').length} working`} className="nx-threads">
        <ul className="sh-threads">
          {threads.map(({ t, p }) => (
            <ThreadItem key={t.id + p.id} t={t} label={p.name} color={NX_COLOR[p.status]} onPick={() => select(p.id)} />
          ))}
        </ul>
        {!threads.length && <p className="sh-empty">Claude's branches, pull requests and local sessions show up here.</p>}
      </Panel>
      <Panel title="Signals" meta="latest" className="nx-feed">
        <ul className="nx-notes">
          {notes.slice(0, 6).map((n) => (
            <li key={n.id} data-level={n.level} onClick={() => select(n.projectId)}>
              <KindIcon kind={n.kind} size={15} />
              <span>
                <b>{n.title}</b>
                <small>
                  {n.body} · {relTime(n.at)}
                </small>
              </span>
            </li>
          ))}
          {!notes.length && <li className="sh-empty">Quiet so far.</li>}
        </ul>
      </Panel>
    </>
  )
}

function Focus({ id }: { id: string }) {
  const p = useProject(id)
  const select = useApp((s) => s.select)
  const [tab, setTab] = useState<'threads' | 'activity' | 'health' | 'issues'>('threads')
  if (!p) return null
  return (
    <section className="nx-panel nx-focus" style={{ ['--c' as string]: NX_COLOR[p.status] }}>
      <button className="nx-close" onClick={() => select(null)} aria-label="Close">
        ×
      </button>
      <header className="nx-focus-head">
        <div>
          <h2>{p.name}</h2>
          <p>
            <StatusPill project={p} /> <span>{p.reason}</span>
          </p>
        </div>
      </header>
      <DevicePair project={p} className="nx-preview" />
      <Links project={p} />
      <Facts project={p} />
      <div className="nx-tabs" role="tablist">
        {(['threads', 'activity', 'health', 'issues'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'threads' ? `Threads (${p.threads.length})` : t === 'activity' ? 'Activity' : t === 'health' ? 'Health' : `Issues (${p.issues.length})`}
          </button>
        ))}
      </div>
      <div className="nx-tab">
        {tab === 'threads' && <ThreadList project={p} />}
        {tab === 'activity' && <ActivityFeed project={p} limit={12} />}
        {tab === 'health' && <HealthBlock project={p} />}
        {tab === 'issues' && <IssueList project={p} />}
      </div>
    </section>
  )
}

function Console({ claude }: { claude: ReturnType<typeof useClaude> }) {
  const [text, setText] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages])
  return (
    <section className="nx-console" data-speaking={claude.speaking}>
      <div className="nx-wave" aria-hidden>
        {Array.from({ length: 18 }, (_, i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>
      <div className="nx-log" ref={log} aria-live="polite">
        {claude.messages.slice(-4).map((m) => (
          <p key={m.id} data-role={m.role}>
            {m.text}
            {m.streaming && <i className="nx-caret" />}
          </p>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          claude.send(text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Claude about your projects" aria-label="Message Claude" />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <div className="nx-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => claude.send(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}
