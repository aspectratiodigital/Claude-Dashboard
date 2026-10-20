import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { HelixScene, HX_STATUS } from './Scene'
import { PROJECTS, SITES, STATUS_LABEL, siteById } from '../../data/mock'
import { useApp } from '../../store'
import { usePointer, Sparkline, useClock } from '../../shared/bits'
import { SitePreview } from '../../shared/SitePreview'
import { useClaude, SUGGESTIONS } from '../../shared/useClaude'
import './helix.css'

export default function Helix() {
  const pointer = usePointer()
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const scroll = useRef(0)
  const target = useRef(0)
  const [focus, setFocus] = useState(0)
  const idle = useRef<number | undefined>(undefined)

  const go = useCallback((i: number) => {
    target.current = Math.max(0, Math.min(SITES.length - 1, i))
  }, [])

  // Smooth scroll: wheel/drag set a target, the frame loop eases toward it,
  // and the helix snaps to the nearest card once input stops.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      scroll.current += (target.current - scroll.current) * Math.min(1, dt * 6)
      const f = Math.round(scroll.current)
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
      if ((e.target as HTMLElement).closest('.hx-drawer, .palette')) return
      target.current = Math.max(-0.35, Math.min(SITES.length - 0.65, target.current + e.deltaY * 0.0022))
      snap()
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input')) return
      if (e.key === 'ArrowDown' || e.key === 'j') go(Math.round(target.current) + 1)
      if (e.key === 'ArrowUp' || e.key === 'k') go(Math.round(target.current) - 1)
      if (e.key === 'Enter') useApp.getState().select(SITES[Math.round(target.current)].id)
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
      if (dragY !== null) target.current = Math.round(Math.max(0, Math.min(SITES.length - 1, target.current)))
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

  // Opening a site elsewhere (palette) scrolls the helix to it.
  useEffect(() => {
    const i = SITES.findIndex((s) => s.id === selectedId)
    if (i >= 0) go(i)
  }, [selectedId, go])

  const onPick = useCallback(
    (i: number) => {
      if (i === Math.round(target.current)) select(SITES[i].id)
      else go(i)
    },
    [go, select],
  )

  const site = SITES[Math.max(0, Math.min(SITES.length - 1, focus))]

  return (
    <div className="hx" data-drawer={!!selectedId}>
      <Canvas
        className="hx-canvas"
        dpr={[1, 1.75]}
        flat
        camera={{ position: [-1.9, 0, 15], fov: 38 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <HelixScene scroll={scroll} pointer={pointer} onPick={onPick} drawer={!!selectedId} />
      </Canvas>

      <header className="hx-top">
        <div className="hx-mark">
          <Mark />
          <span>Aspect Ratio Digital</span>
        </div>
        <Greeting />
      </header>

      <section className="hx-hero" aria-live="polite">
        <p className="hx-count">
          {String(focus + 1).padStart(2, '0')} of {String(SITES.length).padStart(2, '0')}
        </p>
        <h1 key={site.id}>
          {site.name.split(' ').map((w, i) => (
            <span key={i} style={{ ['--i' as string]: i }}>
              {w}
            </span>
          ))}
        </h1>
        <div className="hx-meta" key={`m-${site.id}`}>
          <span className="hx-pill" style={{ ['--c' as string]: HX_STATUS[site.status] }}>
            {STATUS_LABEL[site.status]}
          </span>
          <span>{site.framework}</span>
          <span>{site.branch}</span>
        </div>
        <p className="hx-tag" key={`t-${site.id}`}>
          {site.client.replace(/\.$/, '')}. {site.commits[0].message}, {site.commits[0].ago} ago.
        </p>
        <div className="hx-actions">
          <button className="hx-btn primary" onClick={() => select(site.id)}>
            Open workspace
          </button>
          <a className="hx-btn" href={`https://github.com/${site.repo}`} target="_blank" rel="noreferrer">
            View repo
          </a>
        </div>
      </section>

      <nav className="hx-rail" aria-label="Sites">
        {SITES.map((s, i) => (
          <button key={s.id} aria-current={i === focus} onClick={() => go(i)} style={{ ['--c' as string]: HX_STATUS[s.status] }}>
            <span>{s.name}</span>
            <i />
          </button>
        ))}
      </nav>

      <p className="hx-hint">Scroll or drag to move through your sites. Click the front card to open it.</p>

      <Drawer />
    </div>
  )
}

function Greeting() {
  const now = useClock()
  const h = now.getHours()
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
  return (
    <p className="hx-greet">
      Good {part}, Dylan. {PROJECTS.length} Claude sessions are open.
    </p>
  )
}

function Drawer() {
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const site = siteById(selectedId)
  const [tab, setTab] = useState<'preview' | 'claude' | 'activity'>('preview')
  const claude = useClaude(selectedId)
  const [text, setText] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [claude.messages, tab])

  return (
    <aside className="hx-drawer" aria-hidden={!site} data-open={!!site}>
      {site && (
        <>
          <header>
            <div>
              <h2>{site.name}</h2>
              <a href={`https://${site.domain}`} target="_blank" rel="noreferrer">
                {site.domain}
              </a>
            </div>
            <button className="hx-x" onClick={() => select(null)} aria-label="Close workspace">
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          </header>
          <div className="hx-tabs" role="tablist">
            {(['preview', 'claude', 'activity'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === 'preview' ? 'Preview' : t === 'claude' ? 'Ask Claude' : 'Activity'}
              </button>
            ))}
          </div>
          {tab === 'preview' && (
            <div className="hx-pane">
              <SitePreview site={site} className="hx-preview" />
              <dl className="hx-stats">
                <div>
                  <dt>Visitors this week</dt>
                  <dd>
                    {site.visitors7d.toLocaleString()} <Sparkline data={site.traffic} width={70} height={18} />
                  </dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{site.uptime}%</dd>
                </div>
                <div>
                  <dt>Lighthouse</dt>
                  <dd>{site.lighthouse}</dd>
                </div>
              </dl>
            </div>
          )}
          {tab === 'claude' && (
            <div className="hx-pane hx-chat">
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
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask about ${site.name}`} aria-label="Message Claude" />
                <button disabled={!text.trim()}>Send</button>
              </form>
            </div>
          )}
          {tab === 'activity' && (
            <div className="hx-pane">
              <ol className="hx-commits">
                {site.commits.map((c) => (
                  <li key={c.sha}>
                    <b>{c.message}</b>
                    <span>
                      {c.author} committed {c.sha} {c.ago} ago
                    </span>
                  </li>
                ))}
              </ol>
              <p className="hx-note">
                {site.openPRs} open pull request{site.openPRs === 1 ? '' : 's'} across {site.branches} branch{site.branches === 1 ? '' : 'es'}.
              </p>
            </div>
          )}
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
