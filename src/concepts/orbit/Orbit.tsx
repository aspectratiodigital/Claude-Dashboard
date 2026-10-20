import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { OrbitScene, PLANETS } from './Scene'
import { STATUS_LABEL, siteById, totals, SITES } from '../../data/mock'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { SitePreview } from '../../shared/SitePreview'
import { CountUp } from '../../shared/bits'
import './orbit.css'

export default function Orbit() {
  const selectedId = useApp((s) => s.selectedId)
  const claude = useClaude(selectedId)
  const warp = useRef(1)

  return (
    <div className="ob" data-selected={!!selectedId}>
      <Canvas
        className="ob-canvas"
        dpr={[1, 2]}
        camera={{ position: [0, 12, 30], fov: 45, near: 0.05, far: 400 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
      >
        <OrbitScene level={claude.level} warp={warp} />
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.9} luminanceSmoothing={0.2} />
          <Vignette darkness={0.6} offset={0.3} />
        </EffectComposer>
      </Canvas>

      <header className="ob-top">
        <div className="ob-mark">
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
            <circle cx="14" cy="14" r="4.5" fill="currentColor" />
            <ellipse cx="14" cy="14" rx="12.5" ry="5" fill="none" stroke="currentColor" strokeWidth="1.2" transform="rotate(-24 14 14)" />
          </svg>
          <div>
            <b>Aspect Ratio Digital</b>
            <span>{selectedId ? 'Planet view' : 'System view'}</span>
          </div>
        </div>
        <Worlds />
      </header>

      <Caption />
      {selectedId && <Dossier key={selectedId} id={selectedId} />}
      <Warp warp={warp} />
      <Transmission claude={claude} />
    </div>
  )
}

function Worlds() {
  const selectedId = useApp((s) => s.selectedId)
  const hoveredId = useApp((s) => s.hoveredId)
  const select = useApp((s) => s.select)
  const hover = useApp((s) => s.hover)
  return (
    <nav className="ob-worlds" aria-label="Planets">
      {PLANETS.map((p) => (
        <button
          key={p.site.id}
          aria-current={selectedId === p.site.id}
          data-hot={hoveredId === p.site.id}
          onClick={() => select(p.site.id)}
          onPointerEnter={() => hover(p.site.id)}
          onPointerLeave={() => hover(null)}
          title={p.site.name}
          style={{ ['--c' as string]: p.site.brand.accent, ['--s' as string]: `${6 + p.size * 16}px` }}
        >
          <i />
          <span>{p.site.name}</span>
        </button>
      ))}
    </nav>
  )
}

function Caption() {
  const selectedId = useApp((s) => s.selectedId)
  const site = siteById(selectedId)
  const select = useApp((s) => s.select)
  if (site) {
    const rank = [...SITES].sort((a, b) => b.visitors7d - a.visitors7d).findIndex((s) => s.id === site.id) + 1
    return (
      <section className="ob-caption" key={site.id}>
        <button className="ob-back" onClick={() => select(null)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M9 2 4 7l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Back to the system
        </button>
        <h1>{site.name}</h1>
        <p>
          {site.domain}. <span data-status={site.status}>{STATUS_LABEL[site.status]}</span>, built with {site.framework}.
        </p>
        <dl>
          <div>
            <dt>Traffic rank</dt>
            <dd>{rank}</dd>
          </div>
          <div>
            <dt>Moons (branches)</dt>
            <dd>{site.branches}</dd>
          </div>
          <div>
            <dt>Open PRs</dt>
            <dd>{site.openPRs}</dd>
          </div>
          <div>
            <dt>Visitors, 7 days</dt>
            <dd>{site.visitors7d.toLocaleString()}</dd>
          </div>
        </dl>
      </section>
    )
  }
  return (
    <section className="ob-caption">
      <h1>
        <CountUp value={SITES.length} duration={900} /> worlds,
        <br />
        <CountUp value={totals.visitors7d} duration={2200} /> visitors
      </h1>
      <p>
        Planet size is traffic, moons are branches and rings mark three or more open pull requests. Drag to look around, scroll to
        zoom, click a planet to fly to it.
      </p>
    </section>
  )
}

function Dossier({ id }: { id: string }) {
  const site = siteById(id)!
  return (
    <aside className="ob-dossier">
      <SitePreview site={site} className="ob-preview" />
      <h2>Recent commits</h2>
      <ul>
        {site.commits.map((c) => (
          <li key={c.sha}>
            <span>{c.message}</span>
            <small>
              {c.author}, {c.ago} ago
            </small>
          </li>
        ))}
      </ul>
      <div className="ob-actions">
        <a href={`https://github.com/${site.repo}`} target="_blank" rel="noreferrer">
          Open repo
        </a>
        <a href={`http://localhost:${site.port}`} target="_blank" rel="noreferrer">
          localhost:{site.port}
        </a>
      </div>
    </aside>
  )
}

function Warp({ warp }: { warp: React.MutableRefObject<number> }) {
  const [v, setV] = useState(1)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    warp.current = paused ? 0 : v
  }, [v, paused, warp])
  return (
    <div className="ob-warp">
      <button onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Resume orbits' : 'Pause orbits'}>
        {paused ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 1l9 5-9 5z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor" />
          </svg>
        )}
      </button>
      <label>
        <span>Orbit speed</span>
        <input type="range" min={0.1} max={8} step={0.1} value={v} onChange={(e) => setV(+e.target.value)} />
        <output>{v.toFixed(1)}×</output>
      </label>
    </div>
  )
}

function Transmission({ claude }: { claude: ReturnType<typeof useClaude> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages, open])
  return (
    <div className="ob-tx" data-open={open} data-speaking={claude.speaking}>
      {open && (
        <div className="ob-tx-card">
          <div className="ob-tx-log" ref={log}>
            {claude.messages.map((m) => (
              <p key={m.id} data-role={m.role}>
                <b>{m.role === 'claude' ? 'Claude' : 'You'}</b>
                {m.text}
              </p>
            ))}
          </div>
          <div className="ob-tx-sugg">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => claude.send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!open) setOpen(true)
          claude.send(text)
          setText('')
        }}
      >
        <button type="button" className="ob-tx-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Toggle conversation">
          <span className="ob-tx-sun" />
        </button>
        <input
          value={text}
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask Claude"
          aria-label="Message Claude"
        />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
