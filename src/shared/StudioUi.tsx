import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Project, SeoReport, StudioDesign, StudioElement, StudioMedia, StudioOp, StudioResult, StudioSite } from '../data/types'
import { relTime } from '../data/derive'
import { Icon } from './icons'

// The small pieces every part of Studio's side panel is built from: talking to
// the local API, uploads, collapsible sections, segmented controls, dropdown
// menus, dialogs and a few form controls, so every panel looks and behaves the same.

// --- The local API ---------------------------------------------------------------------------

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error((d as { error?: string }).error ?? 'Something went wrong'), { data: d, status: r.status })
  return d as T
}

export async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error((d as { error?: string }).error ?? 'Something went wrong'), { data: d, status: r.status })
  return d as T
}

/** a POST that answers with a file (a screenshot) */
export async function postBlob(url: string, body: unknown): Promise<Blob> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error((d as { error?: string }).error ?? 'Something went wrong')
  }
  return r.blob()
}

export const q = (o: Record<string, string | number | boolean | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

// --- Files -----------------------------------------------------------------------------------

/**
 * Photos straight off a camera or phone are far too big for a website: anything
 * over 2400px or 500 KB is resized and saved as WebP before it goes in. Sites
 * with their own image pipeline get the original instead, and make it web-ready themselves.
 */
export async function optimise(file: File): Promise<File> {
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

export interface Uploaded {
  id: string
  name: string
}

const MAX = 25 * 1024 * 1024

/** send a file to Studio's uploads; photos are made web-ready first unless the site does that itself */
export async function uploadFile(original: File | Blob, opts: { name?: string; optimise?: boolean } = {}): Promise<Uploaded> {
  const name = opts.name ?? (original instanceof File ? original.name : 'photo.png')
  let file: File | Blob = original
  if (opts.optimise && original instanceof File) file = await optimise(original)
  if (file.size > MAX) throw new Error(`That file is ${(file.size / 1e6).toFixed(0)} MB: Studio takes up to 25 MB. For a video, export it smaller first.`)
  const r = await fetch(`./api/upload?name=${encodeURIComponent(file instanceof File ? file.name : name)}`, { method: 'POST', body: file })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error ?? 'Upload failed')
  return d
}

/** pick a file with the system's file chooser */
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    // closing the chooser without picking fires no event: focus coming back means cancelled
    window.addEventListener('focus', () => setTimeout(() => !input.files?.length && resolve(null), 800), { once: true })
    input.click()
  })
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

export async function copyText(s: string) {
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch {
    return false
  }
}

// --- Saved preferences -----------------------------------------------------------------------

