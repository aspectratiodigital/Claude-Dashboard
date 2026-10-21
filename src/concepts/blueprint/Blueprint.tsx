import { useEffect, useRef, useState } from 'react'
import { BlueprintScene, LETTERS, useLots, type Lot } from './Scene'
import { PART_NAME, useBp } from './state'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, domainOf, fmtDur, fmtMs, relTime, signals } from '../../data/derive'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { DevicePair } from '../../shared/Preview'
import { useClock, Sparkline } from '../../shared/bits'
import { LabelLayer } from '../../shared/Labels'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { NoteChip } from '../../shared/pulse'
import { ChecksList, Links, PageDetail, Score, ThreadItem } from '../../shared/sheet'
import './blueprint.css'

const ROWS = ['1', '2', '3', '4', '5']

export default function Blueprint() {
  const selectedId = useApp((s) => s.selectedId)
  const dissect = useBp((s) => s.dissect)
  const lots = useLots()
  const turn = useRef(0)
  const [heading, setHeading] = useState(0)
  const downAt = useRef({ x: 0, y: 0 })

  const rotate = (d: number) => {
    turn.current += d
    setHeading((h) => (((h + d * 90) % 360) + 360) % 360)
  }

  // a new selection always starts closed up
  useEffect(() => useBp.getState().setDissect(false), [selectedId])
  useEffect(() => () => useBp.getState().setDissect(false), [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || useApp.getState().stage) return
      if (e.key === 'q' || e.key === 'Q') rotate(-1)
      if (e.key === 'e' || e.key === 'E') rotate(1)
      if (e.key === 'Enter' && useApp.getState().selectedId) useBp.getState().setDissect(true)
    }
    // Escape closes the section first, then the selection (capture so it runs before the app's handler)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useApp.getState().stage || useApp.getState().settingsOpen || useApp.getState().notesOpen) return
      if (useBp.getState().dissect) {
        e.stopImmediatePropagation()
        useBp.getState().setDissect(false)
      }
    }
    window.addEventListener('keydown', k)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('keydown', esc, true)
    }
  }, [])

  return (
    <div className="bp" data-selected={!!selectedId} data-dissect={dissect}>
      <SceneCanvas
        className="bp-canvas"
        flat
        onPointerDown={(e) => (downAt.current = { x: e.clientX, y: e.clientY })}
        onPointerMissed={(e) => {
          // a click on empty ground clears the selection; a drag (pan) doesn't
          const moved = Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y)
          if (e.button === 0 && moved < 6 && !useBp.getState().dissect) useApp.getState().select(null)
        }}
      >
        <BlueprintScene turn={turn} />
      </SceneCanvas>

      <LabelLayer>
        {lots.map((l) => (
          <Tag key={l.project.id} lot={l} />
        ))}
        {dissect && selectedId && <PartLabels id={selectedId} />}
      </LabelLayer>

      <div className="bp-sheet" aria-hidden>
        <div className="bp-ruler top">
          {LETTERS.slice(0, 8)
            .split('')
            .map((c) => (
              <span key={c}>{c}</span>
            ))}
        </div>
        <div className="bp-ruler bottom">
          {LETTERS.slice(0, 8)
            .split('')
            .map((c) => (
              <span key={c}>{c}</span>
            ))}
        </div>
        <div className="bp-ruler left">
          {ROWS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="bp-ruler right">
          {ROWS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      </div>

      <header className="bp-title">
        <h1>Site plan</h1>
        <p>Every Aspect Ratio Digital property: one floor per page, footprint drawn to this week’s commits. Click a building to select it, click again to open it up.</p>
      </header>

      <Legend />
      <Compass heading={heading} rotate={rotate} />
      {selectedId && <Callout key={selectedId} id={selectedId} lots={lots} />}
      <Notes />
      <TitleBlock />
    </div>
  )
}

function Tag({ lot }: { lot: Lot }) {
  const p = lot.project
  const active = useApp((s) => s.hoveredId === p.id || s.selectedId === p.id)
  const s = signals(p)
  return (
    <div id={`lbl-bp-${p.id}`} className="bp-tag-wrap">
      <NoteChip projectId={p.id} className="bp-chip" />
      <div className="bp-tag" data-active={active} data-status={p.status}>
        <b>
          {lot.letter} · {p.name}
        </b>
        <span>
          {STATUS_LABEL[p.status]} · {lot.floors} floor{lot.floors === 1 ? '' : 's'} · {p.commitsWeek} commits
          {s.issues ? ` · ${s.issues} issue${s.issues === 1 ? '' : 's'}` : ''}
        </span>
      </div>
    </div>
  )
}

