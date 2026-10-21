import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { useAdaptiveDpr } from '../../shared/Adaptive'
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from '@react-three/postprocessing'
import { Vector2 } from 'three'
import { JarvisScene, STATUS_COLOR } from './Scene'
import { PROJECTS, SITES, STATUS_LABEL, siteById, totals } from '../../data/mock'
import { useApp } from '../../store'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import { CountUp, Gauge, Sparkline, useClock, usePointer, useTilt } from '../../shared/bits'
import { SitePreview } from '../../shared/SitePreview'
import { LabelLayer } from '../../shared/Labels'
import './jarvis.css'

const caOffset = new Vector2(0.0006, 0.0004)

export default function Jarvis() {
  const [dpr, monitor] = useAdaptiveDpr(2)
  const selectedId = useApp((s) => s.selectedId)
  const pointer = usePointer()
  const claude = useClaude(selectedId)

  return (
    <div className="jv">
      <Canvas
        className="jv-canvas"
        dpr={dpr}
        camera={{ position: [0, 1.3, 12.5], fov: 42 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        onPointerMissed={() => useApp.getState().select(null)}
      >
        {monitor}
        <JarvisScene level={claude.level} pointer={pointer} />
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.3} />
          <ChromaticAberration offset={caOffset} radialModulation={false} modulationOffset={0} />
          <Vignette darkness={0.7} offset={0.25} />
        </EffectComposer>
      </Canvas>

      <LabelLayer>
        {SITES.map((s) => (
          <NodeLabel key={s.id} id={s.id} />
        ))}
      </LabelLayer>
      <div className="jv-scan" aria-hidden />
      <Corners />

      <div className="jv-hud">
        <TopBar />
        <aside className="jv-col jv-left">
          <Fleet />
          <Telemetry />
        </aside>
        <aside className="jv-col jv-right">{selectedId ? <Detail key={selectedId} id={selectedId} /> : <Projects />}</aside>
        <Console claude={claude} />
      </div>
    </div>
  )
}

function NodeLabel({ id }: { id: string }) {
  const site = siteById(id)!
  const active = useApp((s) => s.hoveredId === id || s.selectedId === id)
  return (
    <div id={`lbl-jv-${id}`}>
      <div className="jv-label" data-active={active} data-status={site.status}>
        <b>{site.name}</b>
        <span>{site.domain}</span>
      </div>
    </div>
  )
}

function Corners() {
  return (
    <div className="jv-corners" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </div>
  )
}

function TopBar() {
  const now = useClock()
  return (
    <header className="jv-top">
      <div className="jv-brand">
        <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
          <path d="M15 2 27 9v12l-12 7L3 21V9z" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M15 8 21 11.5v7L15 22l-6-3.5v-7z" fill="currentColor" opacity=".35" />
        </svg>
        <div>
          <b>Nexus</b>
          <span>Aspect Ratio Digital</span>
        </div>
      </div>
      <div className="jv-clock">
        <b>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b>
        <span>{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
    </header>
  )
}

function Panel({ title, meta, children, className = '' }: { title: string; meta?: string; children: React.ReactNode; className?: string }) {
  const ref = useTilt<HTMLElement>(5)
  return (
    <section className={`jv-panel ${className}`} ref={ref}>
      <header>
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </header>
      {children}
    </section>
  )
}

function Fleet() {
  const hoveredId = useApp((s) => s.hoveredId)
  const selectedId = useApp((s) => s.selectedId)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  return (
    <Panel title="Sites" meta={`${SITES.length} linked`}>
      <ul className="jv-fleet">
        {SITES.map((s, i) => (
          <li key={s.id} style={{ ['--i' as string]: i, ['--c' as string]: STATUS_COLOR[s.status] }}>
            <button
              data-hot={hoveredId === s.id}
              aria-current={selectedId === s.id}
              onPointerEnter={() => hover(s.id)}
              onPointerLeave={() => hover(null)}
              onFocus={() => hover(s.id)}
              onBlur={() => hover(null)}
              onClick={() => select(selectedId === s.id ? null : s.id)}
            >
              <i className="jv-dot" data-status={s.status} />
              <span className="jv-fleet-name">{s.name}</span>
              <Sparkline data={s.traffic} width={56} height={16} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Telemetry() {
  const avgUptime = SITES.reduce((a, s) => a + s.uptime, 0) / SITES.length
  return (
    <Panel title="Telemetry" meta="last 7 days" className="jv-tele">
      <div className="jv-big">
        <b>
          <CountUp value={totals.visitors7d} duration={2200} />
        </b>
        <span>visitors across every site</span>
      </div>
      <dl className="jv-stats">
        <div>
          <dt>Pull requests</dt>
          <dd>
            <CountUp value={totals.openPRs} />
          </dd>
        </div>
        <div>
          <dt>Avg uptime</dt>
          <dd>
            <CountUp value={avgUptime} decimals={2} />%
          </dd>
        </div>
        <div>
          <dt>Building</dt>
          <dd className="amber">{totals.building}</dd>
        </div>
        <div>
          <dt>Attention</dt>
          <dd className="red">{totals.attention}</dd>
        </div>
      </dl>
    </Panel>
  )
}

function Projects() {
  const select = useApp((s) => s.select)
  return (
    <Panel title="Claude sessions" meta={`${PROJECTS.length} active`}>
      <ul className="jv-projects">
        {PROJECTS.map((p, i) => (
          <li key={p.id} style={{ ['--i' as string]: i }}>
            <button onClick={() => select(p.siteId)}>
              <span className="jv-kind" data-kind={p.kind}>
                {p.kind === 'Claude Code' ? <CodeGlyph /> : <DocGlyph />}
              </span>
              <span>
                <b>{p.title}</b>
                <small>{p.summary}</small>
              </span>
              <time>{p.updated}</time>
            </button>
          </li>
        ))}
      </ul>
      <p className="jv-hint">Select a node or a session to open its site.</p>
    </Panel>
  )
}

function Detail({ id }: { id: string }) {
  const site = siteById(id)!
  const select = useApp((s) => s.select)
  return (
    <Panel title={site.name} meta={STATUS_LABEL[site.status]} className={`jv-detail is-${site.status}`}>
      <button className="jv-close" onClick={() => select(null)} aria-label="Close">
        ×
      </button>
      <div className="jv-detail-head">
        <Gauge value={site.lighthouse} size={58} label={`Lighthouse ${site.lighthouse}`} />
        <dl>
          <div>
            <dt>Repo</dt>
            <dd>{site.repo.split('/')[1]}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{site.branch}</dd>
          </div>
          <div>
            <dt>Stack</dt>
            <dd>{site.framework}</dd>
          </div>
        </dl>
      </div>
      <div className="jv-detail-row">
        <span>
          <b>{site.visitors7d.toLocaleString()}</b> visitors
        </span>
        <span>
          <b>{site.uptime}%</b> up
        </span>
        <span>
          <b>{site.openPRs}</b> PRs
        </span>
      </div>
      <SitePreview site={site} className="jv-preview" />
      <ul className="jv-commits">
        {site.commits.map((c) => (
          <li key={c.sha}>
            <code>{c.sha}</code>
            <span>{c.message}</span>
            <time>{c.ago}</time>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Console({ claude }: { claude: ReturnType<typeof useClaude> }) {
  const [text, setText] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages])
  return (
    <section className="jv-console" data-speaking={claude.speaking}>
      <div className="jv-wave" aria-hidden>
        {Array.from({ length: 24 }, (_, i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>
      <div className="jv-log" ref={log} aria-live="polite">
        {claude.messages.map((m) => (
          <p key={m.id} data-role={m.role}>
            <span>{m.role === 'claude' ? 'Claude' : 'You'}</span>
            {m.text}
            {m.streaming && <i className="jv-caret" />}
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
        <span aria-hidden>›</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Claude about any site" aria-label="Message Claude" />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <div className="jv-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => claude.send(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}

const CodeGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
)
const DocGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M3 2h7l3 3v9H3z M10 2v3h3 M5.5 8h5 M5.5 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)