export function useLocal<T>(key: string, initial: T): [T, (v: T | ((x: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((x: T) => T)) =>
      setV((cur) => {
        const val = typeof next === 'function' ? (next as (x: T) => T)(cur) : next
        try {
          localStorage.setItem(key, JSON.stringify(val))
        } catch {
          /* storage full or off */
        }
        return val
      }),
    [key],
  )
  return [v, set]
}

// --- Layout pieces ---------------------------------------------------------------------------

/** a titled part of a panel that folds away; remembers whether it was open */
export function Section({ id, title, icon, badge, children, open: start = true, actions }: { id: string; title: string; icon?: React.ReactNode; badge?: React.ReactNode; children: React.ReactNode; open?: boolean; actions?: React.ReactNode }) {
  const [open, setOpen] = useLocal(`ard.studio.sec.${id}`, start)
  return (
    <section className="st-sec" data-open={open}>
      <header>
        <button className="st-sec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon.chevron size={13} />
          {icon}
          <span>{title}</span>
          {badge}
        </button>
        {actions}
      </header>
      {open && <div className="st-sec-body">{children}</div>}
    </section>
  )
}

/** a row of mutually exclusive buttons */
export function Seg<T extends string>({ value, options, onChange, label, small }: { value: T; options: readonly (readonly [T, React.ReactNode, string?])[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className="st-seg" data-small={small || undefined} role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} role="radio" aria-checked={value === v} aria-pressed={value === v} onClick={() => onChange(v)} title={title}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** a button that opens a dropdown menu; the menu closes on a click outside, Esc, or picking an item */
export function Menu({ label, icon, title, children, align = 'right', disabled, wide }: { label?: React.ReactNode; icon?: React.ReactNode; title: string; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right'; disabled?: boolean; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    // the canvas is an iframe: a click in it never reaches this window, but it takes focus away
    window.addEventListener('blur', () => setOpen(false), { once: true })
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  // keep the menu on screen
  useLayoutEffect(() => {
    if (!open || !pop.current) return setShift(0)
    const r = pop.current.getBoundingClientRect()
    if (r.right > innerWidth - 8) setShift(innerWidth - 8 - r.right)
    else if (r.left < 8) setShift(8 - r.left)
  }, [open])
  return (
    <div className="st-menu" ref={box}>
      <button className={label ? 'st-menu-btn' : 'st-btn'} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} title={title} disabled={disabled}>
        {icon}
        {label && <span>{label}</span>}
        {label && <Icon.chevron size={12} />}
      </button>
      {open && (
        <div className="st-menu-pop" role="menu" ref={pop} data-align={align} data-wide={wide || undefined} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, checked, disabled, hint, tone }: { icon?: React.ReactNode; children: React.ReactNode; onClick: () => void; checked?: boolean; disabled?: boolean; hint?: string; tone?: 'bad' }) {
  return (
    <button role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} className="st-menu-item" onClick={onClick} disabled={disabled} data-tone={tone}>
      <i>{checked !== undefined ? checked ? <Icon.check size={14} /> : null : icon}</i>
      <span>{children}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  )
}

/** a dialog over Studio, closed with Esc or a click outside */
export function Modal({ title, children, footer, onClose, wide, tall }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; wide?: boolean; tall?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return (
    <div className="st-review" role="dialog" aria-label={typeof title === 'string' ? title : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-review-box" data-wide={wide || undefined} data-tall={tall || undefined}>
        <header>
          <b>{title}</b>
          <button className="st-btn" onClick={onClose} title="Close (Esc)">
            <Icon.close size={16} />
          </button>
        </header>
        <div className="st-modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export function Toggle({ on, onChange, children, disabled, title }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="st-toggle" title={title} data-disabled={disabled || undefined}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <i aria-hidden />
      <span>{children}</span>
    </label>
  )
}

export const Swatch = ({ c }: { c: string }) => <i className="st-swatch" style={{ background: c }} />

export const Spin = ({ children }: { children?: React.ReactNode }) => (
  <p className="st-working">
    <i className="st-spin" /> {children}
  </p>
)

const RESULT_WORD: Record<StudioResult['kind'], string> = { save: 'Saved', claude: 'Claude', publish: 'Published', discard: 'Discarded', revert: 'Rolled back', content: 'Content', photos: 'Photos', deploy: 'Deploy' }

const FAIL_WORD: Partial<Record<StudioResult['kind'], string>> = { save: 'Not saved', publish: 'Not pushed', discard: 'Not discarded', revert: 'Not rolled back' }

export function Result({ r }: { r: StudioResult }) {
  return (
    <div className="st-result" data-ok={r.ok}>
      <b>{r.title || (!r.ok && FAIL_WORD[r.kind]) || RESULT_WORD[r.kind]}</b> <span className="st-muted">{relTime(r.at)}</span>
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

/** a number box that commits on Enter or leaving it */
export function NumberBox({ value, onCommit, suffix = 'px', min = 0, max = 2000, label, width = 56 }: { value: number | null; onCommit: (n: number) => void; suffix?: string; min?: number; max?: number; label: string; width?: number }) {
  const [v, setV] = useState(value === null ? '' : String(value))
  useEffect(() => setV(value === null ? '' : String(value)), [value])
  const commit = () => {
    const n = Number(v)
    if (v.trim() === '' || !Number.isFinite(n)) return setV(value === null ? '' : String(value))
    const c = Math.max(min, Math.min(max, Math.round(n)))
    if (c !== value) onCommit(c)
    setV(String(c))
  }
  return (
    <span className="st-num" style={{ width }}>
      <input value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.-]/g, ''))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} aria-label={label} inputMode="numeric" />
      <em>{suffix}</em>
    </span>
  )
}

/**
 * A labelled text box that applies with Enter or its button (never on blur: a
 * click on the canvas moves the selection first, and the change would land on
 * the wrong thing). Esc puts it back.
 */
export function TextField({
  label,
  value,
  onCommit,
  placeholder,
  multiline,
  list,
  disabled,
  extra,
  action = 'Set',
  mono,
  allowEmpty,
}: {
  label: React.ReactNode
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  multiline?: boolean
  list?: string
  disabled?: boolean
  /** shown after the label, like a warning or a button */
  extra?: React.ReactNode
  action?: string
  mono?: boolean
  allowEmpty?: boolean
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const dirty = v.trim() !== value.trim() && (allowEmpty || v.trim() !== '')
  const commit = () => {
    if (dirty && !disabled) onCommit(v.trim())
  }
  const name = typeof label === 'string' ? label : undefined
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && dirty) {
      e.stopPropagation()
      setV(value)
    }
    if (multiline && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commit()
    }
  }
  return (
    <form
      className="st-field"
      onSubmit={(e) => {
        e.preventDefault()
        commit()
      }}
    >
      <label>
        {label}
        {extra}
      </label>
      <div>
        {multiline ? (
          <textarea value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} placeholder={placeholder} disabled={disabled} rows={3} aria-label={name} spellCheck />
        ) : (
          <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} placeholder={placeholder} disabled={disabled} list={list} aria-label={name} spellCheck={!mono} data-mono={mono || undefined} />
        )}
        <button className="st-pill" data-dirty={dirty || undefined} disabled={disabled || !dirty} title={multiline ? 'Ctrl Enter' : 'Enter'}>
          {action}
        </button>
      </div>
    </form>
  )
}

