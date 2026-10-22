import { useEffect, useRef, useState } from 'react'
import { BlueprintScene, LETTERS, useLots, type Lot } from './Scene'
import { PART_NAME, useBp } from './state'
import type { Project, Thread } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, domainOf, fmtDur, fmtMs, relTime, signals, threadsByPush } from '../../data/derive'
import { useChange } from '../../data/change'
import { useApp } from '../../store'
import { useClaude, convsFor, hasTalk } from '../../shared/claude'
import { ClaudeFull, Notes, ProjectClaude } from './Claude'
import { DevicePair } from '../../shared/Preview'
import { useClock, Sparkline } from '../../shared/bits'
import { LabelLayer } from '../../shared/Labels'
import { SceneCanvas } from '../../shared/SceneCanvas'
import { NoteChip } from '../../shared/pulse'
import { ChecksList, Links, PageDetail, Score, ThreadItem } from '../../shared/sheet'
import { StoreConnect, StorePanel, storeLine } from './Store'
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
      if (useClaude.getState().full) {
        e.stopImmediatePropagation()
        useClaude.getState().closeFull()
      } else if (useBp.getState().claude) {
        e.stopImmediatePropagation()
        useBp.getState().setClaude(false)
      } else if (useBp.getState().dissect) {
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
      <ClaudeFull />
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
    ...threadsByPush(p)
      .slice(0, 5)
      .map((t, k): [string, string, string] => [`hut:${k}`, `${k === 0 ? 'Latest push' : `Hut ${k + 1}`} · ${relTime(t.pushed ?? t.updated)}`, t.title]),
    ['foundation', 'Foundation · build quality', p.quality.grade ? `grade ${p.quality.grade}` : 'no CI yet'],
    ...(p.store ? [['store', 'Shopfront · Shopify', storeLine(p)] as [string, string, string]] : []),
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
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M6 18V9h14v9M4 9l3-4h12l3 4" fill="none" stroke="currentColor" />
            <circle cx="13" cy="3" r="2" fill="var(--go)" />
          </svg>
          Shopfront: the site's Shopify store; a coin rises on each order
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
  const claude = useBp((s) => s.claude)
  const setDissect = useBp((s) => s.setDissect)
  const setClaude = useBp((s) => s.setClaude)
  if (!p || !lot) return null
  const mode = claude ? 'claude' : dissect ? 'section' : 'detail'
  return (
    <aside className="bp-callout" data-dissect={dissect} data-mode={mode} key={mode}>
      <header>
        <span className="bp-bubble">{lot.letter}</span>
        <div>
          <h2>
            {claude ? `Claude: ${p.name}` : `${dissect ? 'Section' : 'Detail'} ${lot.letter}${dissect ? `-${lot.letter}` : ''}: ${p.name}`}
          </h2>
          <p>
            {domainOf(p)}, {STATUS_LABEL[p.status].toLowerCase()}. {p.reason}.
          </p>
        </div>
        <button onClick={() => (claude ? setClaude(false) : dissect ? setDissect(false) : select(null))} aria-label={claude ? 'Back to the details' : dissect ? 'Close the section' : 'Close detail'}>
          {claude ? 'Details' : dissect ? 'Close up' : '✕'}
        </button>
      </header>
      {claude ? <ProjectClaude project={p} /> : dissect ? <Section project={p} /> : <Overview project={p} floors={lot.floors} onOpen={() => setDissect(true)} onClaude={() => setClaude(true)} />}
    </aside>
  )
}

function Overview({ project: p, floors, onOpen, onClaude }: { project: Project; floors: number; onOpen: () => void; onClaude: () => void }) {
  const convs = useClaude((s) => s.convs)
  const talks = convsFor(convs, p.id).filter(hasTalk)
  const working = talks.some((c) => c.speaking)
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
            <th>Shop</th>
            <td>{p.store ? `${p.store.name ?? (p.store.domain || 'Shopify')} · ${storeLine(p)}` : <AttachStore project={p} />}</td>
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
      <section className="bp-claude-cta">
        <h4>Claude</h4>
        <p className="bp-help">
          {working
            ? 'Claude is working on this project now.'
            : talks.length
              ? `${talks.length} conversation${talks.length === 1 ? '' : 's'} about ${p.name} since the app opened, newest: “${talks[0].title}”.`
              : `Ask Claude about ${p.name}, or have it work in the project's folder.`}
        </p>
        <button className="bp-open" onClick={onClaude}>
          Open Claude <span>{talks.length ? 'carry on where you left off' : 'in this panel'}</span>
        </button>
      </section>
    </div>
  )
}

function AttachStore({ project: p }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="bp-link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Attach a Shopify store'}
      </button>
      {open && <StoreConnect project={p} />}
    </>
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
    ...(p.store ? [['store', 'Store'] as [string, string]] : []),
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
        <h3>{part.startsWith('floor:') ? `Floor ${Number(part.slice(6)) + 1}: a page of the site` : part.startsWith('hut:') ? (part === 'hut:0' ? 'Latest push: a Claude thread' : `Hut ${Number(part.slice(4)) + 1}: a Claude thread`) : PART_NAME[part]}</h3>
        {part === 'roof' && <Speed project={p} />}
        {part === 'sign' && <Seo project={p} />}
        {part === 'foundation' && <Build project={p} />}
        {part === 'store' && <StorePanel project={p} />}
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
  const threads = threadsByPush(p)
  const t = threads[index]
  if (!t) return <p className="bp-help">No Claude threads on this project yet.</p>
  return (
    <>
      <ul className="sh-threads">
        <ThreadItem t={t} />
      </ul>
      {t.summary && <p className="bp-help">{t.summary}</p>}
      <Changes project={p} thread={t} />
      <table>
        <tbody>
          <tr>
            <th>Where</th>
            <td>{t.source === 'claude-web' ? 'Claude on the web' : t.source === 'claude-local' ? 'Claude Code on this computer' : 'Pull request'}</td>
          </tr>
          {t.pushed && (
            <tr>
              <th>Last push</th>
              <td>
                {new Date(t.pushed).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ({relTime(t.pushed)})
              </td>
            </tr>
          )}
          {t.branch && (
            <tr>
              <th>Branch</th>
              <td>{t.branch}</td>
            </tr>
          )}
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
      {threads.length > 1 && (
        <>
          <h4>All huts, newest push first</h4>
          <ul className="bp-floors">
            {threads.slice(0, 5).map((x, k) => (
              <li key={x.id}>
                <button aria-pressed={k === index} onClick={() => setPart(`hut:${k}`)}>
                  <b>{x.title}</b>
                  <span>
                    {x.status} · pushed {relTime(x.pushed ?? x.updated)}
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

/** What the thread's latest push changed, in a few plain-English sentences. */
function Changes({ project, thread }: { project: Project; thread: Thread }) {
  const { change: c, loading, error } = useChange(project, thread)
  return (
    <section className="bp-change">
      <h4>What changed</h4>
      {loading ? (
        <p className="bp-help">
          <i className="bp-caret" /> Reading this push and writing a summary…
        </p>
      ) : error ? (
        <p className="bp-help">Couldn’t load the changes: {error}</p>
      ) : c ? (
        <>
          <p>{c.summary}</p>
          {c.url && (
            <a className="bp-link" href={c.url} target="_blank" rel="noreferrer">
              See it on GitHub
            </a>
          )}
        </>
      ) : null}
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
