import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project, StudioElement, StudioSite } from '../data/types'
import { useData } from '../data/store'
import { relTime } from '../data/derive'
import { useApp } from '../store'
import { Icon } from './icons'
import './studio.css'

// Studio, the visual site builder. Every website opens from Studio's own copy
// of its repo, synced to the latest commit on GitHub and served on this
// computer (server/studio.ts), in a canvas you can size to any screen.
// Select mode outlines what's under the pointer and shows what you click.

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'

export interface Size {
  w: number
  h: number
}

export const PRESETS = [
  { id: 'mobile', label: 'Mobile', icon: Icon.mobile, w: 390, h: 844 },
  { id: 'tablet', label: 'Tablet', icon: Icon.tablet, w: 820, h: 1180 },
  { id: 'laptop', label: 'Laptop', icon: Icon.desktop, w: 1440, h: 900 },
] as const
type PresetId = (typeof PRESETS)[number]['id'] | 'custom'
type Zoom = 'fit' | 0.5 | 0.75 | 1

interface View {
  preset: PresetId
  custom: Size
  /** turned sideways (landscape phone, portrait laptop) */
  turned: boolean
  zoom: Zoom
  /** a second canvas beside the first, at another size */
  compare: PresetId | null
}

const VIEW_KEY = 'ard.studio.view'
const DEFAULT_VIEW: View = { preset: 'laptop', custom: { w: 1280, h: 720 }, turned: false, zoom: 'fit', compare: null }

function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')
    return v && typeof v === 'object' ? { ...DEFAULT_VIEW, ...v } : DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
  }
}

function saveView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

export function sizeOf(preset: PresetId, custom: Size, turned: boolean): Size {
  const base = preset === 'custom' ? custom : (PRESETS.find((p) => p.id === preset) ?? PRESETS[2])
  return turned ? { w: base.h, h: base.w } : { w: base.w, h: base.h }
}

/** "16:9", "16/9", "1.78" or "21 x 9" → width ÷ height */
export function parseRatio(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(?:[:/x×]\s*(\d+(?:\.\d+)?))?$/i)
  if (!m) return null
  const r = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])
  return Number.isFinite(r) && r > 0.1 && r < 10 ? r : null
}

const clampPx = (n: number) => Math.max(240, Math.min(3840, Math.round(n) || 0))

const isSite = (p: Project) => (p.kind ?? 'site') !== 'app'

// --- Server state -------------------------------------------------------------------------