/** Leader-line labels on each part of an opened-up building. */
function PartLabels({ id }: { id: string }) {
  const p = useProject(id)
  const part = useBp((s) => s.part)
  const hoverPart = useBp((s) => s.hoverPart)
  const setPart = useBp((s) => s.setPart)
  const setHover = useBp((s) => s.setHoverPart)
  if (!p) return null
  const lot = floorsOf(p)
  const items: [string, string, string][] = [
    ['roof', 'Roof · site speed', p.health.ms === null ? 'not checked' : `${fmtMs(p.health.ms)}${p.health.uptimePct !== null ? ` · ${p.health.uptimePct.toFixed(1)}% up` : ''}`],
    ['sign', 'Sign · SEO', p.health.seoScore === null ? 'not checked' : `${p.health.seoScore}/100`],
    ...Array.from({ length: lot }, (_, j): [string, string, string] => {
      const page = p.pages[j]
      return [`floor:${j}`, `Floor ${j + 1} · ${page?.path ?? '/'}`, page?.title ?? (j === lot - 1 && p.pages.length > lot ? `+${p.pages.length - lot} more pages` : 'page')]
    }),
    ...p.threads.slice(0, 5).map((t, k): [string, string, string] => [`hut:${k}`, `Hut ${k + 1} · thread`, t.title]),
    ['foundation', 'Foundation · build quality', p.quality.grade ? `grade ${p.quality.grade}` : 'no CI yet'],
  ]
  return (
    <>
      {items.map(([key, label, value]) => (
        <div key={key} id={`bp-part-${key}`} className="bp-part-wrap">
          <button
            className="bp-part"
            data-side={key === 'roof' || key.startsWith('hut:') ? 'right' : 'left'}
            data-on={part === key || hoverPart === key}
            onClick={() => setPart(key)}
            onPointerEnter={() => setHover(key)}
            onPointerLeave={() => setHover(null)}
          >
            <b>{label}</b>
            <span>{value}</span>
          </button>
        </div>
      ))}
    </>
  )
}

const floorsOf = (p: Project) => Math.max(1, Math.min(10, p.pages.length || 1))

function Legend() {
  return (
    <section className="bp-legend">
      <h2>Key</h2>
      <ul>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M4 18V8h8v10M4 13h8M4 8l4-3 4 3" fill="none" stroke="currentColor" />
          </svg>
          One floor per page; huts are Claude threads
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M6 18V3h12M6 3l-3 0M15 3v5" fill="none" stroke="var(--mark)" />
          </svg>
          Crane and scan line: a build is running
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <rect x="9" y="3" width="6" height="6" fill="var(--go)" />
            <path d="M12 18V9" stroke="var(--go)" strokeDasharray="2 2" />
          </svg>
          Green lift: deploying
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M13 3l5 7-5 7-5-7z" fill="var(--alert)" />
          </svg>
          Red beacon: broken or site down
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M8 18V4" stroke="currentColor" />
            <path d="M8 4h9l-2 3 2 3H8" fill="var(--alert)" />
          </svg>
          Flags: open issues
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M13 4l4 6-4 6-4-6z" fill="none" stroke="currentColor" />
          </svg>
          Drone over the roof: Claude is working
        </li>
      </ul>
    </section>
  )
}

function Compass({ heading, rotate }: { heading: number; rotate: (d: number) => void }) {
  return (
    <div className="bp-compass">
      <button onClick={() => rotate(-1)} aria-label="Rotate left (Q)">
        Q
      </button>
      <svg width="58" height="58" viewBox="0 0 58 58" style={{ transform: `rotate(${-heading}deg)` }} aria-label={`Heading ${heading} degrees`}>
        <circle cx="29" cy="29" r="26" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="29" cy="29" r="20" fill="none" stroke="currentColor" strokeWidth=".5" strokeDasharray="1 3" />
        <path d="M29 6l5 23h-10z" fill="var(--mark)" />
        <path d="M29 52l5-23h-10z" fill="none" stroke="currentColor" />
        <text x="29" y="4" textAnchor="middle" fontSize="7" fill="currentColor" dy="-1">
          N
        </text>
      </svg>
      <button onClick={() => rotate(1)} aria-label="Rotate right (E)">
        E
      </button>
    </div>
  )
}

