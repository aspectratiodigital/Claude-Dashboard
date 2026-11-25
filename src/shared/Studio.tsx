import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project, SeoReport, StudioElement, StudioMetaField, StudioOp, StudioResult, StudioSite } from '../data/types'
import { opNote } from '../data/studio'
import { SeoPanel, SiteCrawl, type Crawl } from './StudioSeo'
import { useData } from '../data/store'
import { relTime } from '../data/derive'
import { useApp } from '../store'
import { Icon } from './icons'
import './studio.css'

// Studio, the visual site builder. Every website opens from Studio's own copy
// of its repo, synced to the latest commit on GitHub and served on this
// computer (server/studio.ts), in a canvas you can size to any screen.
// Edit mode selects what you click: double-click text to change it, drag to
// move (snapping to line up with what's around it), swap or add photos, change
// links. Edits stay on the canvas (with undo) until you save them, which writes
// them into the site's real source files; then you review and push live.

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
  /** dragged elements snap to line up with others */
  snap: boolean
}

const VIEW_KEY = 'ard.studio.view'
const DEFAULT_VIEW: View = { preset: 'laptop', custom: { w: 1280, h: 720 }, turned: false, zoom: 'fit', compare: null, snap: true }

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
const newId = () => Math.random().toString(36).slice(2, 10)

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


// --- Edits held on the canvas ------------------------------------------------------------

type Tab = 'element' | 'seo' | 'changes' | 'claude'

const opsKey = (id: string) => `ard.studio.ops.${id}`

function loadOps(id: string): StudioOp[] {
  try {
    const v = JSON.parse(localStorage.getItem(opsKey(id)) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function saveOpsLocal(id: string, ops: StudioOp[]) {
  try {
    if (ops.length) localStorage.setItem(opsKey(id), JSON.stringify(ops))
    else localStorage.removeItem(opsKey(id))
  } catch {
    /* storage unavailable */
  }
}

async function post<T = StudioSite>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error ?? 'Something went wrong')
  return d as T
}

/**
 * Photos straight off a camera or phone are far too big for a website: anything
 * over 2400px or 500 KB is resized and saved as WebP before it goes in.
 */
async function optimise(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
    if (k === 1 && file.size < 500_000) return file
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * k)
    c.height = Math.round(bmp.height * k)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/webp', 0.82))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
  } catch {
    return file
  }
}