function useStudioSite(projectId: string | null) {
  const [site, setSite] = useState<StudioSite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useData((s) => s.mode === 'live')

  const open = useCallback(
    async (sync = false) => {
      if (!projectId || !live) return
      setError(null)
      try {
        const r = await fetch('./api/studio/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, sync }) })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? 'Studio couldn’t open this site')
        setSite(d)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [projectId, live],
  )

  useEffect(() => {
    setSite(null)
    void open()
  }, [open])

  // poll quickly while it's getting ready, slowly once it is
  const settled = site && ['ready', 'unsupported', 'error'].includes(site.status)
  useEffect(() => {
    if (!projectId || !live) return
    const t = setInterval(
      async () => {
        try {
          const r = await fetch(`./api/studio?project=${encodeURIComponent(projectId)}`)
          if (r.ok) setSite(await r.json())
        } catch {
          /* the next poll will try again */
        }
      },
      settled ? 15_000 : 1000,
    )
    return () => clearInterval(t)
  }, [projectId, live, settled])

  return { site, error, open }
}

// --- Studio -------------------------------------------------------------------------------

export function Studio() {
  const studio = useApp((s) => s.studio)
  if (!studio) return null
  return <StudioView projectId={studio.projectId} />
}

function StudioView({ projectId }: { projectId: string }) {
  const projects = useData((s) => s.projects)
  const mode = useData((s) => s.mode)
  const openStudio = useApp((s) => s.openStudio)
  const close = useApp((s) => s.closeStudio)
  const sites = useMemo(() => projects.filter(isSite).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const project = projects.find((p) => p.id === projectId) ?? null
  const { site, error, open } = useStudioSite(projectId)

  const [view, setViewState] = useState<View>(loadView)
  const setView = (patch: Partial<View>) =>
    setViewState((v) => {
      const next = { ...v, ...patch }
      saveView(next)
      return next
    })
  const [path, setPath] = useState('/')
  const [nav, setNav] = useState<{ path: string; nonce: number }>({ path: '/', nonce: 0 })
  const [tool, setTool] = useState<'browse' | 'select'>('browse')
  const [selected, setSelected] = useState<StudioElement | null>(null)
  const frames = useRef<(HTMLIFrameElement | null)[]>([])

  useEffect(() => {
    setPath('/')
    setNav({ path: '/', nonce: 0 })
    setSelected(null)
  }, [projectId])

  const origin = site?.port ? `http://127.0.0.1:${site.port}` : null
  const ready = site?.status === 'ready' && !!origin

  const tell = useCallback((msg: Record<string, unknown>) => {
    for (const f of frames.current) f?.contentWindow?.postMessage({ studio: true, ...msg }, '*')
  }, [])

  // messages from the overlay inside the canvas
  useEffect(() => {
    if (!origin) return
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || !e.data || e.data.studio !== true) return
      const d = e.data as { type: string; path?: string; element?: StudioElement | null }
      if (d.type === 'ready') (e.source as Window | null)?.postMessage({ studio: true, type: 'mode', mode: tool }, origin)
      if (d.type === 'page' && d.path) setPath(d.path)
      if (d.type === 'select') setSelected(d.element ?? null)
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [origin, tool])

  useEffect(() => {
    tell({ type: 'mode', mode: tool })
    if (tool === 'browse') {
      tell({ type: 'clear' })
      setSelected(null)
    }
  }, [tool, tell])

  // keyboard: V select, H browse, Esc steps back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'v' || e.key === 'V') setTool('select')
      if (e.key === 'h' || e.key === 'H') setTool('browse')
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (selected) {
          setSelected(null)
          tell({ type: 'clear' })
        } else if (tool === 'select') setTool('browse')
        else close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, tool, tell, close])

  const go = (p: string) => {
    setPath(p)
    setNav((n) => ({ path: p, nonce: n.nonce + 1 }))
    setSelected(null)
  }

  const main = sizeOf(view.preset, view.custom, view.turned)
  const second = view.compare ? sizeOf(view.compare, view.custom, false) : null
  const src = ready ? `${origin}${nav.path}` : null

  return (
    <div className="studio" role="dialog" aria-label={`Studio: ${project?.name ?? 'site'}`}>
      <header className="st-bar">
        <span className="st-logo">
          <Icon.studio size={18} /> Studio
        </span>
        <select className="st-site" value={projectId} onChange={(e) => openStudio(e.target.value)} aria-label="Site">
          {sites.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <PagePicker pages={site?.pages ?? []} path={path} onGo={go} disabled={!ready} />

        <div className="st-gap" />

        <div className="st-seg" role="group" aria-label="Screen size">
          {PRESETS.map((p) => (
            <button key={p.id} aria-pressed={view.preset === p.id} onClick={() => setView({ preset: p.id })} title={`${p.label} · ${p.w} × ${p.h}`}>
              <p.icon size={15} /> <span>{p.label}</span>
            </button>
          ))}
          <button aria-pressed={view.preset === 'custom'} onClick={() => setView({ preset: 'custom' })} title="Your own size or ratio">
            <Icon.expand size={14} /> <span>Custom</span>
          </button>
        </div>
        {view.preset === 'custom' && <CustomSize size={view.custom} onChange={(custom) => setView({ custom })} />}
        <button className="st-btn" aria-pressed={view.turned} onClick={() => setView({ turned: !view.turned })} title="Turn sideways">
          <Icon.rotate size={17} />
        </button>
        <select className="st-zoom" value={String(view.zoom)} onChange={(e) => setView({ zoom: e.target.value === 'fit' ? 'fit' : (Number(e.target.value) as Zoom) })} aria-label="Zoom">
          <option value="fit">Fit</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
        </select>
        <button className="st-btn" aria-pressed={!!view.compare} onClick={() => setView({ compare: view.compare ? null : view.preset === 'mobile' ? 'laptop' : 'mobile' })} title="Compare two sizes side by side">
          <Icon.columns size={17} />
        </button>

        <div className="st-gap" />

        <div className="st-seg" role="group" aria-label="Tool">
          <button aria-pressed={tool === 'browse'} onClick={() => setTool('browse')} title="Browse: use the site normally (H)">
            <Icon.hand size={15} /> <span>Browse</span>
          </button>
          <button aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Select: click any element to inspect it (V)">
            <Icon.pointer size={15} /> <span>Select</span>
          </button>
        </div>
        <button className="st-btn" onClick={() => void open(true)} title="Get the latest from GitHub" disabled={!site || !['ready', 'error', 'unsupported'].includes(site.status)}>
          <Icon.refresh size={17} />
        </button>
        {src && (
          <a className="st-btn" href={`${origin}${path}`} target="_blank" rel="noreferrer" title="Open this preview in your browser">
            <Icon.external size={17} />
          </a>
        )}
        <button className="st-btn st-close" onClick={close} title="Close Studio (Esc)">
          <Icon.close size={18} />
        </button>
      </header>

      <StatusLine site={site} project={project} error={error} demo={mode !== 'live'} />

      <div className="st-main">
        <Canvas
          src={src}
          nonce={nav.nonce}
          sizes={second ? [main, second] : [main]}
          labels={second ? [labelFor(view.preset, view.turned), labelFor(view.compare!, false)] : [labelFor(view.preset, view.turned)]}
          zoom={view.zoom}
          frames={frames}
          fallback={<Placeholder site={site} project={project} error={error} demo={mode !== 'live'} />}
          onSecond={second ? (id) => setView({ compare: id }) : undefined}
          secondId={view.compare}
          title={project?.name ?? 'Site'}
        />
        {selected && (
          <Inspector
            el={selected}
            onClose={() => {
              setSelected(null)
              tell({ type: 'clear' })
            }}
            onReveal={() => tell({ type: 'reveal', selector: selected.selector })}
          />
        )}
      </div>
    </div>
  )
}

const labelFor = (id: PresetId, turned: boolean) => `${id === 'custom' ? 'Custom' : PRESETS.find((p) => p.id === id)!.label}${turned ? ' · sideways' : ''}`

// --- Page picker --------------------------------------------------------------------------

function PagePicker({ pages, path, onGo, disabled }: { pages: StudioSite['pages']; path: string; onGo: (p: string) => void; disabled: boolean }) {
  const [typed, setTyped] = useState(path)
  useEffect(() => setTyped(path), [path])
  const listId = 'st-pages'
  const known = pages.some((p) => p.path === path)
  return (
    <form
      className="st-page"
      onSubmit={(e) => {
        e.preventDefault()
        const p = typed.trim() || '/'
        onGo(p.startsWith('/') ? p : `/${p}`)
      }}
    >
      <select
        value={known ? path : ''}
        onChange={(e) => e.target.value && onGo(e.target.value)}
        disabled={disabled || !pages.length}
        aria-label="Page"
      >
        {!known && <option value="">{path}</option>}
        {pages.map((p) => (
          <option key={p.path} value={p.path}>
            {p.path === '/' ? 'Home' : p.path}
            {p.title && p.path !== '/' ? `  ·  ${p.title}` : ''}
          </option>
        ))}
      </select>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} list={listId} aria-label="Page address" disabled={disabled} spellCheck={false} />
      <datalist id={listId}>
        {pages.map((p) => (
          <option key={p.path} value={p.path} />
        ))}
      </datalist>
    </form>
  )
}

// --- Custom size --------------------------------------------------------------------------

function CustomSize({ size, onChange }: { size: Size; onChange: (s: Size) => void }) {
  const [w, setW] = useState(String(size.w))
  const [h, setH] = useState(String(size.h))
  const [ratio, setRatio] = useState('')
  useEffect(() => {
    setW(String(size.w))
    setH(String(size.h))
  }, [size.w, size.h])
  const commit = () => onChange({ w: clampPx(Number(w)), h: clampPx(Number(h)) })
  const applyRatio = (s: string) => {
    const r = parseRatio(s)
    if (r) onChange({ w: size.w, h: clampPx(size.w / r) })
  }
  return (
    <div className="st-custom">
      <input value={w} onChange={(e) => setW(e.target.value.replace(/\D/g, ''))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} aria-label="Width in pixels" inputMode="numeric" />
      <span>×</span>
      <input value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, ''))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} aria-label="Height in pixels" inputMode="numeric" />
      <input
        className="st-ratio"
        value={ratio}
        placeholder="ratio"
        onChange={(e) => setRatio(e.target.value)}
        onBlur={() => applyRatio(ratio)}
        onKeyDown={(e) => e.key === 'Enter' && applyRatio(ratio)}
        aria-label="Aspect ratio, like 16:9"
        title="Type a ratio like 16:9, 21:9 or 4:5 to set the height from the width"
        list="st-ratios"
      />
      <datalist id="st-ratios">
        {['16:9', '16:10', '21:9', '4:3', '3:2', '1:1', '4:5', '9:16', '9:19.5'].map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </div>
  )
}

