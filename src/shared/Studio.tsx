import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project, SeoReport, StudioDesign, StudioElement, StudioMetaField, StudioOp, StudioSite } from '../data/types'
import { useData } from '../data/store'
import { relTime } from '../data/derive'
import { useApp } from '../store'
import { Icon } from './icons'
import { SiteCrawl, type Crawl } from './StudioSeo'
import { Menu, MenuItem, Result, Spin, getJson, post, uploadFile, useLocal, type PhotoPurpose, type StudioCtx, type Tab, type Uploaded } from './StudioUi'
import { Inspector, MultiInspector } from './StudioInspector'
import { SiteTab } from './StudioSite'
import { ChecksTab } from './StudioChecks'
import { PublishTab, Review } from './StudioPublish'
import { EmbedDialog, PhotoEditor, PhotoPicker, type Picked } from './StudioMedia'
import { PhoneDialog, ShotDialog } from './StudioShare'
import { Layers } from './StudioLayers'
import { Overview } from './StudioOverview'
import './studio.css'

// Studio, the visual site builder. Every website opens from Studio's own copy
// of its repo, synced to the latest commit on GitHub and served on this
// computer (server/studio.ts), in a canvas you can size to any screen.
// Edit mode selects what you click (Shift adds to the selection): double-click
// text to change it, drag to move (snapping to line up with what's around it),
// swap photos, restyle on the site's own scale. Edits stay on the canvas (with
// undo) until you save them, which writes them into the site's real source
// files; then you review and push live.
//
// The side panel has five tabs: Element (what's selected), Site (theme,
// content, photos, find and replace), Checks (SEO, accessibility, speed, local
// details, visitors), Publish (changes, going live, deploys, sharing, history)
// and Claude.

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
  grid: boolean
  rulers: boolean
}

const VIEW_KEY = 'ard.studio.view'
const DEFAULT_VIEW: View = { preset: 'laptop', custom: { w: 1280, h: 720 }, turned: false, zoom: 'fit', compare: null, snap: true, grid: false, rulers: false }

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
        setSite(await post<StudioSite>('./api/studio/open', { projectId, sync }))
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [projectId, live],
  )

  /** read the state again without asking to open (after starting a job) */
  const poll = useCallback(async () => {
    if (!projectId || !live) return
    try {
      setSite(await getJson<StudioSite>(`./api/studio?project=${encodeURIComponent(projectId)}`))
    } catch {
      /* the next poll will try again */
    }
  }, [projectId, live])

  useEffect(() => {
    setSite(null)
    void open()
  }, [open])

  // poll quickly while it's getting ready or working, slowly once it's settled
  const settled = site && ['ready', 'unsupported', 'error'].includes(site.status)
  useEffect(() => {
    if (!projectId || !live) return
    const t = setInterval(poll, settled ? 15_000 : 1000)
    return () => clearInterval(t)
  }, [projectId, live, settled, poll])

  return { site, error, open, poll }
}

// --- Edits held on the canvas ------------------------------------------------------------

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

/** a card or section copied on the canvas, to paste on any page of the same site */
interface Clip {
  projectId: string
  clip: { html: string; page: string; selector: string; label: string; text: string }
}
const CLIP_KEY = 'ard.studio.clip'

// --- Studio -------------------------------------------------------------------------------

export function Studio() {
  const studio = useApp((s) => s.studio)
  if (!studio) return null
  return <StudioView key={studio.projectId} projectId={studio.projectId} />
}

type Dialog =
  | { kind: 'picker'; purpose: PhotoPurpose }
  | { kind: 'editor' }
  | { kind: 'embed' }
  | { kind: 'shot' }
  | { kind: 'phone' }
  | { kind: 'overview' }
  | null

