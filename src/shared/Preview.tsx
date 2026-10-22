import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../data/types'
import { useData, useProject } from '../data/store'
import { hostOf } from '../data/derive'
import { useApp, type Device, type Source, type StageState } from '../store'
import { Icon } from './icons'
import './preview.css'

// Site previews. <DevicePair> shows a project big in a desktop and a phone
// frame side by side; clicking either opens <Stage>, a fullscreen view of the
// site in that device ratio. Live iframes in live mode, a drawn stand-in in demo.

const DESKTOP = { w: 1440, h: 900 }
// no allow-top-navigation: a site can't navigate the dashboard away
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'
const PHONE = { w: 390, h: 844 }

export function sourcesFor(p: Project): Source[] {
  const out: Source[] = []
  if (p.url) out.push('live')
  if (p.previewUrl && p.previewUrl !== p.url) out.push('preview')
  if (p.localPort) out.push('local')
  return out
}

export function urlFor(p: Project, source: Source, path = '/') {
  const base = source === 'live' ? p.url : source === 'preview' ? p.previewUrl : p.localPort ? `http://localhost:${p.localPort}` : null
  if (!base) return null
  try {
    return new URL(path || '/', base.replace(/\/?$/, '/')).href
  } catch {
    return base
  }
}

export const SOURCE_LABEL: Record<Source, string> = { live: 'Live', preview: 'Preview', local: 'Localhost' }

/** Open a fullscreen preview (call from a click so the browser allows fullscreen). */
export function enterStage(s: StageState) {
  useApp.getState().openStage(s)
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
}

/** div that behaves like a button (a real <button> can't contain an iframe) */
export const press = (fn: () => void) => ({
  role: 'button',
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  },
})

function useFit(ref: React.RefObject<HTMLElement | null>, w: number) {
  const [scale, setScale] = useState(0.25)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / w))
    ro.observe(el)
    setScale(el.clientWidth / w)
    return () => ro.disconnect()
  }, [ref, w])
  return scale
}

function Frame({ project, device, src }: { project: Project; device: Device; src: string | null }) {
  const box = useRef<HTMLDivElement>(null)
  const size = device === 'desktop' ? DESKTOP : PHONE
  const scale = useFit(box, size.w)
  const demo = useData((s) => s.mode !== 'live')
  return (
    <div className="pv-viewport" ref={box} style={{ aspectRatio: `${size.w} / ${size.h}` }}>
      <div className="pv-inner" style={{ width: size.w, height: size.h, transform: `scale(${scale})` }}>
        {src && !demo ? (
          <iframe title={`${project.name} ${device}`} src={src} loading="lazy" tabIndex={-1} sandbox={SANDBOX} />
        ) : (
          <MockSite project={project} device={device} />
        )}
      </div>
    </div>
  )
}