// --- Canvas -------------------------------------------------------------------------------

function Canvas({
  src,
  nonce,
  sizes,
  labels,
  zoom,
  frames,
  fallback,
  onSecond,
  secondId,
  title,
}: {
  src: string | null
  nonce: number
  sizes: Size[]
  labels: string[]
  zoom: Zoom
  frames: React.MutableRefObject<(HTMLIFrameElement | null)[]>
  fallback: React.ReactNode
  onSecond?: (id: PresetId) => void
  secondId: PresetId | null
  title: string
}) {
  const area = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ w: 800, h: 600 })
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // one scale for every canvas, so two sizes side by side stay true to each other
  const GAP = 40
  const PAD = 56
  const LABEL = 28
  const fit = Math.min((room.w - PAD - GAP * (sizes.length - 1)) / sizes.reduce((n, s) => n + s.w, 0), (room.h - PAD - LABEL) / Math.max(...sizes.map((s) => s.h)), 1)
  const scale = zoom === 'fit' ? Math.max(0.1, fit) : zoom

  return (
    <div className="st-canvas" ref={area} data-zoomed={zoom !== 'fit' || undefined}>
      {src ? (
        <div className="st-frames" style={{ gap: GAP }}>
          {sizes.map((s, i) => (
            <figure key={i} className="st-frame" style={{ width: s.w * scale }}>
              <figcaption>
                {i === 1 && onSecond ? (
                  <select value={secondId ?? 'mobile'} onChange={(e) => onSecond(e.target.value as PresetId)} aria-label="Second size">
                    {PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                ) : (
                  <b>{labels[i]}</b>
                )}
                <span>
                  {s.w} × {s.h}
                </span>
                <span className="st-pct">{Math.round(scale * 100)}%</span>
              </figcaption>
              <div className="st-screen" style={{ width: s.w * scale, height: s.h * scale }}>
                <iframe
                  key={`${src}-${nonce}`}
                  ref={(el) => {
                    frames.current[i] = el
                  }}
                  title={`${title} at ${s.w} by ${s.h}`}
                  src={src}
                  sandbox={SANDBOX}
                  style={{ width: s.w, height: s.h, transform: `scale(${scale})` }}
                />
              </div>
            </figure>
          ))}
        </div>
      ) : (
        fallback
      )}
    </div>
  )
}