/** "1.2 MB" */
export const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** a colour as #rrggbb when the browser can tell, for <input type=color> */
export function hexOf(c: string): string | null {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (m) return m[1].length === 3 ? `#${[...m[1]].map((x) => x + x).join('')}`.toLowerCase() : `#${m[1].toLowerCase()}`
  const rgb = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`
  return null
}

// --- Screen sizes ----------------------------------------------------------------------------

/** the widths where the site's layout changes: the first width of each new layout */
export function edgesOf(design: StudioDesign | null): number[] {
  const at = new Set<number>()
  for (const b of design?.breakpoints ?? []) {
    // a max-width rule stops at W, a min-width one starts at W: either way the change is between two widths
    const edge = b.kind === 'max' ? b.width + 1 : b.width
    if (edge >= 280 && edge <= 2600) at.add(edge)
  }
  return [...at].sort((a, b) => a - b)
}

export type RangeId = 'all' | 'down' | 'up' | 'only'
export interface ScreenRange {
  id: RangeId
  label: string
  media: StudioMedia | null
}

/**
 * The screen sizes a design change can apply to, from the canvas's width and the
 * site's own breakpoints. On the widest layout a change applies everywhere (the
 * smaller layouts inherit it); on a narrower one, to this size and smaller.
 */
export function rangesAt(design: StudioDesign | null, width: number): { list: ScreenRange[]; initial: RangeId } {
  const edges = edgesOf(design)
  const below = [...edges].reverse().find((e) => e <= width)
  const above = edges.find((e) => e > width)
  const list: ScreenRange[] = [{ id: 'all', label: 'Every screen size', media: null }]
  if (above) list.push({ id: 'down', label: `Up to ${above - 1}px (this size and smaller)`, media: { max: above - 1 } })
  if (below) list.push({ id: 'up', label: `${below}px and wider (this size and bigger)`, media: { min: below } })
  if (above && below) list.push({ id: 'only', label: `Only ${below} to ${above - 1}px`, media: { min: below, max: above - 1 } })
  return { list, initial: above ? 'down' : 'all' }
}

export const sameMedia = (a: StudioMedia | null | undefined, b: StudioMedia | null | undefined) => (a?.min ?? null) === (b?.min ?? null) && (a?.max ?? null) === (b?.max ?? null)

/** "24px" from "24px", "1.5rem" (as 24) or null */
export function pxOf(v: string | undefined | null): number | null {
  const m = (v ?? '').trim().match(/^(-?[\d.]+)(px|rem|em)?$/)
  if (!m) return null
  const n = Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null
}

// --- What every panel gets from Studio ------------------------------------------------------

/** what a new or library photo is for */
export type PhotoPurpose = 'image' | 'add-image' | 'bg' | 'share'
export type Tab = 'element' | 'site' | 'checks' | 'publish' | 'claude'

export interface StudioCtx {
  projectId: string
  project: Project | null
  site: StudioSite
  /** the preview's address, http://127.0.0.1:port */
  origin: string
  /** the page on the canvas */
  path: string
  /** edits on the canvas, not saved yet */
  ops: StudioOp[]
  working: boolean
  /** the canvas's width in CSS pixels */
  width: number
  selected: StudioElement | null
  design: StudioDesign | null
  seo: SeoReport | null
  /** send a message to the page(s) on the canvas */
  tell: (msg: Record<string, unknown>) => void
  /** do something to the selected element */
  act: (action: string, extra?: Record<string, unknown>) => void
  /** an edit made by Studio itself (theme, find and replace): shown on the canvas and listed */
  addOp: (op: StudioOp, replace?: string) => void
  removeOp: (id: string) => void
  say: (s: string) => void
  go: (path: string) => void
  /** read the site's state again (after starting a job on the server) */
  refresh: () => void
  /** put a request in the Claude tab */
  claude: (prompt: string) => void
  /** listen for one kind of message from the main canvas */
  on: (type: string, fn: (d: Record<string, unknown>) => void) => () => void
  pickPhoto: (purpose: PhotoPurpose) => void
  editPhoto: () => void
  openTab: (t: Tab, sub?: string) => void
  /** upload a file the way this site wants it (originals for a site with its own image pipeline) */
  upload: (f: File | Blob, name?: string) => Promise<Uploaded>
}
