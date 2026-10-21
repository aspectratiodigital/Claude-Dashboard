import { useCallback, useEffect, useRef, useState } from 'react'
import { HelixScene, HX_STATUS } from './Scene'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, domainOf, relTime, signals } from '../../data/derive'
import { useApp } from '../../store'
import { usePointer, useClock } from '../../shared/bits'
import { DevicePair } from '../../shared/Preview'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { useTier } from '../../shared/quality'
import { LabelLayer } from '../../shared/Labels'
import { NoteChip } from '../../shared/pulse'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { ActivityFeed, Facts, HealthBlock, IssueList, Links, StatusPill, ThreadList } from '../../shared/sheet'
import './helix.css'

export default function Helix() {
  const pointer = usePointer()
  const tier = useTier()
  const projects = useData((s) => s.projects)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const scroll = useRef(0)
  const target = useRef(0)
  const [focus, setFocus] = useState(0)
  const idle = useRef<number | undefined>(undefined)
  const count = useRef(projects.length)
  count.current = projects.length

  const go = useCallback((i: number) => {
    target.current = Math.max(0, Math.min(count.current - 1, i))
  }, [])

  // Smooth scroll: wheel/drag set a target, a light rAF loop eases toward it,
  // and the helix snaps to the nearest card once input stops.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, t - last) / 1000)
      last = Math.max(last, t)
      scroll.current += (target.current - scroll.current) * Math.min(1, dt * 6)
      const f = Math.max(0, Math.min(count.current - 1, Math.round(scroll.current)))
      setFocus((p) => (p === f ? p : f))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const snap = () => {
      window.clearTimeout(idle.current)
      idle.current = window.setTimeout(() => (target.current = Math.round(target.current)), 140)
    }
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.hx-drawer, .palette, .drawer, .modal, .stage')) return
      target.current = Math.max(-0.35, Math.min(count.current - 0.65, target.current + e.deltaY * 0.0022))
      snap()
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || useApp.getState().stage) return
      if (e.key === 'ArrowDown' || e.key === 'j') go(Math.round(target.current) + 1)
      if (e.key === 'ArrowUp' || e.key === 'k') go(Math.round(target.current) - 1)
      const p = useData.getState().projects[Math.round(target.current)]
      if (e.key === 'Enter' && p) useApp.getState().select(p.id)
    }
    let dragY: number | null = null
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName === 'CANVAS') dragY = e.clientY
    }
    const move = (e: PointerEvent) => {
      if (dragY === null) return
      target.current -= (e.clientY - dragY) * 0.008
      dragY = e.clientY
    }
    const up = () => {
      if (dragY !== null) target.current = Math.round(Math.max(0, Math.min(count.current - 1, target.current)))
      dragY = null
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [go])

  // Opening a project elsewhere (palette, notification) scrolls the helix to it.
  useEffect(() => {
    const i = useData.getState().projects.findIndex((s) => s.id === selectedId)
    if (i >= 0) go(i)
  }, [selectedId, go])

  const onPick = useCallback(
    (i: number) => {
      const p = useData.getState().projects[i]
      if (i === Math.round(target.current) && p) select(p.id)
      else go(i)
    },
    [go, select],
  )

  const project = projects[Math.max(0, Math.min(projects.length - 1, focus))]

  return (
    <div className="hx" data-drawer={!!selectedId}>
      <SceneCanvas className="hx-canvas" flat camera={{ position: [-1.9, 0, 15], fov: 38 }} maxDpr={1.75}>
        <HelixScene scroll={scroll} pointer={pointer} onPick={onPick} drawer={!!selectedId} tier={tier} />
      </SceneCanvas>

      <LabelLayer>
        {projects.map((p) => (
          <div key={p.id} id={`lbl-hx-${p.id}`}>
            <NoteChip projectId={p.id} className="hx-chip" />
          </div>
        ))}
      </LabelLayer>

      <header className="hx-top">
        <div className="hx-mark">
          <Mark />
          <span>Aspect Ratio Digital</span>
        </div>
        <Greeting />
      </header>

      {project && (
        <section className="hx-hero" aria-live="polite">
          <p className="hx-count">
            {String(focus + 1).padStart(2, '0')} of {String(projects.length).padStart(2, '0')}
          </p>
          <h1 key={project.id}>
            {project.name.split(' ').map((w, i) => (
              <span key={i} style={{ ['--i' as string]: i }}>
                {w}
              </span>
            ))}
          </h1>
          <div className="hx-meta" key={`m-${project.id}`}>
            <span className="hx-pill" style={{ ['--c' as string]: HX_STATUS[project.status] }}>
              {STATUS_LABEL[project.status]}
            </span>
            <span>{project.framework}</span>
            <span>{project.defaultBranch}</span>
          </div>
          <p className="hx-tag" key={`t-${project.id}`}>
            {project.reason}. {project.commits[0] ? `Last change: ${project.commits[0].message}, ${relTime(project.commits[0].date)}.` : ''}
          </p>
          <Signals id={project.id} />
          <div className="hx-actions">
            <button className="hx-btn primary" onClick={() => select(project.id)}>
              Open workspace
            </button>
            <a className="hx-btn" href={`https://github.com/${project.repo}`} target="_blank" rel="noreferrer">
              View repo
            </a>
          </div>
        </section>
      )}

      <nav className="hx-rail" aria-label="Projects">
        {projects.map((s, i) => (
          <button key={s.id} aria-current={i === focus} onClick={() => go(i)} style={{ ['--c' as string]: HX_STATUS[s.status] }}>
            <span>{s.name}</span>
            <i data-busy={s.status === 'building' || s.status === 'deploying'} />
          </button>
        ))}
      </nav>

      <p className="hx-hint">Scroll or drag to move through your projects. Click the front card to open it.</p>

      <Drawer />
    </div>
  )
}