function StudioView({ projectId }: { projectId: string }) {
  const projects = useData((s) => s.projects)
  const mode = useData((s) => s.mode)
  const openStudio = useApp((s) => s.openStudio)
  const close = useApp((s) => s.closeStudio)
  const sites = useMemo(() => projects.filter(isSite).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const project = projects.find((p) => p.id === projectId) ?? null
  const { site, error, open, poll } = useStudioSite(projectId)

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
  const [others, setOthers] = useState<{ selector: string; label: string; text: string }[]>([])
  const [tab, setTab] = useLocal<Tab>('ard.studio.tab', 'element')
  const [sub, setSub] = useState<string | undefined>(undefined)
  const [panel, setPanel] = useLocal('ard.studio.panel', true)
  const [layersOpen, setLayersOpen] = useLocal('ard.studio.layers', false)
  const [ops, setOpsState] = useState<StudioOp[]>(() => loadOps(projectId))
  const [redo, setRedo] = useState<StudioOp[]>([])
  const [flash, setFlash] = useState<string | null>(null)
  const [review, setReview] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [scale, setScale] = useState(1)
  const frames = useRef<(HTMLIFrameElement | null)[]>([])
  const [seo, setSeo] = useState<SeoReport | null>(null)
  const [crawl, setCrawl] = useState<Crawl | null>(null)
  const [claudeDraft, setClaudeDraft] = useState('')
  const [design, setDesign] = useState<StudioDesign | null>(null)
  const [editing, setEditing] = useState(false)
  /** locked elements, by page */
  const [locks, setLocks] = useLocal<Record<string, string[]>>(`ard.studio.locks.${projectId}`, {})
  /** link statuses found so far (path → HTTP status), so each link is only checked once */
  const linkCache = useRef<Record<string, number>>({})
  /** panels listening for messages from the canvas */
  const listeners = useRef(new Map<string, Set<(d: Record<string, unknown>) => void>>())

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
  const main = sizeOf(view.preset, view.custom, view.turned)

  // "show me where" from a list in Checks or Publish selects it without leaving that list
  const keepTab = useRef(0)
  const tell = useCallback((msg: Record<string, unknown>, except?: MessageEventSource | null) => {
    if (msg.type === 'reveal' && msg.keepTab) keepTab.current = Date.now()
    for (const f of frames.current) if (f?.contentWindow && f.contentWindow !== except) f.contentWindow.postMessage({ studio: true, ...msg }, '*')
  }, [])

  const say = useCallback((s: string) => {
    setFlash(s)
    setTimeout(() => setFlash((f) => (f === s ? null : f)), 5000)
  }, [])

  // the latest values, for the message handler without re-binding it
  const state = useRef({ ops, tool, scale, view, tab, locks, path, site, selected })
  state.current = { ops, tool, scale, view, tab, locks, path, site, selected }

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

  const removeOp = useCallback(
    (id: string) => {
      tell({ type: 'revert', id })
      // edits made on something this edit made go with it
      setOps((o) => {
        const gone = new Set([id])
        for (const x of o) if (x.made && gone.has(x.made)) gone.add(x.id)
        for (const g of gone) if (g !== id) tell({ type: 'revert', id: g })
        return o.filter((x) => !gone.has(x.id))
      })
    },
    [tell, setOps],
  )

  /** an edit Studio makes itself; `replace` swaps out an earlier one (the same theme token again) */
  const addOp = useCallback(
    (op: StudioOp, replace?: string) => {
      if (replace) tell({ type: 'revert', id: replace })
      tell({ type: 'apply', op })
      setOps((o) => (replace ? [...o.filter((x) => x.id !== replace), op] : [...o, op]))
      setRedo([])
    },
    [tell, setOps],
  )

  const act = useCallback((action: string, extra: Record<string, unknown> = {}) => tell({ type: 'action', action, ...extra }), [tell])

  const doUpload = useCallback((f: File | Blob, name?: string) => uploadFile(f, { name, optimise: state.current.site?.pipeline === 'files' }), [])

  const paste = useCallback(() => {
    let c: Clip | null = null
    try {
      c = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null')
    } catch {
      /* nothing copied */
    }
    if (!c?.clip) return say('Nothing copied yet: select a card or section and press Ctrl C.')
    if (c.projectId !== projectId) return say('That was copied on another site. Copying between sites isn’t possible: their styles differ.')
    if (!state.current.selected) return say('Select where it should go: it’s pasted straight after what you select.')
    act('paste', { clip: c.clip })
    say(`Pasted ${c.clip.label}${c.clip.page !== state.current.path ? ` from ${c.clip.page === '/' ? 'the home page' : c.clip.page}` : ''}. Save to put it in the site.`)
  }, [act, projectId, say])

  const openTab = useCallback(
    (t: Tab, s?: string) => {
      setPanel(true)
      setTab(t)
      setSub(s)
    },
    [setPanel, setTab],
  )

  const dropFile = useCallback(
    async (file: File, kind: string) => {
      try {
        if (kind === 'video') {
          if (!/^video\/(mp4|webm)$/.test(file.type)) return say('Videos need to be MP4 or WebM.')
          say('Uploading the video…')
          const u = await uploadFile(file)
          act('video', { upload: u.id, name: u.name })
          return say('Video swapped. Save to put it in the site.')
        }
        if (!file.type.startsWith('image/')) return say('That isn’t a photo.')
        say('Uploading the photo…')
        const u = await doUpload(file)
        const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
        act(kind, { upload: u.id, name: u.name, value: alt })
        say(kind === 'add-image' ? 'Photo added. Save to put it in the site.' : 'Photo swapped. Save to put it in the site.')
      } catch (e) {
        say((e as Error).message)
      }
    },
    [act, doUpload, say],
  )

  // messages from the overlay inside the canvas
  useEffect(() => {
    if (!origin) return
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || !e.data || e.data.studio !== true) return
      const d = e.data as { type: string; path?: string; element?: StudioElement | null; op?: StudioOp; key?: string; shift?: boolean; on?: boolean; report?: SeoReport; count?: number; others?: { selector: string; label: string; text: string }[]; clip?: Clip['clip']; file?: File; kind?: string; design?: StudioDesign }
      const src = e.source as Window | null
      // only the canvases (the site-wide SEO check runs its own hidden page)
      if (!src || !frames.current.some((f) => f?.contentWindow === src)) return
      const isMain = frames.current[0]?.contentWindow === src
      const s = state.current
      if (d.type === 'ready') {
        src.postMessage({ studio: true, type: 'mode', mode: s.tool }, origin)
        src.postMessage({ studio: true, type: 'snap', on: s.view.snap }, origin)
        src.postMessage({ studio: true, type: 'scale', scale: s.scale }, origin)
        src.postMessage({ studio: true, type: 'view', grid: s.view.grid, rulers: s.view.rulers }, origin)
        src.postMessage({ studio: true, type: 'apply-all', ops: s.ops }, origin)
        if (isMain) {
          setSeo(null)
          setDesign(null)
          src.postMessage({ studio: true, type: 'design' }, origin)
          if (s.tab === 'checks') src.postMessage({ studio: true, type: 'seo-request', known: linkCache.current, links: true }, origin)
        }
      }
      if (d.type === 'page' && d.path) {
        src.postMessage({ studio: true, type: 'locks', selectors: s.locks[d.path] ?? [] }, origin)
        if (isMain) setPath(d.path)
      }
      if (!isMain && !['op', 'key', 'select'].includes(d.type)) return
      if (d.type === 'seo' && d.report) {
        Object.assign(linkCache.current, d.report.links.statuses)
        setSeo(d.report)
      }
      if (d.type === 'design' && d.design) setDesign(d.design)
      if (d.type === 'select') {
        setSelected(d.element ?? null)
        setOthers(d.others ?? [])
        // a newly picked element opens the Element tab; the same one again (after an edit redraws it) doesn't
        const fresh = d.element && d.element.selector !== s.selected?.selector
        if (fresh && s.tab !== 'element' && s.tab !== 'claude' && Date.now() - keepTab.current > 1500) setTab('element')
        // picked from Layers or a check while browsing: that's editing now
        if (d.element && s.tool === 'browse') setTool('select')
      }
      if (d.type === 'editing') setEditing(!!d.on)
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
      if (d.type === 'copy' && d.clip) {
        try {
          localStorage.setItem(CLIP_KEY, JSON.stringify({ projectId, clip: d.clip } satisfies Clip))
          say(`Copied ${d.clip.label}. Select something on any page of this site and press Ctrl V to paste it after.`)
        } catch {
          say('That’s too big to copy.')
        }
      }
      if (d.type === 'drop' && d.file && d.kind) void dropFile(d.file, d.kind)
      if (d.type === 'key') {
        if (d.key === 'z' && !d.shift) undo()
        if (d.key === 'y' || (d.key === 'z' && d.shift)) redoLast()
        if (d.key === 'v') setTool('select')
        if (d.key === 'h') setTool('browse')
        if (d.key === 'paste') paste()
        if (d.key === 'duplicate') act('duplicate')
        if (d.key === 'delete') act('hide', { scope: 'everywhere' })
        if (d.key === 'find') openTab('site', 'find')
      }
      if (d.type === 'escape' && !s.ops.length) setSelected(null)
      for (const fn of listeners.current.get(d.type) ?? []) fn(d as unknown as Record<string, unknown>)
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [origin, tell, setOps, undo, redoLast, paste, act, dropFile, openTab, projectId, say, setTab])

  const listen = useCallback((type: string, fn: (d: Record<string, unknown>) => void) => {
    const set = listeners.current.get(type) ?? new Set()
    set.add(fn)
    listeners.current.set(type, set)
    return () => {
      set.delete(fn)
    }
  }, [])

  // the Checks tab follows the page and its edits
  useEffect(() => {
    if (tab !== 'checks' || !live) return
    const t = setTimeout(requestSeo, 250)
    return () => clearTimeout(t)
  }, [tab, live, ops, requestSeo])
  // after a save or a sync, links may have been fixed: check them again
  useEffect(() => {
    linkCache.current = {}
  }, [nav.nonce, site?.sha])

  useEffect(() => {
    tell({ type: 'mode', mode: tool })
    if (tool === 'browse') {
      setSelected(null)
      setOthers([])
    }
  }, [tool, tell])
  useEffect(() => tell({ type: 'snap', on: view.snap }), [view.snap, tell])
  useEffect(() => tell({ type: 'view', grid: view.grid, rulers: view.rulers }), [view.grid, view.rulers, tell])
  useEffect(() => tell({ type: 'scale', scale }), [scale, tell])
  useEffect(() => tell({ type: 'locks', selectors: locks[path] ?? [] }), [locks, path, tell])

  // when a save, Claude's work or a roll back finishes, reload the canvas from the real source
  const prev = useRef(site?.status)
  useEffect(() => {
    const was = prev.current
    prev.current = site?.status
    if (was === 'working' && site?.status === 'ready' && site.last) {
      if (site.last.kind === 'save' || site.last.kind === 'discard' || (site.last.kind === 'publish' && site.last.ok)) {
        setOps(() => [])
        setRedo([])
      }
      if (site.last.kind === 'publish' && site.last.ok && !site.last.url?.includes('/compare/')) say('Pushed live. Publish → Deploy status shows it going out.')
      setSelected(null)
      setNav((n) => ({ path, nonce: n.nonce + 1 }))
    }
  }, [site?.status, site?.last, path, setOps, say])

  // keyboard: V select, H browse, Ctrl Z / Ctrl Shift Z, Ctrl F find, Esc steps back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a dialog (Studio's own or one a panel opened) has the keyboard; an open menu takes Esc for itself
      if (dialog || review || document.querySelector('.studio .st-review')) return
      if (e.key === 'Escape' && document.querySelector('.studio .st-menu-pop')) return
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault()
        return e.shiftKey ? redoLast() : undo()
      }
      if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault()
        return redoLast()
      }
      if ((e.ctrlKey || e.metaKey) && k === 'f') {
        e.preventDefault()
        return openTab('site', 'find')
      }
      if ((e.ctrlKey || e.metaKey) && k === 'v' && selected) {
        e.preventDefault()
        return paste()
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (k === 'v') setTool('select')
      if (k === 'h') setTool('browse')
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
  }, [selected, tool, tell, close, undo, redoLast, review, dialog, openTab, paste])

  const go = useCallback((p: string) => {
    setPath(p)
    setNav((n) => ({ path: p, nonce: n.nonce + 1 }))
    setSelected(null)
  }, [])

  // --- page details and share images become edits on the canvas like any other

  /** one edit per page and detail, updated as you change it again */
  const setMeta = (field: StudioMetaField, value: string, photo?: Uploaded) => {
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
    addOp({ id: newId(), kind: 'alt', page: seo.path, selector, label: `Image ${file}`, text: '', before: '', after: value })
  }

  /** an SEO fix that needs Claude: ready to send in the Claude tab, about the whole page */
  const askAbout = useCallback(
    (prompt: string) => {
      setSelected(null)
      tell({ type: 'clear' })
      setClaudeDraft(prompt)
      openTab('claude')
    },
    [tell, openTab],
  )

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
      void poll()
    } catch (e) {
      say((e as Error).message)
    }
  }

  const ask = async (prompt: string) => {
    try {
      await post('./api/studio/claude', { projectId, prompt, page: path, element: selected, width: main.w })
      void poll()
    } catch (e) {
      say((e as Error).message)
    }
  }

  /** a photo picked for something: swap it in, add it, or make it the share image */
  const usePhoto = async (purpose: PhotoPurpose, p: Picked) => {
    setDialog(null)
    try {
      if (purpose === 'share') {
        let up = p.upload
        if (!up && p.src && origin) {
          // a photo already in the site: the share image needs its own copy
          const blob = await (await fetch(new URL(p.src, origin).href)).blob()
          up = await uploadFile(blob, { name: p.name })
        }
        if (up) setMeta('og:image', up.name, up)
        return say('Share image set. Save to put it in the site.')
      }
      const ref = p.upload ? { upload: p.upload.id, name: p.upload.name } : { src: p.src, name: p.name }
      act(purpose, { ...ref, value: p.alt ?? p.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), scope: p.everywhere ? 'everywhere' : undefined })
      say(purpose === 'add-image' ? 'Photo added. Save to put it in the site.' : purpose === 'bg' ? 'Background swapped. Save to put it in the site.' : 'Photo swapped. Save to put it in the site.')
    } catch (e) {
      say((e as Error).message)
    }
  }

  const toggleLock = useCallback(
    (selector: string) =>
      setLocks((l) => {
        const list = l[path] ?? []
        const next = list.includes(selector) ? list.filter((s) => s !== selector) : [...list, selector]
        return { ...l, [path]: next }
      }),
    [path, setLocks],
  )

  // keep the phone preview showing your edits
  const [phoneOn, setPhoneOn] = useState(false)
  useEffect(() => {
    // still on from earlier for this site: keep it following
    getJson<{ on: boolean; projectId: string | null }>('./api/studio/phone')
      .then((p) => p.on && p.projectId === projectId && setPhoneOn(true))
      .catch(() => {})
  }, [projectId])
  useEffect(() => {
    if (!phoneOn) return
    const t = setTimeout(() => void post('./api/studio/phone', { projectId, page: path, ops }).catch(() => {}), 700)
    return () => clearTimeout(t)
  }, [phoneOn, ops, path, projectId])

  const second = view.compare ? sizeOf(view.compare, view.custom, false) : null
  const src = live ? `${origin}${nav.path}` : null
  const unpublished = site?.changed.length ?? 0

  const ctx: StudioCtx | null =
    site && origin
      ? {
          projectId,
          project,
          site,
          origin,
          path,
          ops,
          working,
          width: main.w,
          selected,
          design,
          seo,
          tell,
          act,
          addOp,
          removeOp,
          say,
          go,
          refresh: () => void poll(),
          claude: askAbout,
          on: listen,
          pickPhoto: (purpose) => setDialog({ kind: 'picker', purpose }),
          editPhoto: () => setDialog({ kind: 'editor' }),
          openTab,
          upload: doUpload,
        }
      : null

  const lockedHere = locks[path] ?? []

  return (
    <div className="studio" role="dialog" aria-label={`Studio: ${project?.name ?? 'site'}`} lang="en-GB">
      <header className="st-bar">
        <span className="st-logo">
          <Icon.studio size={18} /> <span>Studio</span>
        </span>
        <select
          className="st-site"
          value={projectId}
          onChange={(e) => (e.target.value === '__all' ? setDialog({ kind: 'overview' }) : openStudio(e.target.value))}
          aria-label="Site"
        >
          {sites.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__all">All sites…</option>
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
        <SizesMenu design={design} width={main.w} name={project?.name ?? 'This site'} onPick={(w) => setView({ preset: 'custom', turned: false, custom: { w, h: view.preset === 'custom' ? view.custom.h : Math.round(main.h) } })} />
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
          <button aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Edit: click to select (Shift adds more), double-click to edit text, drag to move (V)">
            <Icon.pointer size={15} /> <span>Edit</span>
          </button>
        </div>
        <button className="st-btn" onClick={undo} disabled={!ops.length} title="Undo (Ctrl Z)">
          <Icon.undo size={17} />
        </button>
        <button className="st-btn" onClick={redoLast} disabled={!redo.length} title="Redo (Ctrl Shift Z)">
          <Icon.redo size={17} />
        </button>
        <Menu icon={<Icon.eye size={17} />} title="View: snapping, grid and rulers">
          {() => (
            <>
              <MenuItem checked={view.snap} onClick={() => setView({ snap: !view.snap })}>
                Snap to line up
              </MenuItem>
              <MenuItem checked={view.grid} onClick={() => setView({ grid: !view.grid })}>
                Layout grid
              </MenuItem>
              <MenuItem checked={view.rulers} onClick={() => setView({ rulers: !view.rulers })}>
                Rulers
              </MenuItem>
              <p className="st-menu-note">Hold Alt over the page to measure the distance from what’s selected to anything else. Alt while dragging moves freely.</p>
            </>
          )}
        </Menu>
        <Menu icon={<Icon.more size={17} />} title="Tools">
          {(done) => (
            <>
              <MenuItem
                icon={<Icon.search size={15} />}
                hint="Ctrl F"
                onClick={() => {
                  done()
                  openTab('site', 'find')
                }}
                disabled={!live}
              >
                Find and replace
              </MenuItem>
              <MenuItem
                icon={<Icon.mobile size={15} />}
                onClick={() => {
                  done()
                  setDialog({ kind: 'phone' })
                }}
                disabled={!live}
              >
                Preview on your phone
              </MenuItem>
              <MenuItem
                icon={<Icon.camera size={15} />}
                onClick={() => {
                  done()
                  setDialog({ kind: 'shot' })
                }}
                disabled={!live}
              >
                Screenshot for a client
              </MenuItem>
              {src && (
                <MenuItem
                  icon={<Icon.external size={15} />}
                  onClick={() => {
                    done()
                    window.open(`${origin}${path}`, '_blank', 'noreferrer')
                  }}
                >
                  Open this preview in your browser
                </MenuItem>
              )}
              <MenuItem
                icon={<Icon.refresh size={15} />}
                onClick={() => {
                  done()
                  void open(true)
                }}
                disabled={!site || !['ready', 'error', 'unsupported'].includes(site.status) || ops.length > 0}
              >
                Get the latest from GitHub
              </MenuItem>
              <MenuItem
                icon={<Icon.overview size={15} />}
                onClick={() => {
                  done()
                  setDialog({ kind: 'overview' })
                }}
              >
                All sites
              </MenuItem>
            </>
          )}
        </Menu>
        <button className="st-btn" aria-pressed={layersOpen} onClick={() => setLayersOpen(!layersOpen)} title="Layers: everything on the page, as a list" disabled={!live}>
          <Icon.list size={17} />
        </button>
        <button className="st-btn" aria-pressed={panel} onClick={() => setPanel(!panel)} title="Side panel">
          <Icon.sidebar size={17} />
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
        {layersOpen && ctx && <Layers ctx={ctx} locked={lockedHere} onLock={toggleLock} onClose={() => setLayersOpen(false)} />}
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
          busy={working ? (site?.message ?? 'Working…') : null}
          rulers={view.rulers}
        />
        {panel && ctx && (
          <aside className="st-side" aria-label="Studio panel">
            <div className="st-tabs" role="tablist">
              {(
                [
                  ['element', selected && others.length ? `Element (${others.length + 1})` : 'Element'],
                  ['site', 'Site'],
                  ['checks', 'Checks'],
                  ['publish', ops.length || unpublished ? `Publish (${ops.length + (site?.notes.length || unpublished)})` : 'Publish'],
                  ['claude', 'Claude'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => openTab(k)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'element' &&
              (selected ? (
                others.length ? (
                  <MultiInspector ctx={ctx} el={selected} others={others} locked={lockedHere} onLock={toggleLock} />
                ) : (
                  <Inspector ctx={ctx} el={selected} editing={editing} locked={lockedHere.includes(selected.selector)} onLock={() => toggleLock(selected.selector)} onPaste={paste} onEmbed={() => setDialog({ kind: 'embed' })} />
                )
              ) : (
                <Hints tool={tool} onEdit={() => setTool('select')} />
              ))}
            {tab === 'site' && <SiteTab ctx={ctx} sub={sub} />}
            {tab === 'checks' && (
              <ChecksTab
                ctx={ctx}
                sub={sub}
                crawl={crawl}
                onMeta={setMeta}
                onShareImage={() => setDialog({ kind: 'picker', purpose: 'share' })}
                onAlt={setAltFor}
                onCrawl={startCrawl}
                onStopCrawl={() => setCrawl((c) => (c ? { ...c, queue: [] } : c))}
                onRefresh={() => {
                  setSeo(null)
                  linkCache.current = {}
                  requestSeo()
                }}
              />
            )}
            {tab === 'publish' && <PublishTab ctx={ctx} onSave={save} onReview={() => setReview(true)} onPhone={() => setDialog({ kind: 'phone' })} onShot={() => setDialog({ kind: 'shot' })} />}
            {tab === 'claude' && <ClaudePanel site={ctx.site} element={selected} onAsk={ask} working={working} text={claudeDraft} setText={setClaudeDraft} />}
          </aside>
        )}
        {crawl && crawl.queue.length > 0 && origin && live && <SiteCrawl key={crawl.queue[0]} origin={origin} path={crawl.queue[0]} ops={ops} known={linkCache} onReport={crawled} />}
      </div>
      {review && ctx && <Review ctx={ctx} onClose={() => setReview(false)} />}
      {dialog?.kind === 'picker' && ctx && <PhotoPicker ctx={ctx} purpose={dialog.purpose} onPick={(p) => void usePhoto(dialog.purpose, p)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'editor' && ctx && selected?.image && <PhotoEditor ctx={ctx} el={selected} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'embed' && ctx && <EmbedDialog ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'shot' && ctx && <ShotDialog ctx={ctx} size={main} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'phone' && ctx && <PhoneDialog ctx={ctx} onState={setPhoneOn} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'overview' && (
        <Overview
          current={projectId}
          onOpen={(id) => {
            setDialog(null)
            if (id !== projectId) openStudio(id)
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

const labelFor = (id: PresetId, turned: boolean) => `${id === 'custom' ? 'Custom' : PRESETS.find((p) => p.id === id)!.label}${turned ? ' · sideways' : ''}`

// --- Top bar extras ------------------------------------------------------------------------

/** the widths where this site's layout changes, read from its own stylesheets */
function SizesMenu({ design, width, name, onPick }: { design: StudioDesign | null; width: number; name: string; onPick: (w: number) => void }) {
  const edges = useMemo(() => {
    const at = new Map<number, number>()
    for (const b of design?.breakpoints ?? []) {
      // a max-width rule stops at W, a min-width one starts at W: either way the change is between two widths
      const above = b.kind === 'max' ? b.width + 1 : b.width
      if (above < 280 || above > 2600) continue
      at.set(above, (at.get(above) ?? 0) + b.rules)
    }
    return [...at.entries()].sort((a, b) => a[0] - b[0])
  }, [design])
  return (
    <Menu icon={<Icon.ruler size={16} />} title="This site’s own screen sizes (breakpoints)" wide>
      {(done) => (
        <div className="st-sizes">
          <p className="st-menu-note">
            Where {name} changes its layout. Pick a width to see each side of it.
          </p>
          {!design && <Spin>Reading the site’s styles…</Spin>}
          {design && !edges.length && <p className="st-menu-note">This page has no screen-size rules.</p>}
          {edges.map(([w, rules]) => (
            <div key={w} className="st-size-row" data-here={width === w || width === w - 1 || undefined}>
              <span>
                <b>{w}px</b> <small>{rules} rule{rules === 1 ? '' : 's'}</small>
              </span>
              <button
                className="st-pill"
                aria-pressed={width === w - 1}
                onClick={() => {
                  done()
                  onPick(w - 1)
                }}
                title={`Just narrower: ${w - 1}px`}
              >
                {w - 1}
              </button>
              <button
                className="st-pill"
                aria-pressed={width === w}
                onClick={() => {
                  done()
                  onPick(w)
                }}
                title={`From ${w}px`}
              >
                {w}
              </button>
            </div>
          ))}
        </div>
      )}
    </Menu>
  )
}

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
        <p>Click anything on the page to select it. Shift-click to select more than one.</p>
      )}
      <ul>
        <li>
          <b>Double-click</b> text to change it: <b>Ctrl B</b> bold, <b>Ctrl I</b> italic, <b>Ctrl K</b> link, <b>Shift Enter</b> new line
        </li>
        <li>
          <b>Drag</b> to move: it snaps to line up with things around it (hold Alt to drag freely)
        </li>
        <li>
          <b>Alt</b> over the page measures distances; <b>arrow keys</b> nudge 1px, with Shift 10px
        </li>
        <li>
          <b>Ctrl C</b> copies a card or section, <b>Ctrl V</b> pastes it after what’s selected, on any page
        </li>
        <li>
          <b>Drop a photo</b> from your computer onto a photo to swap it
        </li>
        <li>
          <b>Save</b> writes your edits into the site’s real files, then <b>Review &amp; push live</b> sends them to GitHub
        </li>
      </ul>
    </div>
  )
}

function ClaudePanel({ site, element, onAsk, working, text, setText }: { site: StudioSite; element: StudioElement | null; onAsk: (p: string) => void; working: boolean; text: string; setText: (s: string) => void }) {
  const send = () => {
    if (!text.trim() || working) return
    onAsk(text.trim())
    setText('')
  }
  const last = site.last?.kind === 'claude' ? site.last : null
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
        spellCheck
      />
      <button className="st-primary" onClick={send} disabled={working || !text.trim()}>
        {working ? 'Working…' : 'Ask Claude'}
      </button>
      {working && site.message && <Spin>{site.message}</Spin>}
      {last && <Result r={last} />}
    </div>
  )
}

// --- Status -------------------------------------------------------------------------------

const BUSY: StudioSite['status'][] = ['idle', 'syncing', 'installing', 'building', 'starting']

function StatusLine({ site, project, error, demo, flash }: { site: StudioSite | null; project: Project | null; error: string | null; demo: boolean; flash: string | null }) {
  if (demo) return <div className="st-status">Demo data: connect GitHub in Settings to open your real sites in Studio.</div>
  if (error) return <div className="st-status" data-tone="bad">{error}</div>
  if (!site)
    return (
      <div className="st-status" data-tone="busy">
        <i className="st-spin" /> Opening {project?.name ?? 'the site'}…
      </div>
    )
  if (BUSY.includes(site.status) || site.status === 'working')
    return (
      <div className="st-status" data-tone="busy">
        <i className="st-spin" /> {site.message || 'Getting ready…'}
      </div>
    )
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
          <span className="st-kind" title={site.openedMs !== null ? `Opened in ${(site.openedMs / 1000).toFixed(1)} s` : undefined}>
            {KIND_LABEL[site.kind]}
          </span>
          {site.schedule && (
            <span className="st-changed" data-tone="sched" title={`Booked by ${site.schedule.by}`}>
              <Icon.clock size={12} /> Goes live {new Date(site.schedule.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
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
      <select value={known ? path : ''} onChange={(e) => e.target.value && onGo(e.target.value)} disabled={disabled || !pages.length} aria-label="Page">
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
  rulers,
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
  rulers: boolean
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
    <div className="st-canvas" ref={area} data-zoomed={zoom !== 'fit' || undefined} data-busy={!!busy || undefined} data-rulers={rulers || undefined}>
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
                {busy && i === 0 && (
                  <div className="st-busy">
                    <i className="st-spin" /> {busy}
                  </div>
                )}
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
  if (error || site?.status === 'error')
    return (
      <div className="st-empty" data-tone="bad">
        <p>{error ?? site?.message}</p>
      </div>
    )
  return (
    <div className="st-empty">
      <i className="st-spin st-spin-lg" />
      <p>{site?.message || `Opening ${project?.name ?? 'the site'}`}</p>
      <small>Studio works from its own copy of each repo, synced to the latest commit on GitHub. A site you’ve opened before, with nothing new on GitHub, opens in about a second.</small>
    </div>
  )
}