export function DevicePair({ project, className = '', compact = false }: { project: Project; className?: string; compact?: boolean }) {
  const sources = sourcesFor(project)
  const [source, setSource] = useState<Source>(sources[0] ?? 'live')
  const [path, setPath] = useState('/')
  useEffect(() => {
    setSource(sourcesFor(project)[0] ?? 'live')
    setPath('/')
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const src = urlFor(project, source, path)
  const open = (device: Device) => enterStage({ projectId: project.id, device, source, path })

  return (
    <div className={`pv ${compact ? 'pv-compact' : ''} ${className}`}>
      <div className="pv-bar">
        {sources.length > 1 && (
          <div className="pv-seg" role="group" aria-label="Which version">
            {sources.map((s) => (
              <button key={s} aria-pressed={s === source} onClick={() => setSource(s)}>
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        {project.pages.length > 1 && (
          <select className="pv-page" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Page">
            {project.pages.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
              </option>
            ))}
          </select>
        )}
        <span className="pv-url">{src ? hostOf(src) + (path !== '/' ? path : '') : 'No live URL yet'}</span>
        {src && (
          <a className="pv-icon" href={src} target="_blank" rel="noreferrer" title="Open in your browser">
            <Icon.external size={14} />
          </a>
        )}
      </div>
      <div className="pv-pair">
        <div className="pv-device pv-desktop" {...press(() => open('desktop'))} title="Fullscreen desktop view">
          <span className="pv-chrome">
            <i />
            <i />
            <i />
          </span>
          <Frame project={project} device="desktop" src={src} />
          <span className="pv-hint">
            <Icon.expand size={14} /> Desktop fullscreen
          </span>
        </div>
        <div className="pv-device pv-phone" {...press(() => open('mobile'))} title="Fullscreen mobile view">
          <span className="pv-notch" />
          <Frame project={project} device="mobile" src={src} />
          <span className="pv-hint">
            <Icon.expand size={14} /> Mobile
          </span>
        </div>
      </div>
      {!src && sources.length === 0 && <p className="pv-note">This project has no live URL yet. Add one in Settings, or set its localhost port, to preview the real site.</p>}
    </div>
  )
}

// --- Fullscreen stage ---------------------------------------------------------------------

export function Stage() {
  const stage = useApp((s) => s.stage)
  const close = useApp((s) => s.closeStage)
  const open = useApp((s) => s.openStage)
  const project = useProject(stage?.projectId ?? null)
  const [nonce, setNonce] = useState(0)
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  const demo = useData((s) => s.mode !== 'live')

  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  useEffect(() => {
    if (!stage && document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }, [stage])

  const src = useMemo(() => (project && stage ? urlFor(project, stage.source, stage.path) : null), [project, stage])
  if (!stage || !project) return null
  const set = (patch: Partial<StageState>) => open({ ...stage, ...patch })
  const sources = sourcesFor(project)
  const bar = 52
  const phoneScale = Math.min((vp.h - bar - 48) / PHONE.h, (vp.w - 48) / PHONE.w, 1.6)

  return (
    <div className="stage" data-device={stage.device} role="dialog" aria-label={`${project.name} preview`}>
      <header className="stage-bar">
        <span className="stage-dot" style={{ background: project.accent }} />
        <b>{project.name}</b>
        {project.pages.length > 1 && (
          <select value={stage.path} onChange={(e) => set({ path: e.target.value })} aria-label="Page">
            {project.pages.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
              </option>
            ))}
          </select>
        )}
        <span className="stage-url">{src ?? 'No URL'}</span>
        <div className="stage-seg" role="group" aria-label="Device">
          <button aria-pressed={stage.device === 'desktop'} onClick={() => set({ device: 'desktop' })}>
            <Icon.desktop size={15} /> Desktop
          </button>
          <button aria-pressed={stage.device === 'mobile'} onClick={() => set({ device: 'mobile' })}>
            <Icon.mobile size={15} /> Mobile
          </button>
        </div>
        {sources.length > 1 && (
          <div className="stage-seg" role="group" aria-label="Version">
            {sources.map((s) => (
              <button key={s} aria-pressed={s === stage.source} onClick={() => set({ source: s })}>
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <button className="stage-btn" onClick={() => setNonce((n) => n + 1)} title="Reload">
          <Icon.refresh size={16} />
        </button>
        {src && (
          <a className="stage-btn" href={src} target="_blank" rel="noreferrer" title="Open in your browser">
            <Icon.external size={16} />
          </a>
        )}
        <button className="stage-btn stage-close" onClick={close} title="Close (Esc)">
          <Icon.close size={18} />
        </button>
      </header>
      <div className="stage-body">
        {stage.device === 'desktop' ? (
          <div className="stage-desktop">
            {src && !demo ? <iframe key={`${src}-${nonce}`} title={project.name} src={src} sandbox={SANDBOX} /> : <MockSite project={project} device="desktop" />}
          </div>
        ) : (
          <div className="stage-phone" style={{ width: PHONE.w * phoneScale + 24, height: PHONE.h * phoneScale + 24 }}>
            <div className="stage-phone-screen" style={{ width: PHONE.w, height: PHONE.h, transform: `scale(${phoneScale})` }}>
              {src && !demo ? <iframe key={`${src}-${nonce}`} title={project.name} src={src} sandbox={SANDBOX} /> : <MockSite project={project} device="mobile" />}
            </div>
          </div>
        )}
      </div>
      {src && !demo && <p className="stage-tip">Blank? Some sites refuse to be embedded. Use the open in browser button.</p>}
    </div>
  )
}

// --- Drawn stand-in for demo mode / projects without a URL --------------------------------

export function MockSite({ project, device }: { project: Project; device: Device }) {
  const ac = project.accent
  const words = project.name.split(' ')
  return (
    <div className={`mock mock-${device}`} style={{ ['--ac' as string]: ac }}>
      <div className="mock-nav">
        <b>{words.slice(0, 2).join(' ')}</b>
        {device === 'desktop' ? (
          <>
            {project.pages.slice(1, 5).map((p) => (
              <span key={p.path}>{p.path.split('/').pop()}</span>
            ))}
            <span className="mock-cta">Get in touch</span>
          </>
        ) : (
          <span className="mock-burger">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      <div className="mock-hero">
        <small>{project.framework}</small>
        <h3>{project.name}</h3>
        <p>{project.description || `${project.reason}. A preview of the real site appears here once its URL is set.`}</p>
        <div className="mock-btns">
          <span className="mock-cta">Book now</span>
          <span className="mock-ghost">Learn more</span>
        </div>
      </div>
      <div className="mock-grid">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <i />
            <b />
            <span />
          </div>
        ))}
      </div>
    </div>
  )
}