async function upload(original: File): Promise<{ id: string; name: string }> {
  if (!original.type.startsWith('image/')) throw new Error('That isn’t an image')
  const file = await optimise(original)
  const r = await fetch(`./api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error ?? 'Upload failed')
  return d
}

/** pick an image file with the system file chooser */
function chooseImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

// --- Studio -------------------------------------------------------------------------------

export function Studio() {
  const studio = useApp((s) => s.studio)
  if (!studio) return null
  return <StudioView key={studio.projectId} projectId={studio.projectId} />
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
  const [tab, setTab] = useState<Tab>('element')
  const [panel, setPanel] = useState(true)
  const [ops, setOpsState] = useState<StudioOp[]>(() => loadOps(projectId))
  const [redo, setRedo] = useState<StudioOp[]>([])
  const [flash, setFlash] = useState<string | null>(null)
  const [review, setReview] = useState(false)
  const [scale, setScale] = useState(1)
  const frames = useRef<(HTMLIFrameElement | null)[]>([])
  const [seo, setSeo] = useState<SeoReport | null>(null)
  const [crawl, setCrawl] = useState<Crawl | null>(null)
  const [claudeDraft, setClaudeDraft] = useState('')
  /** link statuses found so far (path → HTTP status), so each link is only checked once */
  const linkCache = useRef<Record<string, number>>({})

  const setOps = useCallback(
    (fn: (o: StudioOp[]) => StudioOp[]) =>
      setOpsState((o) => {
        const next = fn(o)
        saveOpsLocal(projectId, next)
        return next
      }),
    [projectId],
  )

  const origin = site?.port ? `http://127.0.0.1:${site.port}` : null
  const live = !!origin && (site?.status === 'ready' || site?.status === 'working')
  const working = site?.status === 'working'

  const tell = useCallback((msg: Record<string, unknown>, except?: MessageEventSource | null) => {
    for (const f of frames.current) if (f?.contentWindow && f.contentWindow !== except) f.contentWindow.postMessage({ studio: true, ...msg }, '*')
  }, [])

  const say = (s: string) => {
    setFlash(s)
    setTimeout(() => setFlash((f) => (f === s ? null : f)), 4000)
  }

  // the latest values, for the message handler without re-binding it
  const state = useRef({ ops, tool, scale, snap: view.snap, tab })
  state.current = { ops, tool, scale, snap: view.snap, tab }

  /** ask the main canvas for the page's SEO details (the answer arrives as a message) */
  const requestSeo = useCallback(() => {
    frames.current[0]?.contentWindow?.postMessage({ studio: true, type: 'seo-request', known: linkCache.current, links: true }, '*')
  }, [])

  const undo = useCallback(() => {
    const last = state.current.ops[state.current.ops.length - 1]
    if (!last) return
    tell({ type: 'revert', id: last.id })
    setOps((o) => o.slice(0, -1))
    setRedo((r) => [...r, last])
  }, [tell, setOps])

  const redoLast = useCallback(() => {
    setRedo((r) => {
      const op = r[r.length - 1]
      if (!op) return r
      tell({ type: 'apply', op })
      setOps((o) => [...o, op])
      return r.slice(0, -1)
    })
  }, [tell, setOps])

  const removeOp = (id: string) => {
    tell({ type: 'revert', id })
    setOps((o) => o.filter((x) => x.id !== id))
  }

  // messages from the overlay inside the canvas
  useEffect(() => {
    if (!origin) return
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || !e.data || e.data.studio !== true) return
      const d = e.data as { type: string; path?: string; element?: StudioElement | null; op?: StudioOp; key?: string; shift?: boolean; on?: boolean; report?: SeoReport }
      const src = e.source as Window | null
      // only the canvases (the site-wide SEO check runs its own hidden page)
      if (!src || !frames.current.some((f) => f?.contentWindow === src)) return
      const main = frames.current[0]?.contentWindow === src
      if (d.type === 'ready') {
        src.postMessage({ studio: true, type: 'mode', mode: state.current.tool }, origin)
        src.postMessage({ studio: true, type: 'snap', on: state.current.snap }, origin)
        src.postMessage({ studio: true, type: 'scale', scale: state.current.scale }, origin)
        src.postMessage({ studio: true, type: 'apply-all', ops: state.current.ops }, origin)
        if (main) {
          setSeo(null)
          if (state.current.tab === 'seo') src.postMessage({ studio: true, type: 'seo-request', known: linkCache.current, links: true }, origin)
        }
      }
      if (d.type === 'seo' && d.report && main) {
        Object.assign(linkCache.current, d.report.links.statuses)
        setSeo(d.report)
      }
      if (d.type === 'page' && d.path && main) setPath(d.path)
      if (d.type === 'select') setSelected(d.element ?? null)
      if (d.type === 'op' && d.op) {
        const op = d.op
        setOps((o) => {
          const i = o.findIndex((x) => x.id === op.id)
          return i >= 0 ? [...o.slice(0, i), op, ...o.slice(i + 1)] : [...o, op]
        })
        setRedo([])
        // the other canvas (when comparing sizes) shows it too
        tell({ type: 'revert', id: op.id }, src)
        tell({ type: 'apply', op }, src)
      }
      if (d.type === 'key') {
        if (d.key === 'z' && !d.shift) undo()
        if (d.key === 'y' || (d.key === 'z' && d.shift)) redoLast()
        if (d.key === 'v') setTool('select')
        if (d.key === 'h') setTool('browse')
      }
      if (d.type === 'escape' && !state.current.ops.length) setSelected(null)
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [origin, tell, setOps, undo, redoLast])

  // the SEO tab follows the page and its edits
  useEffect(() => {
    if (tab !== 'seo' || !live) return
    const t = setTimeout(requestSeo, 250)
    return () => clearTimeout(t)
  }, [tab, live, ops, requestSeo])
  // after a save or a sync, links may have been fixed: check them again
  useEffect(() => {
    linkCache.current = {}
  }, [nav.nonce, site?.sha])

  useEffect(() => {
    tell({ type: 'mode', mode: tool })
    if (tool === 'browse') setSelected(null)
  }, [tool, tell])
  useEffect(() => tell({ type: 'snap', on: view.snap }), [view.snap, tell])
  useEffect(() => tell({ type: 'scale', scale }), [scale, tell])

  // when a save or Claude's work finishes, reload the canvas from the real source
  const prev = useRef(site?.status)
  useEffect(() => {
    const was = prev.current
    prev.current = site?.status
    if (was === 'working' && site?.status === 'ready' && site.last) {
      if (site.last.kind === 'save' || site.last.kind === 'discard' || (site.last.kind === 'publish' && site.last.ok)) {
        setOps(() => [])
        setRedo([])
      }
      if (site.last.kind === 'publish' && site.last.ok) setReview(false)
      setSelected(null)
      setNav((n) => ({ path, nonce: n.nonce + 1 }))
    }
  }, [site?.status, site?.last, path, setOps])

  // keyboard: V select, H browse, Ctrl Z / Ctrl Shift Z, Esc steps back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        return e.shiftKey ? redoLast() : undo()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        return redoLast()
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'v' || e.key === 'V') setTool('select')
      if (e.key === 'h' || e.key === 'H') setTool('browse')
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (review) setReview(false)
        else if (selected) {
          setSelected(null)
          tell({ type: 'clear' })
        } else if (tool === 'select') setTool('browse')
        else close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, tool, tell, close, undo, redoLast, review])

  const go = (p: string) => {
    setPath(p)
    setNav((n) => ({ path: p, nonce: n.nonce + 1 }))
    setSelected(null)
  }

  const act = (action: string, extra: Record<string, unknown> = {}) => tell({ type: 'action', action, ...extra })

  const withImage = async (action: 'image' | 'add-image') => {
    const file = await chooseImage()
    if (!file) return
    try {
      say('Uploading the photo…')
      const u = await upload(file)
      const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
      act(action, { upload: u.id, name: u.name, value: alt })
      say(action === 'image' ? 'Photo swapped. Save to put it in the site.' : 'Photo added. Save to put it in the site.')
    } catch (e) {
      say((e as Error).message)
    }
  }

  // --- SEO tab: page details and alt text become edits on the canvas like any other

  /** one edit per page and detail, updated as you change it again */
  const setMeta = (field: StudioMetaField, value: string, photo?: { id: string; name: string }) => {
    if (!seo) return
    const page = seo.path
    const existing = ops.find((o): o is Extract<StudioOp, { kind: 'meta' }> => o.kind === 'meta' && o.page === page && o.field === field)
    const now = { title: seo.title, description: seo.description, 'og:title': seo.og.title, 'og:description': seo.og.description, 'og:image': seo.og.image }[field] ?? ''
    const original = existing ? existing.before : now
    const after = value.replace(/\s+/g, ' ').trim()
    if (existing) tell({ type: 'revert', id: existing.id })
    if (!photo && after === original.trim()) {
      // changed back to how it was
      if (existing) setOps((o) => o.filter((x) => x.id !== existing.id))
      return
    }
    const op: StudioOp = { id: existing?.id ?? newId(), kind: 'meta', page, selector: 'head', label: 'Page details', text: '', field, before: original, after: photo ? photo.name : after, ...(photo ? { upload: photo.id, name: photo.name } : {}) }
    tell({ type: 'apply', op })
    setOps((o) => (existing ? o.map((x) => (x.id === op.id ? op : x)) : [...o, op]))
    setRedo([])
  }

  const setAltFor = (selector: string, src: string, value: string) => {
    if (!seo) return
    const file = src.split('/').pop()?.split('?')[0] ?? 'photo'
    const op: StudioOp = { id: newId(), kind: 'alt', page: seo.path, selector, label: `Image ${file}`, text: '', before: '', after: value }
    tell({ type: 'apply', op })
    setOps((o) => [...o, op])
    setRedo([])
  }

  const chooseShareImage = async () => {
    const file = await chooseImage()
    if (!file) return
    try {
      say('Uploading the share image…')
      const u = await upload(file)
      setMeta('og:image', u.name, u)
      say('Share image set. Save to put it in the site.')
    } catch (e) {
      say((e as Error).message)
    }
  }

  /** an SEO fix that needs Claude: ready to send in the Claude tab, about the whole page */
  const askAbout = (prompt: string) => {
    setSelected(null)
    tell({ type: 'clear' })
    setClaudeDraft(prompt)
    setTab('claude')
  }

  const startCrawl = () => {
    const pages = (site?.pages ?? []).map((p) => p.path)
    if (pages.length) setCrawl({ queue: pages, total: pages.length, reports: {} })
  }
  const crawled = useCallback((page: string, report: SeoReport | null) => {
    setCrawl((c) => (c && c.queue[0] === page ? { ...c, queue: c.queue.slice(1), reports: { ...c.reports, [page]: report } } : c))
  }, [])

  const save = async () => {
    if (!ops.length) return
    try {
      await post('./api/studio/save', { projectId, ops })
      void open()
    } catch (e) {
      say((e as Error).message)
    }
  }

  const ask = async (prompt: string) => {
    try {
      await post('./api/studio/claude', { projectId, prompt, page: path, element: selected, width: sizeOf(view.preset, view.custom, view.turned).w })
      void open()
    } catch (e) {
      say((e as Error).message)
    }
  }

  const main = sizeOf(view.preset, view.custom, view.turned)
  const second = view.compare ? sizeOf(view.compare, view.custom, false) : null
  const src = live ? `${origin}${nav.path}` : null
  const unpublished = site?.changed.length ?? 0

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
        <PagePicker pages={site?.pages ?? []} path={path} onGo={go} disabled={!live} />

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
          <button aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Edit: click to select, double-click to edit text, drag to move (V)">
            <Icon.pointer size={15} /> <span>Edit</span>
          </button>
        </div>
        <button className="st-btn" aria-pressed={view.snap} onClick={() => setView({ snap: !view.snap })} title={view.snap ? 'Snapping on: dragged elements line up with others (hold Alt to drag freely)' : 'Snapping off'}>
          <Icon.magnet size={17} />
        </button>
        <button className="st-btn" onClick={undo} disabled={!ops.length} title="Undo (Ctrl Z)">
          <Icon.undo size={17} />
        </button>
        <button className="st-btn" onClick={redoLast} disabled={!redo.length} title="Redo (Ctrl Shift Z)">
          <Icon.redo size={17} />
        </button>
        <button className="st-btn" onClick={() => void open(true)} title="Get the latest from GitHub" disabled={!site || !['ready', 'error', 'unsupported'].includes(site.status) || ops.length > 0}>
          <Icon.refresh size={17} />
        </button>
        {src && (
          <a className="st-btn" href={`${origin}${path}`} target="_blank" rel="noreferrer" title="Open this preview in your browser">
            <Icon.external size={17} />
          </a>
        )}
        <button className="st-btn" aria-pressed={panel} onClick={() => setPanel(!panel)} title="Side panel">
          <Icon.layers size={17} />
        </button>
        {ops.length > 0 ? (
          <button className="st-primary" onClick={save} disabled={working} title="Write these edits into the site's source files">
            Save {ops.length} edit{ops.length === 1 ? '' : 's'}
          </button>
        ) : (
          <button className="st-primary" data-live onClick={() => setReview(true)} disabled={!unpublished || working} title={unpublished ? 'Review the changes and push them live' : 'Nothing to publish yet'}>
            {unpublished ? 'Review & push live' : 'Up to date'}
          </button>
        )}
        <button className="st-btn st-close" onClick={close} title="Close Studio (Esc)">
          <Icon.close size={18} />
        </button>
      </header>

      <StatusLine site={site} project={project} error={error} demo={mode !== 'live'} flash={flash} />

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
          onScale={setScale}
          busy={working ? site?.message ?? 'Working…' : null}
        />
        {panel && live && (
          <aside className="st-side" aria-label="Studio panel">
            <div className="st-tabs" role="tablist">
              {(
                [
                  ['element', 'Element'],
                  ['seo', 'SEO'],
                  ['changes', `Changes${ops.length ? ` (${ops.length})` : ''}`],
                  ['claude', 'Claude'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'element' &&
              (selected ? (
                <Inspector
                  el={selected}
                  disabled={working}
                  onClose={() => {
                    setSelected(null)
                    tell({ type: 'clear' })
                  }}
                  onReveal={() => tell({ type: 'reveal', selector: selected.selector })}
                  onEditText={() => tell({ type: 'edit-text' })}
                  onAction={act}
                  onImage={withImage}
                  onOrder={(earlier) => tell({ type: 'order', on: earlier })}
                  onClaude={() => setTab('claude')}
                />
              ) : (
                <Hints tool={tool} onEdit={() => setTool('select')} />
              ))}
            {tab === 'seo' && site && origin && (
              <SeoPanel
                report={seo}
                site={site}
                project={project}
                origin={origin}
                ops={ops}
                crawl={crawl}
                working={working}
                onMeta={setMeta}
                onShareImage={() => void chooseShareImage()}
                onAlt={setAltFor}
                onClaude={askAbout}
                onReveal={(selector) => tell({ type: 'reveal', selector })}
                onCrawl={startCrawl}
                onStopCrawl={() => setCrawl((c) => (c ? { ...c, queue: [] } : c))}
                onGo={go}
                onRefresh={() => {
                  setSeo(null)
                  linkCache.current = {}
                  requestSeo()
                }}
              />
            )}
            {tab === 'changes' && <Changes ops={ops} site={site} onRemove={removeOp} onSave={save} onReview={() => setReview(true)} working={working} />}
            {tab === 'claude' && <ClaudePanel site={site} element={selected} onAsk={ask} working={working} text={claudeDraft} setText={setClaudeDraft} />}
          </aside>
        )}
        {crawl && crawl.queue.length > 0 && origin && live && <SiteCrawl key={crawl.queue[0]} origin={origin} path={crawl.queue[0]} ops={ops} known={linkCache} onReport={crawled} />}
      </div>
      {review && site && <Review site={site} project={project} onClose={() => setReview(false)} />}
    </div>
  )
}

const labelFor = (id: PresetId, turned: boolean) => `${id === 'custom' ? 'Custom' : PRESETS.find((p) => p.id === id)!.label}${turned ? ' · sideways' : ''}`

// --- Side panel ---------------------------------------------------------------------------

function Hints({ tool, onEdit }: { tool: 'browse' | 'select'; onEdit: () => void }) {
  return (
    <div className="st-hints">
      {tool === 'browse' ? (
        <>
          <p>You’re browsing: links and buttons work as normal.</p>
          <button className="st-pill" onClick={onEdit}>
            <Icon.pointer size={13} /> Start editing (V)
          </button>
        </>
      ) : (
        <p>Click anything on the page to select it.</p>
      )}
      <ul>
        <li>
          <b>Double-click</b> text to change it, Enter to finish
        </li>
        <li>
          <b>Drag</b> to move: it snaps to line up with things around it (hold Alt to drag freely)
        </li>
        <li>
          <b>Arrow keys</b> nudge 1px, with Shift 10px
        </li>
        <li>
          <b>Ctrl Z</b> undo, <b>Ctrl Shift Z</b> redo
        </li>
        <li>
          <b>Save</b> writes your edits into the site’s real files, then <b>Review &amp; push live</b> sends them to GitHub
        </li>
      </ul>
    </div>
  )
}

function Inspector({
  el,
  disabled,
  onClose,
  onReveal,
  onEditText,
  onAction,
  onImage,
  onOrder,
  onClaude,
}: {
  el: StudioElement
  disabled: boolean
  onClose: () => void
  onReveal: () => void
  onEditText: () => void
  onAction: (action: string, extra?: Record<string, unknown>) => void
  onImage: (action: 'image' | 'add-image') => void
  onOrder: (earlier: boolean) => void
  onClaude: () => void
}) {
  const [href, setHref] = useState(el.href ?? '')
  const [alt, setAlt] = useState(el.image?.alt ?? '')
  useEffect(() => {
    setHref(el.href ?? '')
    setAlt(el.image?.alt ?? '')
  }, [el.selector, el.href, el.image?.alt])
  return (
    <div className="st-inspector">
      <header>
        <b>{el.label}</b>
        <button className="st-btn" onClick={onClose} title="Deselect (Esc)">
          <Icon.close size={15} />
        </button>
      </header>

      {el.image && (
        <figure className="st-img">
          <img src={el.image.src} alt="" />
          <figcaption>
            {el.image.width} × {el.image.height} · {el.image.src.split('/').pop()?.split('?')[0]}
          </figcaption>
        </figure>
      )}
      {el.text && !el.image && <p className="st-text">{el.text.length > 300 ? `${el.text.slice(0, 300)}…` : el.text}</p>}

      <div className="st-actions">
        {el.editable && (
          <button className="st-act" onClick={onEditText} disabled={disabled}>
            <Icon.text size={15} /> Edit text
          </button>
        )}
        {el.image && (
          <button className="st-act" onClick={() => onImage('image')} disabled={disabled}>
            <Icon.image size={15} /> Replace photo
          </button>
        )}
        <button className="st-act" onClick={() => onImage('add-image')} disabled={disabled} title="Add a new photo straight after this">
          <Icon.image size={15} /> Add photo after
        </button>
        <button className="st-act" onClick={() => onAction('duplicate')} disabled={disabled} title="An identical copy straight after it, e.g. a second button">
          <Icon.copy size={15} /> Duplicate
        </button>
        {el.siblings > 1 && (
          <>
            <button className="st-act" onClick={() => onOrder(true)} disabled={disabled || el.index <= 0}>
              <Icon.arrowUp size={15} /> Move earlier
            </button>
            <button className="st-act" onClick={() => onOrder(false)} disabled={disabled || el.index >= el.siblings - 1}>
              <Icon.arrowDown size={15} /> Move later
            </button>
          </>
        )}
        {el.moved && (
          <button className="st-act" onClick={() => onAction('unmove')} disabled={disabled}>
            <Icon.undo size={15} /> Reset position
          </button>
        )}
        <button className="st-act" onClick={() => onAction('hide', { scope: 'this-size' })} disabled={disabled} title="Hide it at this screen size only">
          <Icon.eyeOff size={15} /> Hide at this size
        </button>
        <button className="st-act" data-tone="bad" onClick={() => onAction('hide', { scope: 'everywhere' })} disabled={disabled}>
          <Icon.trash size={15} /> Remove
        </button>
        <button className="st-act" onClick={onClaude}>
          <Icon.claude size={15} /> Ask Claude
        </button>
      </div>

      {el.href !== null && (
        <form
          className="st-field"
          onSubmit={(e) => {
            e.preventDefault()
            if (href.trim() !== (el.href ?? '')) onAction('link', { value: href.trim() })
          }}
        >
          <label>
            <Icon.link size={13} /> Links to
          </label>
          <div>
            <input value={href} onChange={(e) => setHref(e.target.value)} spellCheck={false} placeholder="/contact, https://… or tel:…" />
            <button className="st-pill" disabled={disabled || href.trim() === (el.href ?? '')}>
              Set
            </button>
          </div>
        </form>
      )}
      {el.image && (
        <form
          className="st-field"
          onSubmit={(e) => {
            e.preventDefault()
            if (alt.trim() !== el.image!.alt) onAction('alt', { value: alt.trim() })
          }}
        >
          <label>Alt text {!el.image.alt && <em>missing</em>}</label>
          <div>
            <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the photo for screen readers and Google" />
            <button className="st-pill" disabled={disabled || alt.trim() === el.image.alt}>
              Set
            </button>
          </div>
        </form>
      )}

      <dl>
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
    </div>
  )
}

const Swatch = ({ c }: { c: string }) => <i className="st-swatch" style={{ background: c }} />

function Changes({ ops, site, onRemove, onSave, onReview, working }: { ops: StudioOp[]; site: StudioSite | null; onRemove: (id: string) => void; onSave: () => void; onReview: () => void; working: boolean }) {
  return (
    <div className="st-changes">
      <h4>On the canvas, not saved yet</h4>
      {ops.length ? (
        <ol>
          {ops.map((op) => (
            <li key={op.id}>
              <span>{opNote(op)}</span>
              <button className="st-btn" onClick={() => onRemove(op.id)} title="Take this edit back" disabled={working}>
                <Icon.close size={13} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="st-muted">Nothing yet. Edit something on the page.</p>
      )}
      {ops.length > 0 && (
        <button className="st-primary" onClick={onSave} disabled={working}>
          Save into the site’s files
        </button>
      )}
      <h4>Saved, waiting to go live</h4>
      {site?.notes.length ? (
        <ol>
          {site.notes.map((n, i) => (
            <li key={i}>
              <span>{n}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="st-muted">{site?.changed.length ? `${site.changed.length} changed files` : 'Nothing waiting.'}</p>
      )}
      {(site?.changed.length ?? 0) > 0 && (
        <button className="st-primary" data-live onClick={onReview} disabled={working}>
          Review &amp; push live
        </button>
      )}
      {site?.last && <Result r={site.last} />}
    </div>
  )
}

function Result({ r }: { r: StudioResult }) {
  return (
    <div className="st-result" data-ok={r.ok}>
      <b>{{ save: 'Saved', claude: 'Claude', publish: 'Published', discard: 'Discarded' }[r.kind]}</b> <span className="st-muted">{relTime(r.at)}</span>
      <p>{r.text}</p>
      {r.failed && r.failed.length > 0 && (
        <ul>
          {r.failed.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {r.url && (
        <a className="st-pill" href={r.url} target="_blank" rel="noreferrer">
          {r.url.includes('/compare/') ? 'Open a pull request' : 'See the commit'} <Icon.external size={12} />
        </a>
      )}
    </div>
  )
}

function ClaudePanel({ site, element, onAsk, working, text, setText }: { site: StudioSite | null; element: StudioElement | null; onAsk: (p: string) => void; working: boolean; text: string; setText: (s: string) => void }) {
  const send = () => {
    if (!text.trim() || working) return
    onAsk(text.trim())
    setText('')
  }
  const last = site?.last?.kind === 'claude' ? site.last : null
  return (
    <div className="st-claude">
      <p className="st-muted">Ask for a change in words. Claude edits the site’s files in Studio’s copy, then the page reloads so you can check it before pushing live.</p>
      {element && (
        <p className="st-chip">
          About: <b>{element.label}</b>
          {element.text ? ` “${element.text.slice(0, 50)}${element.text.length > 50 ? '…' : ''}”` : ''}
        </p>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
        }}
        placeholder={element ? 'e.g. make this heading shorter and punchier' : 'e.g. add a third review card like the other two'}
        rows={5}
        disabled={working}
      />
      <button className="st-primary" onClick={send} disabled={working || !text.trim()}>
        {working ? 'Working…' : 'Ask Claude'}
      </button>
      {working && site?.message && (
        <p className="st-working">
          <i className="st-spin" /> {site.message}
        </p>
      )}
      {last && <Result r={last} />}
    </div>
  )
}

// --- Review & publish ---------------------------------------------------------------------

function Review({ site, project, onClose }: { site: StudioSite; project: Project | null; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sure, setSure] = useState(false)
  const working = site.status === 'working'
  useEffect(() => {
    fetch(`./api/studio/diff?project=${encodeURIComponent(site.projectId)}`)
      .then((r) => r.json())
      .then((d) => setDiff(d.diff ?? ''))
      .catch(() => setDiff(''))
  }, [site.projectId, site.changed.length])
  const go = async (url: string, body: Record<string, unknown>) => {
    setError(null)
    try {
      await post(url, { projectId: site.projectId, ...body })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const last = site.last && ['publish', 'discard'].includes(site.last.kind) ? site.last : null
  return (
    <div className="st-review" role="dialog" aria-label="Review and push live" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-review-box">
        <header>
          <b>Push {project?.name ?? 'the site'} live</b>
          <button className="st-btn" onClick={onClose} title="Close (Esc)">
            <Icon.close size={16} />
          </button>
        </header>
        {site.changed.length > 0 ? (
          <>
            <p className="st-muted">
              One commit to <b>{site.branch}</b> on GitHub, which the site’s own deploy picks up. {site.changed.length} file{site.changed.length === 1 ? '' : 's'} changed.
            </p>
            {site.notes.length > 0 && (
              <ol className="st-notes">
                {site.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ol>
            )}
            <Diff text={diff} />
          </>
        ) : (
          <p className="st-muted">Nothing waiting to go live.</p>
        )}
        {error && <p className="st-error">{error}</p>}
        {working && (
          <p className="st-working">
            <i className="st-spin" /> {site.message}
          </p>
        )}
        {last && <Result r={last} />}
        <footer>
          {site.changed.length > 0 && (
            <>
              <button className="st-pill" data-tone="bad" disabled={working} onClick={() => (sure ? go('./api/studio/discard', {}) : setSure(true))}>
                {sure ? 'Click again to discard' : 'Discard all'}
              </button>
              <span className="st-gap" />
              <button className="st-pill" disabled={working} onClick={() => go('./api/studio/publish', { draft: true })} title="Push to a new branch and open a pull request, so it can be checked before going live">
                Save as draft
              </button>
              <button className="st-primary" data-live disabled={working} onClick={() => go('./api/studio/publish', { draft: false })}>
                Push live
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function Diff({ text }: { text: string | null }) {
  if (text === null) return <p className="st-muted">Reading the changes…</p>
  if (!text.trim()) return null
  const files = text.split(/^diff --git /m).filter(Boolean)
  return (
    <div className="st-diff">
      {files.map((f, i) => {
        const name = f.match(/^a\/(\S+)/)?.[1] ?? 'file'
        const binary = /Binary files/.test(f)
        const lines = f.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
        return (
          <details key={i} open={files.length <= 4 && !binary}>
            <summary>
              {name} <span className="st-muted">{binary ? 'image' : `+${lines.filter((l) => l[0] === '+').length} −${lines.filter((l) => l[0] === '-').length}`}</span>
            </summary>
            {!binary && (
              <pre>
                {lines.slice(0, 300).map((l, j) => (
                  <span key={j} data-d={l[0]}>
                    {l.length > 400 ? `${l.slice(0, 400)}…` : l}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )}
          </details>
        )
      })}
    </div>
  )
}

// --- Status -------------------------------------------------------------------------------

const BUSY: StudioSite['status'][] = ['idle', 'syncing', 'installing', 'building', 'starting']

function StatusLine({ site, project, error, demo, flash }: { site: StudioSite | null; project: Project | null; error: string | null; demo: boolean; flash: string | null }) {
  if (demo) return <div className="st-status">Demo data: connect GitHub in Settings to open your real sites in Studio.</div>
  if (error) return <div className="st-status" data-tone="bad">{error}</div>
  if (!site) return <div className="st-status" data-tone="busy"><i className="st-spin" /> Opening {project?.name ?? 'the site'}…</div>
  if (BUSY.includes(site.status) || site.status === 'working') return <div className="st-status" data-tone="busy"><i className="st-spin" /> {site.message || 'Getting ready…'}</div>
  if (site.status === 'error') return <div className="st-status" data-tone="bad">{site.message}</div>
  return (
    <div className="st-status">
      {flash ? (
        <span className="st-flash">{flash}</span>
      ) : site.sha ? (
        <>
          <Icon.branch size={13} />
          <span>
            Latest on <b>{site.branch}</b>
          </span>
          <code>{site.sha.slice(0, 7)}</code>
          <span className="st-commit">{site.commit}</span>
          {site.committed && <span className="st-ago">{relTime(site.committed)}</span>}
          <span className="st-kind">{KIND_LABEL[site.kind]}</span>
          {site.changed.length > 0 && <span className="st-changed">{site.notes.length || site.changed.length} saved, not live yet</span>}
        </>
      ) : (
        site.message
      )}
    </div>
  )
}


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
  onScale,
  busy,
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
  onScale: (s: number) => void
  /** what Studio is doing to the site right now, shown over the canvas */
  busy: string | null
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
  useEffect(() => onScale(scale), [scale, onScale])

  return (
    <div className="st-canvas" ref={area} data-zoomed={zoom !== 'fit' || undefined} data-busy={!!busy || undefined}>
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