// --- Status -------------------------------------------------------------------------------

const BUSY: StudioSite['status'][] = ['idle', 'syncing', 'installing', 'building', 'starting']

function StatusLine({ site, project, error, demo }: { site: StudioSite | null; project: Project | null; error: string | null; demo: boolean }) {
  if (demo) return <div className="st-status">Demo data: connect GitHub in Settings to open your real sites in Studio.</div>
  if (error) return <div className="st-status" data-tone="bad">{error}</div>
  if (!site) return <div className="st-status" data-tone="busy"><i className="st-spin" /> Opening {project?.name ?? 'the site'}…</div>
  if (BUSY.includes(site.status)) return <div className="st-status" data-tone="busy"><i className="st-spin" /> {site.message || 'Getting ready…'}</div>
  if (site.status === 'error') return <div className="st-status" data-tone="bad">{site.message}</div>
  return (
    <div className="st-status">
      {site.sha ? (
        <>
          <Icon.branch size={13} />
          <span>
            Latest on <b>{site.branch}</b>
          </span>
          <code>{site.sha.slice(0, 7)}</code>
          <span className="st-commit">{site.commit}</span>
          {site.committed && <span className="st-ago">{relTime(site.committed)}</span>}
          <span className="st-kind">{KIND_LABEL[site.kind]}</span>
          {site.changed.length > 0 && <span className="st-changed">{site.changed.length} unpublished change{site.changed.length === 1 ? '' : 's'}</span>}
        </>
      ) : (
        site.message
      )}
    </div>
  )
}

