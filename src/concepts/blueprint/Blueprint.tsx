import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { BlueprintScene, LOTS } from './Scene'
import { siteById, STATUS_LABEL, SITES, totals } from '../../data/mock'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { SitePreview } from '../../shared/SitePreview'
import { useClock } from '../../shared/bits'
import './blueprint.css'

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const ROWS = ['1', '2', '3', '4', '5']

export default function Blueprint() {
  const selectedId = useApp((s) => s.selectedId)
  const turn = useRef(0)
  const [heading, setHeading] = useState(0)

  const rotate = (d: number) => {
    turn.current += d
    setHeading((h) => (((h + d * 90) % 360) + 360) % 360)
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input')) return
      if (e.key === 'q' || e.key === 'Q') rotate(-1)
      if (e.key === 'e' || e.key === 'E') rotate(1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  return (
    <div className="bp" data-selected={!!selectedId}>
      <Canvas className="bp-canvas" dpr={[1, 2]} gl={{ antialias: true, powerPreference: 'high-performance' }} flat>
        <BlueprintScene turn={turn} />
      </Canvas>

      <div className="bp-sheet" aria-hidden>
        <div className="bp-ruler top">
          {COLS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="bp-ruler bottom">
          {COLS.map((c) => (
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
        <p>Every Aspect Ratio Digital property, drawn to the scale of this week’s work.</p>
      </header>

      <Legend />
      <Compass heading={heading} rotate={rotate} />
      {selectedId && <Callout key={selectedId} id={selectedId} />}
      <Notes />
      <TitleBlock />
    </div>
  )
}

function Legend() {
  return (
    <section className="bp-legend">
      <h2>Key</h2>
      <ul>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M4 18V8h8v10M4 13h8M4 8l4-3 4 3" fill="none" stroke="currentColor" />
          </svg>
          One floor per ~3 commits this week
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <rect x="3" y="6" width="9" height="9" fill="none" stroke="currentColor" />
            <rect x="14" y="3" width="10" height="13" fill="none" stroke="currentColor" strokeDasharray="2 2" />
          </svg>
          Footprint grows with traffic
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M6 18V3h12M6 3l-3 0M15 3v5" fill="none" stroke="var(--mark)" />
          </svg>
          Crane: a build is running
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M13 3l5 7-5 7-5-7z" fill="var(--alert)" />
          </svg>
          Beacon: checks are failing
        </li>
        <li>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M2 10h22" stroke="currentColor" strokeDasharray="3 2" />
            <rect x="9" y="8.5" width="5" height="3" fill="var(--mark)" />
          </svg>
          Moving dots are live requests
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

function Callout({ id }: { id: string }) {
  const site = siteById(id)!
  const lot = LOTS.find((l) => l.site.id === id)!
  const select = useApp((s) => s.select)
  const letter = COLS[SITES.findIndex((s) => s.id === id)]
  return (
    <aside className="bp-callout">
      <header>
        <span className="bp-bubble">{letter}</span>
        <div>
          <h2>Detail {letter}: {site.name}</h2>
          <p>
            {site.domain}, {STATUS_LABEL[site.status].toLowerCase()}
          </p>
        </div>
        <button onClick={() => select(null)} aria-label="Close detail">
          ✕
        </button>
      </header>
      <SitePreview site={site} className="bp-preview" />
      <table>
        <tbody>
          <tr>
            <th>Repo</th>
            <td>{site.repo}</td>
          </tr>
          <tr>
            <th>Branch</th>
            <td>{site.branch}</td>
          </tr>
          <tr>
            <th>Height</th>
            <td>
              {lot.floors} floors / {site.commitsThisWeek} commits
            </td>
          </tr>
          <tr>
            <th>Footprint</th>
            <td>{site.visitors7d.toLocaleString()} visits</td>
          </tr>
          <tr>
            <th>Last change</th>
            <td>
              {site.commits[0].message} ({site.commits[0].ago})
            </td>
          </tr>
        </tbody>
      </table>
    </aside>
  )
}

function Notes() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const log = useRef<HTMLOListElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages])
  return (
    <section className="bp-notes">
      <h2>Notes with Claude</h2>
      <ol ref={log}>
        {claude.messages.map((m) => (
          <li key={m.id} data-role={m.role}>
            <span>{m.role === 'claude' ? 'C' : 'D'}</span>
            <p>
              {m.text}
              {m.streaming && <i className="bp-caret" />}
            </p>
          </li>
        ))}
      </ol>
      <div className="bp-sugg">
        {SUGGESTIONS.slice(0, 3).map((s) => (
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for Claude" aria-label="Message Claude" />
        <button disabled={!text.trim()}>Send</button>
      </form>
    </section>
  )
}

function TitleBlock() {
  const now = useClock()
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
            {totals.visitors7d.toLocaleString()} visits : {SITES.length} sites
          </td>
        </tr>
        <tr>
          <th>Sheet</th>
          <td>
            1 of 1, rev {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </td>
        </tr>
      </tbody>
    </table>
  )
}