/** What's happening on the focused project, as a row of quiet chips. */
function Signals({ id }: { id: string }) {
  const p = useProject(id)
  if (!p) return null
  const s = signals(p)
  const items: [string, string, string][] = []
  if (s.building) items.push(['progress', 'Building', 'A CI run is in progress'])
  if (s.deploying) items.push(['info', 'Deploying', 'A deploy is on its way'])
  if (s.broken) items.push(['critical', 'Broken', p.reason])
  if (s.down) items.push(['critical', 'Site down', 'The live site did not answer'])
  if (s.claude) items.push(['info', 'Claude is working', p.threads.find((t) => t.status === 'working')?.title ?? ''])
  if (s.issues) items.push(['warning', `${s.issues} open issue${s.issues === 1 ? '' : 's'}`, p.issues[0]?.title ?? ''])
  if (s.prs) items.push(['info', `${s.prs} open PR${s.prs === 1 ? '' : 's'}`, p.pulls.find((x) => x.state === 'open')?.title ?? ''])
  if (s.fresh) items.push(['success', 'Just deployed', ''])
  if (!items.length) return null
  return (
    <ul className="hx-signals" key={id}>
      {items.slice(0, 4).map(([lv, label, title], i) => (
        <li key={label} data-level={lv} title={title} style={{ ['--i' as string]: i }}>
          {label}
        </li>
      ))}
    </ul>
  )
}

function Greeting() {
  const now = useClock()
  const projects = useData((s) => s.projects)
  const working = projects.reduce((a, p) => a + p.threads.filter((t) => t.status === 'working').length, 0)
  const h = now.getHours()
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
  return (
    <p className="hx-greet">
      Good {part}, Dylan. {working ? `Claude is working on ${working} thing${working === 1 ? '' : 's'}.` : `${projects.length} projects, all quiet.`}
    </p>
  )
}

type Tab = 'overview' | 'threads' | 'activity' | 'health' | 'issues' | 'claude'

function Drawer() {
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const p = useProject(selectedId)
  const [tab, setTab] = useState<Tab>('overview')
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages, tab])
  useEffect(() => setTab('overview'), [selectedId])

  const tabs: [Tab, string][] = p
    ? [
        ['overview', 'Overview'],
        ['threads', `Threads (${p.threads.length})`],
        ['activity', 'Activity'],
        ['health', 'Health'],
        ['issues', `Issues (${p.issues.length})`],
        ['claude', 'Ask Claude'],
      ]
    : []

  return (
    <aside className="hx-drawer" aria-hidden={!p} data-open={!!p}>
      {p && (
        <>
          <header>
            <div>
              <h2>{p.name}</h2>
              <p>
                <StatusPill project={p} /> <span>{p.reason}</span>
              </p>
            </div>
            <button className="hx-x" onClick={() => select(null)} aria-label="Close workspace">
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          </header>
          <div className="hx-tabs" role="tablist">
            {tabs.map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          <div className="hx-pane">
            {tab === 'overview' && (
              <>
                <DevicePair project={p} className="hx-preview" />
                <Links project={p} />
                <Facts project={p} />
              </>
            )}
            {tab === 'threads' && <ThreadList project={p} />}
            {tab === 'activity' && <ActivityFeed project={p} limit={14} />}
            {tab === 'health' && <HealthBlock project={p} />}
            {tab === 'issues' && <IssueList project={p} />}
            {tab === 'claude' && (
              <div className="hx-chat">
                <div className="hx-log" ref={log}>
                  {claude.messages.map((m) => (
                    <p key={m.id} data-role={m.role}>
                      {m.text || '…'}
                    </p>
                  ))}
                </div>
                <div className="hx-sugg">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => claude.send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    claude.send(text)
                    setText('')
                  }}
                >
                  <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask about ${p.name}`} aria-label="Message Claude" />
                  <button disabled={!text.trim()}>Send</button>
                </form>
              </div>
            )}
          </div>
          <p className="hx-domain">{domainOf(p)}</p>
        </>
      )}
    </aside>
  )
}

const Mark = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
    <rect x="1" y="5" width="20" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <rect x="6" y="1" width="10" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
  </svg>
)