const KIND_LABEL: Record<StudioSite['kind'], string> = {
  static: 'Static site',
  generated: 'Built from data files',
  astro: 'Astro',
  shopify: 'Shopify theme',
  app: 'App',
  unknown: 'Unknown',
}

function Placeholder({ site, project, error, demo }: { site: StudioSite | null; project: Project | null; error: string | null; demo: boolean }) {
  if (demo) return <div className="st-empty">Connect GitHub in Settings and your sites appear here.</div>
  if (site?.status === 'unsupported') {
    return (
      <div className="st-empty">
        <p>{site.message}</p>
        {project?.url && (
          <a className="st-pill" href={project.url} target="_blank" rel="noreferrer">
            Open {project.name} <Icon.external size={13} />
          </a>
        )}
      </div>
    )
  }
  if (error || site?.status === 'error') return <div className="st-empty" data-tone="bad"><p>{error ?? site?.message}</p></div>
  return (
    <div className="st-empty">
      <i className="st-spin st-spin-lg" />
      <p>{site?.message || `Opening ${project?.name ?? 'the site'}`}</p>
      <small>Studio works from its own copy of each repo, synced to the latest commit on GitHub.</small>
    </div>
  )
}

// --- Inspector ----------------------------------------------------------------------------

function Inspector({ el, onClose, onReveal }: { el: StudioElement; onClose: () => void; onReveal: () => void }) {
  return (
    <aside className="st-inspector" aria-label="Selected element">
      <header>
        <b>{el.label}</b>
        <button className="st-btn" onClick={onClose} title="Deselect (Esc)">
          <Icon.close size={15} />
        </button>
      </header>
      {el.image && (
        <figure className="st-img">
          <img src={el.image.src} alt={el.image.alt} />
          <figcaption>
            {el.image.width} × {el.image.height} · {el.image.src.split('/').pop()?.split('?')[0]}
          </figcaption>
        </figure>
      )}
      {el.text && !el.image && <p className="st-text">{el.text.length > 400 ? `${el.text.slice(0, 400)}…` : el.text}</p>}
      <dl>
        {el.image?.alt !== undefined && el.image && (
          <>
            <dt>Alt text</dt>
            <dd>{el.image.alt || <em>missing</em>}</dd>
          </>
        )}
        {el.href && (
          <>
            <dt>Links to</dt>
            <dd>{el.href}</dd>
          </>
        )}
        <dt>Size</dt>
        <dd>
          {el.rect.w} × {el.rect.h}
        </dd>
        <dt>Type</dt>
        <dd>{el.style.font}</dd>
        <dt>Colour</dt>
        <dd>
          <Swatch c={el.style.color} /> {el.style.color}
        </dd>
        {el.style.background !== 'rgba(0, 0, 0, 0)' && (
          <>
            <dt>Background</dt>
            <dd>
              <Swatch c={el.style.background} /> {el.style.background}
            </dd>
          </>
        )}
        <dt>Padding</dt>
        <dd>{el.style.padding}</dd>
        <dt>Margin</dt>
        <dd>{el.style.margin}</dd>
      </dl>
      <button className="st-pill" onClick={onReveal}>
        Scroll to it
      </button>
      <code className="st-selector" title="Where it is in the page">
        {el.selector}
      </code>
    </aside>
  )
}

const Swatch = ({ c }: { c: string }) => <i className="st-swatch" style={{ background: c }} />