function Callout({ id, lots }: { id: string; lots: Lot[] }) {
  const p = useProject(id)
  const lot = lots.find((l) => l.project.id === id)
  const select = useApp((s) => s.select)
  const dissect = useBp((s) => s.dissect)
  const setDissect = useBp((s) => s.setDissect)
  if (!p || !lot) return null
  return (
    <aside className="bp-callout" data-dissect={dissect} key={String(dissect)}>
      <header>
        <span className="bp-bubble">{lot.letter}</span>
        <div>
          <h2>
            {dissect ? 'Section' : 'Detail'} {lot.letter}
            {dissect ? `-${lot.letter}` : ''}: {p.name}
          </h2>
          <p>
            {domainOf(p)}, {STATUS_LABEL[p.status].toLowerCase()}. {p.reason}.
          </p>
        </div>
        <button onClick={() => (dissect ? setDissect(false) : select(null))} aria-label={dissect ? 'Close the section' : 'Close detail'}>
          {dissect ? 'Close up' : '✕'}
        </button>
      </header>
      {dissect ? <Section project={p} /> : <Overview project={p} floors={lot.floors} onOpen={() => setDissect(true)} />}
    </aside>
  )
}

function Overview({ project: p, floors, onOpen }: { project: Project; floors: number; onOpen: () => void }) {
  return (
    <div className="bp-scroll">
      <DevicePair project={p} className="bp-preview" />
      <Links project={p} />
      <table>
        <tbody>
          <tr>
            <th>Repo</th>
            <td>{p.repo}</td>
          </tr>
          <tr>
            <th>Stack</th>
            <td>
              {p.framework}
              {p.host ? ` on ${p.host}` : ''}
            </td>
          </tr>
          <tr>
            <th>Floors</th>
            <td>
              {floors} of {p.pages.length || 1} page{p.pages.length === 1 ? '' : 's'}
            </td>
          </tr>
          <tr>
            <th>Huts</th>
            <td>
              {p.threads.length} Claude thread{p.threads.length === 1 ? '' : 's'}
              {p.threads.some((t) => t.status === 'working') ? ', one working now' : ''}
            </td>
          </tr>
          <tr>
            <th>Last change</th>
            <td>{p.commits[0] ? `${p.commits[0].message} (${relTime(p.commits[0].date)})` : 'No commits yet'}</td>
          </tr>
        </tbody>
      </table>
      <button className="bp-open" onClick={onOpen}>
        Open up the building <span>or click it again</span>
      </button>
    </div>
  )
}

function Section({ project: p }: { project: Project }) {
  const part = useBp((s) => s.part) ?? 'roof'
  const setPart = useBp((s) => s.setPart)
  const groups: [string, string][] = [
    ['roof', 'Site speed'],
    ['sign', 'SEO'],
    ['floor:0', `Pages (${p.pages.length})`],
    ['hut:0', `Threads (${p.threads.length})`],
    ['foundation', 'Build quality'],
  ]
  const groupOf = (k: string) => (k.startsWith('floor:') ? 'floor:0' : k.startsWith('hut:') ? 'hut:0' : k)
  return (
    <div className="bp-section">
      <nav className="bp-parts" aria-label="Parts of the building">
        {groups.map(([k, label]) => (
          <button key={k} aria-pressed={groupOf(part) === k} onClick={() => setPart(k)} disabled={(k === 'hut:0' && !p.threads.length) || (k === 'floor:0' && !p.pages.length)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="bp-scroll" key={part}>
        <h3>{part.startsWith('floor:') ? `Floor ${Number(part.slice(6)) + 1}: a page of the site` : part.startsWith('hut:') ? `Hut ${Number(part.slice(4)) + 1}: a Claude thread` : PART_NAME[part]}</h3>
        {part === 'roof' && <Speed project={p} />}
        {part === 'sign' && <Seo project={p} />}
        {part === 'foundation' && <Build project={p} />}
        {part.startsWith('floor:') && <Floors project={p} index={Number(part.slice(6))} />}
        {part.startsWith('hut:') && <Huts project={p} index={Number(part.slice(4))} />}
      </div>
    </div>
  )
}

function Speed({ project: p }: { project: Project }) {
  const h = p.health
  const history = h.history.filter((x) => x >= 0)
  const refresh = useData((s) => s.refresh)
  return (
    <>
      <div className="sh-scores">
        <Score value={h.uptimePct} label="Uptime" />
        {h.psi && <Score value={h.psi.scores.performance} label="Lighthouse" />}
        {h.psi && <Score value={h.psi.scores.accessibility} label="Access." />}
      </div>
      <table>
        <tbody>
          <tr>
            <th>Response</th>
            <td>
              {fmtMs(h.ms)} {history.length > 2 && <Sparkline data={history} width={90} height={16} />}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td>{h.up === null ? 'Not checked yet' : h.up ? `Up (HTTP ${h.code})` : `Down${h.code ? ` (HTTP ${h.code})` : ''}`}</td>
          </tr>
          <tr>
            <th>Checked</th>
            <td>{relTime(h.checked)}</td>
          </tr>
          {h.psi && (
            <tr>
              <th>Largest paint</th>
              <td>
                {fmtMs(h.psi.lcp)} · CLS {h.psi.cls.toFixed(2)} · TBT {fmtMs(h.psi.tbt)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="bp-help">{h.url ? 'One light request to the live site every few minutes, from this computer. Add a free PageSpeed key in Settings for Lighthouse scores.' : 'Add a live URL in Settings to track speed and uptime.'}</p>
      <button className="bp-open" onClick={refresh}>
        Check again
      </button>
    </>
  )
}

function Seo({ project: p }: { project: Project }) {
  const checks = p.health.checks
  return (
    <>
      <div className="sh-scores">
        <Score value={p.health.seoScore} label="SEO tags" />
        {p.health.psi && <Score value={p.health.psi.scores.seo} label="Lighthouse SEO" />}
      </div>
      {checks.length ? <ChecksList checks={checks} /> : <p className="bp-help">Tag checks appear after the first health check of the live site.</p>}
      <p className="bp-help">Checked on the home page. Open a floor to check a single page.</p>
    </>
  )
}

function Build({ project: p }: { project: Project }) {
  const q = p.quality
  return (
    <>
      <div className="sh-scores">
        <Score value={q.ciPassRate === null ? null : q.ciPassRate * 100} label="Builds passing" />
        <figure className="bp-grade" data-grade={q.grade ?? 'none'}>
          <b>{q.grade ?? '–'}</b>
          <figcaption>Grade</figcaption>
        </figure>
      </div>
      <table>
        <tbody>
          <tr>
            <th>Avg build</th>
            <td>{fmtDur(q.avgBuildS)}</td>
          </tr>
          <tr>
            <th>Open bugs</th>
            <td>{q.openBugs}</td>
          </tr>
          <tr>
            <th>Open PRs</th>
            <td>{q.openPRs}</td>
          </tr>
          <tr>
            <th>Old branches</th>
            <td>{q.staleBranches}</td>
          </tr>
        </tbody>
      </table>
      <h4>Recent runs</h4>
      <ul className="bp-runs">
        {p.runs.slice(0, 6).map((r) => (
          <li key={r.id} data-state={r.status}>
            <a href={r.url} target="_blank" rel="noreferrer">
              <i />
              <b>{r.name}</b>
              <span>
                {r.branch} · {r.status === 'running' || r.status === 'queued' ? 'running now' : `${r.status}, ${fmtDur(r.durationS)}`} · {relTime(r.started)}
              </span>
            </a>
          </li>
        ))}
        {!p.runs.length && <li className="bp-help">No GitHub Actions runs on this repo.</li>}
      </ul>
    </>
  )
}

function Floors({ project: p, index }: { project: Project; index: number }) {
  const setPart = useBp((s) => s.setPart)
  const page = p.pages[index]
  return (
    <>
      {page ? <PageDetail project={p} page={page} /> : <p className="bp-help">No page found for this floor yet.</p>}
      <h4>All floors</h4>
      <ol className="bp-floors" reversed>
        {p.pages
          .map((pg, j) => ({ pg, j }))
          .reverse()
          .map(({ pg, j }) => (
            <li key={pg.path}>
              <button aria-pressed={j === index} onClick={() => setPart(`floor:${j}`)}>
                <b>{pg.path}</b>
                <span>{pg.title ?? (pg.source === 'sitemap' ? 'from sitemap' : pg.source === 'repo' ? 'from repo' : 'from nav')}</span>
              </button>
            </li>
          ))}
      </ol>
    </>
  )
}

function Huts({ project: p, index }: { project: Project; index: number }) {
  const setPart = useBp((s) => s.setPart)
  const t = p.threads[index]
  if (!t) return <p className="bp-help">No Claude threads on this project yet.</p>
  return (
    <>
      <ul className="sh-threads">
        <ThreadItem t={t} />
      </ul>
      {t.summary && <p className="bp-help">{t.summary}</p>}
      <table>
        <tbody>
          <tr>
            <th>Where</th>
            <td>{t.source === 'claude-web' ? 'Claude on the web' : t.source === 'claude-local' ? 'Claude Code on this computer' : 'Pull request'}</td>
          </tr>
          {t.branch && (
            <tr>
              <th>Branch</th>
              <td>{t.branch}</td>
            </tr>
          )}
          <tr>
            <th>Commits</th>
            <td>{t.commits}</td>
          </tr>
          {t.resume && (
            <tr>
              <th>Resume</th>
              <td>
                <code>claude --resume {t.resume}</code>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {p.threads.length > 1 && (
        <>
          <h4>Other huts</h4>
          <ul className="bp-floors">
            {p.threads.slice(0, 5).map((x, k) => (
              <li key={x.id}>
                <button aria-pressed={k === index} onClick={() => setPart(`hut:${k}`)}>
                  <b>{x.title}</b>
                  <span>
                    {x.status} · {relTime(x.updated)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function Notes() {
  const selectedId = useApp((s) => s.selectedId)
  const projects = useData((s) => s.projects)
  const [target, setTarget] = useState<string>('')
  // follow the building you pick, but let the dropdown override it
  useEffect(() => {
    if (selectedId) setTarget(selectedId)
  }, [selectedId])
  const claude = useClaude(target || null)
  const [text, setText] = useState('')
  const log = useRef<HTMLOListElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages])
  const linkNote = { checking: '', live: 'Claude Code', missing: 'Not connected', offline: 'Demo' }[claude.link]
  return (
    <section className="bp-notes">
      <header className="bp-notes-head">
        <h2>Notes with Claude</h2>
        {linkNote && <small data-link={claude.link}>{linkNote}</small>}
      </header>
      <label className="bp-notes-target">
        <span>About</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={claude.speaking}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <ol ref={log} aria-live="polite">
        {claude.messages.map((m) => (
          <li key={m.id} data-role={m.role} data-error={m.error || undefined}>
            <span>{m.role === 'claude' ? 'C' : 'D'}</span>
            <div>
              <p>
                {m.text}
                {m.streaming && !m.doing && <i className="bp-caret" />}
              </p>
              {m.doing && (
                <p className="bp-doing">
                  <i className="bp-caret" /> {m.doing}
                </p>
              )}
              {m.asks && (
                <div className="bp-ask">
                  <ul>
                    {m.asks.map((a) => (
                      <li key={a.rule}>{a.what}</li>
                    ))}
                  </ul>
                  {m.answered ? (
                    <em>{m.answered === 'allowed' ? 'Allowed' : 'Not allowed'}</em>
                  ) : (
                    <div>
                      <button onClick={() => claude.answer(m, true)} disabled={claude.speaking}>
                        Allow
                      </button>
                      <button onClick={() => claude.answer(m, false)} disabled={claude.speaking}>
                        No
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="bp-sugg">
        {SUGGESTIONS.slice(0, 3).map((s) => (
          <button key={s} onClick={() => claude.send(s)} disabled={claude.speaking}>
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (claude.speaking) return claude.stop()
          claude.send(text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={target ? 'Ask Claude to look at or work on this project' : 'Ask Claude about your sites'} aria-label="Message Claude" />
        <button disabled={!claude.speaking && !text.trim()}>{claude.speaking ? 'Stop' : 'Send'}</button>
      </form>
    </section>
  )
}

function TitleBlock() {
  const now = useClock()
  const projects = useData((s) => s.projects)
  const commits = projects.reduce((a, p) => a + p.commitsWeek, 0)
  return (
    <table className="bp-block">
      <tbody>
        <tr>
          <th colSpan={2} className="bp-block-name">
            Aspect Ratio Digital
          </th>
        </tr>
        <tr>
          <th>Drawing</th>
          <td>Estate overview</td>
        </tr>
        <tr>
          <th>Drawn by</th>
          <td>Claude, for Dylan</td>
        </tr>
        <tr>
          <th>Date</th>
          <td>{now.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</td>
        </tr>
        <tr>
          <th>Scale</th>
          <td>
            {commits} commits : {projects.length} sites
          </td>
        </tr>
        <tr>
          <th>Sheet</th>
          <td>1 of 1, rev {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        </tr>
      </tbody>
    </table>
  )
}
