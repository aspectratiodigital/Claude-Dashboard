import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioOp, StudioToken } from '../data/types'
import type { ContentData, ContentFile, FrontValue, LibraryPhoto, SearchHit } from '../data/studio-api'
import { Icon } from './icons'
import { Result, Seg, Spin, Toggle, bytes, getJson, hexOf, post, q, type StudioCtx } from './StudioUi'
import { Colours, Fonts } from './StudioTheme'

// The Site tab: things that belong to the whole site rather than one element.
// Theme (its colours, fonts and design tokens), Content (its data and copy files as
// forms), Photos (every photo in the repo, what uses each, and the unused
// ones to tidy away) and Find (on this page or every page, and replace).

type Sub = 'theme' | 'content' | 'photos' | 'find'
const SUBS: readonly (readonly [Sub, string])[] = [
  ['theme', 'Theme'],
  ['content', 'Content'],
  ['photos', 'Photos'],
  ['find', 'Find'],
]

const newId = () => Math.random().toString(36).slice(2, 10)

export function SiteTab({ ctx, sub }: { ctx: StudioCtx; sub?: string }) {
  const [tab, setTab] = useState<Sub>(() => (SUBS.some(([k]) => k === sub) ? (sub as Sub) : ((localStorage.getItem('ard.studio.site-sub') as Sub | null) ?? 'theme')))
  useEffect(() => {
    if (sub && SUBS.some(([k]) => k === sub)) setTab(sub as Sub)
  }, [sub])
  const pick = (s: Sub) => {
    setTab(s)
    try {
      localStorage.setItem('ard.studio.site-sub', s)
    } catch {
      /* storage off */
    }
  }
  return (
    <div className="st-panel">
      <div className="st-subtabs">
        <Seg value={tab} options={SUBS} onChange={pick} label="Site" small />
      </div>
      {tab === 'theme' && <Theme ctx={ctx} />}
      {tab === 'content' && <Content ctx={ctx} />}
      {tab === 'photos' && <Photos ctx={ctx} />}
      {tab === 'find' && <Find ctx={ctx} />}
    </div>
  )
}

// --- Theme -----------------------------------------------------------------------------------

type ThemeSub = 'colours' | 'fonts' | 'tokens'
const THEME_SUBS: readonly (readonly [ThemeSub, string])[] = [
  ['colours', 'Colours'],
  ['fonts', 'Fonts'],
  ['tokens', 'Tokens'],
]

function Theme({ ctx }: { ctx: StudioCtx }) {
  const [sub, setSub] = useState<ThemeSub>(() => {
    try {
      const s = localStorage.getItem('ard.studio.theme-sub') as ThemeSub | null
      return s && THEME_SUBS.some(([k]) => k === s) ? s : 'colours'
    } catch {
      return 'colours'
    }
  })
  const pick = (s: ThemeSub) => {
    setSub(s)
    try {
      localStorage.setItem('ard.studio.theme-sub', s)
    } catch {
      /* storage off */
    }
  }
  return (
    <>
      <div className="st-subtabs st-subtabs-2">
        <Seg value={sub} options={THEME_SUBS} onChange={pick} label="Theme" small />
      </div>
      {sub === 'colours' && <Colours ctx={ctx} />}
      {sub === 'fonts' && <Fonts ctx={ctx} />}
      {sub === 'tokens' && <Tokens ctx={ctx} />}
    </>
  )
}

type TokenKind = 'colour' | 'type' | 'space' | 'all'
const isType = (t: StudioToken) => t.kind === 'font' || /font|text|type|fs-|h[1-6]|leading|line-height|heading|title|weight/i.test(t.name)

/** the site's design tokens (CSS variables on :root), to change one in one place */
function Tokens({ ctx }: { ctx: StudioCtx }) {
  const [kind, setKind] = useState<TokenKind>('colour')
  const [filter, setFilter] = useState('')
  const tokens = ctx.design?.tokens
  const changed = useMemo(() => new Map(ctx.ops.filter((o): o is Extract<StudioOp, { kind: 'theme' }> => o.kind === 'theme').map((o) => [o.name, o])), [ctx.ops])
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (tokens ?? []).filter((t) => {
      if (f && !t.name.toLowerCase().includes(f) && !t.value.toLowerCase().includes(f)) return false
      if (kind === 'colour') return t.kind === 'colour'
      if (kind === 'type') return t.kind !== 'colour' && isType(t)
      if (kind === 'space') return t.kind === 'size' && !isType(t)
      return true
    })
  }, [tokens, kind, filter])

  const set = (t: StudioToken, raw: string) => {
    const value = raw.trim()
    const existing = changed.get(t.name)
    const before = existing?.before ?? t.value
    if (!value) return
    if (/[{};<>]/.test(value)) return ctx.say('That value can’t be used: no braces, semicolons or angle brackets.')
    if (value === before.trim()) {
      if (existing) ctx.removeOp(existing.id)
      return
    }
    ctx.addOp({ id: existing?.id ?? newId(), kind: 'theme', page: ctx.path, selector: ':root', label: 'Theme', text: '', name: t.name, before, after: value }, existing?.id)
  }

  if (!tokens) return <Spin>Reading the site’s styles…</Spin>
  if (!tokens.length)
    return (
      <div className="st-pad">
        <p className="st-muted">This site doesn’t keep its colours and sizes in design tokens (CSS variables on :root), so there’s no theme to change in one place. Change things one at a time in the Element tab, or ask Claude.</p>
      </div>
    )
  return (
    <div className="st-pad">
      <p className="st-tip">The site’s named colours and sizes (its CSS variables). Change one and it changes everywhere the site uses it, on every page.</p>
      <div className="st-row">
        <Seg
          small
          value={kind}
          label="Kind of token"
          onChange={setKind}
          options={[
            ['colour', 'Colours'],
            ['type', 'Type'],
            ['space', 'Sizes'],
            ['all', 'All'],
          ]}
        />
        <input className="st-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter tokens" spellCheck={false} />
      </div>
      {changed.size > 0 && (
        <p className="st-chip">
          {changed.size} theme change{changed.size === 1 ? '' : 's'}, not saved yet.{' '}
          <button className="st-link" onClick={() => [...changed.values()].forEach((o) => ctx.removeOp(o.id))}>
            Undo them
          </button>
        </p>
      )}
      <ul className="st-tokens">
        {shown.map((t) => (
          <TokenRow key={t.name} t={t} op={changed.get(t.name)} onSet={(v) => set(t, v)} onUndo={() => changed.get(t.name) && ctx.removeOp(changed.get(t.name)!.id)} off={ctx.working} />
        ))}
        {!shown.length && <li className="st-muted">None {filter ? 'match' : 'of this kind'}.</li>}
      </ul>
    </div>
  )
}

function TokenRow({ t, op, onSet, onUndo, off }: { t: StudioToken; op?: Extract<StudioOp, { kind: 'theme' }>; onSet: (v: string) => void; onUndo: () => void; off: boolean }) {
  const value = op?.after ?? t.value
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const timer = useRef<number | undefined>(undefined)
  const hex = t.kind === 'colour' ? hexOf(value) : null
  return (
    <li data-changed={!!op || undefined}>
      {t.kind === 'colour' ? (
        <label className="st-sw st-sw-big" style={{ background: value }} title={hex ? 'Pick a colour' : 'This colour can only be typed'}>
          {hex && (
            <input
              type="color"
              value={hex}
              disabled={off}
              onChange={(e) => {
                const c = e.target.value
                setV(c)
                clearTimeout(timer.current)
                timer.current = window.setTimeout(() => onSet(c), 300)
              }}
            />
          )}
        </label>
      ) : (
        <i className="st-token-kind">{t.kind === 'font' ? 'Aa' : t.kind === 'size' ? '↔' : '·'}</i>
      )}
      <div>
        <b title={t.name}>{t.name.replace(/^--/, '')}</b>
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSet(v)
            if (e.key === 'Escape') setV(value)
          }}
          onBlur={() => v.trim() !== value.trim() && onSet(v)}
          disabled={off}
          aria-label={`${t.name} value`}
          spellCheck={false}
        />
      </div>
      {op && (
        <button className="st-btn" onClick={onUndo} title={`Back to ${op.before}`}>
          <Icon.undo size={13} />
        </button>
      )}
    </li>
  )
}

// --- Content files as forms ------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function setIn(root: Json, path: (string | number)[], value: Json): Json {
  if (!path.length) return value
  const [k, ...rest] = path
  if (Array.isArray(root)) {
    const copy = [...root]
    copy[k as number] = setIn(copy[k as number] ?? null, rest, value)
    return copy
  }
  const obj = (root && typeof root === 'object' ? root : {}) as Record<string, Json>
  return { ...obj, [k]: setIn(obj[k as string] ?? null, rest, value) }
}

function getIn(root: Json, path: (string | number)[]): Json {
  let cur: Json = root
  for (const k of path) cur = cur && typeof cur === 'object' ? ((cur as Record<string, Json>)[k as string] ?? null) : null
  return cur
}

/** a blank copy of an item, for "add another": same shape, empty words */
function blank(v: Json): Json {
  if (typeof v === 'string') return ''
  if (typeof v === 'number') return 0
  if (typeof v === 'boolean') return false
  if (Array.isArray(v)) return []
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]))
  return null
}

const nice = (k: string) =>
  k
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b(url|seo|cta|faq|id|og|nap|gbp|ga4)\b/gi, (w) => w.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase())

/** a few words that say which item this is: its title or name */
function previewOf(v: Json): string {
  if (typeof v === 'string') return v.slice(0, 60)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`
  if (v && typeof v === 'object') {
    for (const k of ['title', 'name', 'label', 'heading', 'q', 'question', 'slug', 'id']) if (typeof v[k] === 'string' && v[k]) return (v[k] as string).slice(0, 60)
    const first = Object.values(v).find((x) => typeof x === 'string' && x)
    return typeof first === 'string' ? first.slice(0, 60) : `${Object.keys(v).length} fields`
  }
  return ''
}

function Content({ ctx }: { ctx: StudioCtx }) {
  const [files, setFiles] = useState<ContentFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<string>(() => localStorage.getItem(`ard.studio.content.${ctx.projectId}`) ?? '')
  const [data, setData] = useState<ContentData | null>(null)
  const [draft, setDraft] = useState<ContentData | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getJson<{ files: ContentFile[] }>(`./api/studio/content?${q({ project: ctx.projectId })}`)
      .then((d) => setFiles(d.files))
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId, ctx.site.sha])

  const load = useCallback(
    (f: string) => {
      if (!f) return
      setLoading(true)
      setError(null)
      getJson<ContentData>(`./api/studio/content?${q({ project: ctx.projectId, file: f })}`)
        .then((d) => {
          setData(d)
          setDraft(d)
        })
        .catch((e) => {
          setData(null)
          setDraft(null)
          setError((e as Error).message)
        })
        .finally(() => setLoading(false))
    },
    [ctx.projectId],
  )
  useEffect(() => {
    if (files && file && files.some((f) => f.path === file)) load(file)
  }, [files, file, load])
  // after a save finishes, read the file again from disk
  const last = ctx.site.last
  useEffect(() => {
    if (last?.kind === 'content' && file) load(file)
  }, [last?.at, last?.kind, file, load])

  const choose = (f: string) => {
    if (dirty && !confirm('Leave this file without saving your changes?')) return
    setFile(f)
    setFilter('')
    try {
      localStorage.setItem(`ard.studio.content.${ctx.projectId}`, f)
    } catch {
      /* storage off */
    }
  }

  const dirty = !!data && !!draft && JSON.stringify(data) !== JSON.stringify(draft)
  const meta = files?.find((f) => f.path === file)
  const groups = useMemo(() => {
    const m = new Map<string, ContentFile[]>()
    for (const f of files ?? []) m.set(f.group, [...(m.get(f.group) ?? []), f])
    return [...m]
  }, [files])

  const save = async () => {
    if (!draft || !meta) return
    const update = draft.type === 'json' ? { data: draft.data } : draft.type === 'md' ? { front: draft.front, body: draft.body } : { text: draft.text }
    try {
      await post('./api/studio/content', { projectId: ctx.projectId, file, update, label: meta.label })
      ctx.refresh()
    } catch (e) {
      ctx.say((e as Error).message)
    }
  }

  if (!files) return error ? <p className="st-error st-pad">{error}</p> : <Spin>Finding the site’s content files…</Spin>
  if (!files.length)
    return (
      <div className="st-pad">
        <p className="st-muted">This site keeps its words in its pages rather than in data files, so edit them on the canvas.</p>
      </div>
    )

  return (
    <div className="st-pad st-content">
      <p className="st-tip">The site’s copy and data files, as forms. Saving rebuilds the site so you can check it on the canvas before pushing live.</p>
      <select value={file} onChange={(e) => choose(e.target.value)} aria-label="Content file">
        <option value="">Choose a file…</option>
        {groups.map(([g, list]) => (
          <optgroup key={g} label={g}>
            {list.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label} ({f.path.split('/').pop()})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {loading && <Spin>Reading it…</Spin>}
      {error && <p className="st-error">{error}</p>}
      {draft && meta && !loading && (
        <>
          <div className="st-row st-content-bar">
            <input className="st-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a field or words" aria-label="Find in this file" spellCheck={false} />
            <button className="st-pill" onClick={() => setDraft(data)} disabled={!dirty || ctx.working}>
              Undo
            </button>
            <button className="st-primary" onClick={save} disabled={!dirty || ctx.working}>
              Save
            </button>
          </div>
          {draft.type === 'json' && <JsonForm value={draft.data as Json} filter={filter} onChange={(v) => setDraft({ ...draft, data: v })} off={ctx.working} />}
          {draft.type === 'md' && <MdForm draft={draft} filter={filter} onChange={setDraft} off={ctx.working} />}
          {draft.type === 'yaml' && (
            <label className="st-cfield">
              <span>{meta.label}</span>
              <textarea className="st-code" value={draft.text ?? ''} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={18} spellCheck={false} disabled={ctx.working} />
            </label>
          )}
          {ctx.site.last?.kind === 'content' && <Result r={ctx.site.last} />}
        </>
      )}
    </div>
  )
}

function Leaf({ name, value, onChange, off }: { name: string; value: Json; onChange: (v: Json) => void; off: boolean }) {
  if (typeof value === 'boolean')
    return (
      <Toggle on={value} onChange={onChange} disabled={off}>
        {name}
      </Toggle>
    )
  if (typeof value === 'number')
    return (
      <label className="st-cfield">
        <span>{name}</span>
        <input type="number" value={value} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} disabled={off} />
      </label>
    )
  const s = value === null ? '' : String(value)
  const long = s.length > 70 || s.includes('\n')
  return (
    <label className="st-cfield">
      <span>{name}</span>
      {long ? <textarea value={s} onChange={(e) => onChange(e.target.value)} rows={Math.min(10, Math.max(2, Math.ceil(s.length / 42)))} disabled={off} spellCheck /> : <input value={s} onChange={(e) => onChange(e.target.value)} disabled={off} spellCheck={!/^(https?:|\/|#)/.test(s)} />}
    </label>
  )
}

function JsonForm({ value, filter, onChange, off }: { value: Json; filter: string; onChange: (v: Json) => void; off: boolean }) {
  const f = filter.trim().toLowerCase()
  if (f) {
    // a flat list of every field that matches, with where it is
    const out: { path: (string | number)[]; value: Json }[] = []
    const walk = (v: Json, path: (string | number)[]) => {
      if (out.length >= 80) return
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, [...path, Array.isArray(v) ? Number(k) : k])
        return
      }
      const key = String(path[path.length - 1] ?? '')
      if (key.toLowerCase().includes(f) || String(v ?? '').toLowerCase().includes(f)) out.push({ path, value: v })
    }
    walk(value, [])
    return (
      <div className="st-cform">
        {out.map((x) => (
          <Leaf key={x.path.join('.')} name={x.path.map((p) => (typeof p === 'number' ? `#${p + 1}` : nice(p))).join(' › ')} value={getIn(value, x.path)} onChange={(v) => onChange(setIn(value, x.path, v))} off={off} />
        ))}
        {!out.length && <p className="st-muted">Nothing matches.</p>}
        {out.length >= 80 && <p className="st-muted">Showing the first 80: type more to narrow it down.</p>}
      </div>
    )
  }
  return (
    <div className="st-cform">
      <Node value={value} path={[]} root={value} onChange={onChange} off={off} depth={0} />
    </div>
  )
}

function Node({ value, path, root, onChange, off, depth, name }: { value: Json; path: (string | number)[]; root: Json; onChange: (v: Json) => void; off: boolean; depth: number; name?: string }) {
  const set = (v: Json) => onChange(setIn(root, path, v))
  if (value === null || typeof value !== 'object') return <Leaf name={name ?? 'Value'} value={value} onChange={set} off={off} />
  const entries: [string | number, Json][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
  const body = (
    <>
      {entries.map(([k, v]) => {
        const p = [...path, k]
        const label = typeof k === 'number' ? `${name ? `${name.replace(/s$/, '')} ` : ''}${k + 1}` : nice(k)
        const child = <Node key={String(k)} value={v} path={p} root={root} onChange={onChange} off={off} depth={depth + 1} name={label} />
        if (!Array.isArray(value)) return child
        const i = k as number
        const move = (to: number) => {
          const copy = [...value]
          const [x] = copy.splice(i, 1)
          copy.splice(to, 0, x)
          set(copy)
        }
        return (
          <div key={String(k)} className="st-citem">
            {child}
            <div className="st-citem-tools">
              <button className="st-mini" onClick={() => move(i - 1)} disabled={off || i === 0} title="Move up">
                <Icon.arrowUp size={12} />
              </button>
              <button className="st-mini" onClick={() => move(i + 1)} disabled={off || i === value.length - 1} title="Move down">
                <Icon.arrowDown size={12} />
              </button>
              <button className="st-mini" onClick={() => set([...value.slice(0, i + 1), JSON.parse(JSON.stringify(v)) as Json, ...value.slice(i + 1)])} disabled={off} title="Duplicate">
                <Icon.copy size={12} />
              </button>
              <button
                className="st-mini"
                data-tone="bad"
                onClick={() => {
                  if (confirm(`Remove “${previewOf(v) || label}”?`)) set(value.filter((_, j) => j !== i))
                }}
                disabled={off}
                title="Remove"
              >
                <Icon.trash size={12} />
              </button>
            </div>
          </div>
        )
      })}
      {Array.isArray(value) && (
        <button className="st-pill" onClick={() => set([...value, value.length ? blank(value[value.length - 1]) : ''])} disabled={off}>
          <Icon.plus size={12} /> Add {name ? `to ${name.toLowerCase()}` : 'another'}
        </button>
      )}
    </>
  )
  if (depth === 0) return body
  return (
    <details className="st-cgroup" open={depth === 1 && entries.length <= 12}>
      <summary>
        <b title={name}>{name}</b> <small>{previewOf(value)}</small>
      </summary>
      <Lazy>{body}</Lazy>
    </details>
  )
}

/** render the inside of a <details> only once it's been opened (big files stay quick) */
function Lazy({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const d = ref.current?.parentElement as HTMLDetailsElement | null
    if (!d) return
    const on = () => d.open && setOpen(true)
    on()
    d.addEventListener('toggle', on)
    return () => d.removeEventListener('toggle', on)
  }, [])
  return (
    <div ref={ref} className="st-cgroup-body">
      {open ? children : null}
    </div>
  )
}

function MdForm({ draft, filter, onChange, off }: { draft: ContentData; filter: string; onChange: (d: ContentData) => void; off: boolean }) {
  const f = filter.trim().toLowerCase()
  const front = draft.front ?? {}
  const keys = Object.keys(front).filter((k) => !f || k.toLowerCase().includes(f) || String(front[k] ?? '').toLowerCase().includes(f))
  const setFront = (k: string, v: FrontValue) => onChange({ ...draft, front: { ...front, [k]: v } })
  return (
    <div className="st-cform">
      {keys.map((k) => {
        const v = front[k]
        if (Array.isArray(v))
          return (
            <label key={k} className="st-cfield">
              <span>{nice(k)} (one per line)</span>
              <textarea value={v.join('\n')} rows={Math.min(8, v.length + 1)} onChange={(e) => setFront(k, e.target.value.split('\n'))} onBlur={(e) => setFront(k, e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} disabled={off} />
            </label>
          )
        return <Leaf key={k} name={nice(k)} value={v} onChange={(x) => setFront(k, x as FrontValue)} off={off} />
      })}
      {Object.entries(draft.complex ?? {}).map(([k, v]) => (
        <div key={k} className="st-cfield">
          <span>
            {nice(k)} <small className="st-muted">(edit in the file or ask Claude)</small>
          </span>
          <pre className="st-code">{v}</pre>
        </div>
      ))}
      {!f && (
        <label className="st-cfield">
          <span>Words (Markdown)</span>
          <textarea className="st-code" value={draft.body ?? ''} onChange={(e) => onChange({ ...draft, body: e.target.value })} rows={14} disabled={off} spellCheck />
        </label>
      )}
    </div>
  )
}

// --- Photos ----------------------------------------------------------------------------------

function Photos({ ctx }: { ctx: StudioCtx }) {
  const [photos, setPhotos] = useState<LibraryPhoto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [show, setShow] = useState<'all' | 'unused'>('all')
  const [group, setGroup] = useState('')
  const [open, setOpen] = useState<LibraryPhoto | null>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sure, setSure] = useState(false)

  const load = useCallback(() => {
    getJson<{ photos: LibraryPhoto[] }>(`./api/studio/photos?${q({ project: ctx.projectId })}`)
      .then((d) => setPhotos(d.photos))
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId])
  useEffect(load, [load, ctx.site.sha])
  const last = ctx.site.last
  useEffect(() => {
    if (last?.kind === 'photos') {
      load()
      setPicked(new Set())
      setPicking(false)
    }
  }, [last?.at, last?.kind, load])

  const groups = useMemo(() => [...new Set((photos ?? []).map((p) => p.group))].sort(), [photos])
  const unused = useMemo(() => (photos ?? []).filter((p) => p.uses === 0), [photos])
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (photos ?? []).filter((p) => (show === 'all' || p.uses === 0) && (!group || p.group === group) && (!f || p.path.toLowerCase().includes(f)))
  }, [photos, filter, show, group])
  const wasted = unused.reduce((n, p) => n + p.bytes, 0)

  const remove = async () => {
    if (!sure) return setSure(true)
    setSure(false)
    try {
      await post('./api/studio/photos/delete', { projectId: ctx.projectId, paths: [...picked] })
      ctx.refresh()
    } catch (e) {
      ctx.say((e as Error).message)
    }
  }

  if (!photos) return error ? <p className="st-error st-pad">{error}</p> : <Spin>Looking through the site’s photos…</Spin>
  return (
    <div className="st-pad st-photos">
      <p className="st-tip">
        Every photo in the site’s files: {photos.length}, {bytes(photos.reduce((n, p) => n + p.bytes, 0))}. Reusing one adds nothing to the site’s size.
      </p>
      <div className="st-row">
        <Seg
          small
          value={show}
          label="Which photos"
          onChange={(v) => {
            setShow(v)
            setPicking(false)
            setPicked(new Set())
          }}
          options={[
            ['all', 'All'],
            ['unused', `Unused (${unused.length})`],
          ]}
        />
        {groups.length > 1 && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Folder" className="st-small-select">
            <option value="">Every folder</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
      </div>
      <input className="st-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find by name" aria-label="Find a photo by name" spellCheck={false} />
      {show === 'unused' && unused.length > 0 && (
        <div className="st-row st-unused-bar">
          <span className="st-muted">
            {unused.length} not used anywhere, {bytes(wasted)}
          </span>
          {picking ? (
            <>
              <button className="st-link" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.filter((p) => p.uses === 0).map((p) => p.path)))}>
                {picked.size === shown.length ? 'None' : 'All'}
              </button>
              <button className="st-pill" data-tone="bad" onClick={remove} disabled={!picked.size || ctx.working} onBlur={() => setSure(false)}>
                {sure ? `Click again to delete ${picked.size}` : `Delete ${picked.size || ''}`}
              </button>
              <button
                className="st-link"
                onClick={() => {
                  setPicking(false)
                  setPicked(new Set())
                  setSure(false)
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="st-pill" onClick={() => setPicking(true)} disabled={ctx.working}>
              Tidy up…
            </button>
          )}
        </div>
      )}
      {show === 'unused' && !unused.length && <p className="st-muted">Every photo is used somewhere. Nothing to tidy.</p>}
      {open && !picking && <PhotoDetail ctx={ctx} photo={open} onClose={() => setOpen(null)} />}
      <ul className="st-grid">
        {shown.slice(0, 400).map((p) => (
          <li key={p.path} data-unused={p.uses === 0 || undefined} data-open={open?.path === p.path || undefined}>
            <button
              onClick={() =>
                picking
                  ? p.uses === 0 &&
                    setPicked((s) => {
                      const n = new Set(s)
                      if (n.has(p.path)) n.delete(p.path)
                      else n.add(p.path)
                      return n
                    })
                  : setOpen(open?.path === p.path ? null : p)
              }
              title={`${p.path}\n${p.width ?? '?'} × ${p.height ?? '?'} · ${bytes(p.bytes)}${p.uses === 0 ? ' · not used' : p.uses < 0 ? ' · may be used by the site’s code' : ''}`}
              aria-pressed={picking ? picked.has(p.path) : undefined}
            >
              <img src={`${ctx.origin}${p.url}`} alt="" loading="lazy" />
              {picking && p.uses === 0 && <i className="st-tick">{picked.has(p.path) && <Icon.check size={12} />}</i>}
              {p.uses === 0 && !picking && <em>unused</em>}
            </button>
          </li>
        ))}
      </ul>
      {shown.length > 400 && <p className="st-muted">Showing 400 of {shown.length}: filter by name or folder to find the rest.</p>}
      {last?.kind === 'photos' && <Result r={last} />}
    </div>
  )
}

function PhotoDetail({ ctx, photo, onClose }: { ctx: StudioCtx; photo: LibraryPhoto; onClose: () => void }) {
  const [uses, setUses] = useState<string[] | null>(null)
  useEffect(() => {
    setUses(null)
    getJson<{ uses: string[] }>(`./api/studio/photos/uses?${q({ project: ctx.projectId, url: photo.url })}`)
      .then((d) => setUses(d.uses))
      .catch(() => setUses([]))
  }, [ctx.projectId, photo.url])
  const sel = ctx.selected
  const name = photo.path.split('/').pop() ?? photo.path
  const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  return (
    <div className="st-photo-detail">
      <header>
        <b title={photo.path}>{name}</b>
        <button className="st-btn" onClick={onClose} title="Close">
          <Icon.close size={14} />
        </button>
      </header>
      <img src={`${ctx.origin}${photo.url}`} alt="" />
      <p className="st-muted">
        {photo.width ?? '?'} × {photo.height ?? '?'} · {bytes(photo.bytes)} · {photo.path}
      </p>
      <div className="st-row">
        <button className="st-pill" disabled={!sel?.image || ctx.working || sel.image.svg} onClick={() => ctx.act('image', { src: photo.url, name, value: alt })} title={sel?.image ? 'Swap the photo you’ve selected for this one' : 'Select a photo on the page first'}>
          Use for the selected photo
        </button>
        <button className="st-pill" disabled={!sel || ctx.working} onClick={() => ctx.act('add-image', { src: photo.url, name, value: alt })} title={sel ? 'Add it straight after what’s selected' : 'Select something on the page first'}>
          Add after the selection
        </button>
      </div>
      <h5>{uses === null ? 'Finding where it’s used…' : uses.length ? `Used on ${uses.length}` : photo.uses < 0 ? 'Its name is built by the site’s code, so it may be used' : 'Not used anywhere'}</h5>
      {uses && uses.length > 0 && (
        <ul className="st-uses">
          {uses.slice(0, 30).map((u) => (
            <li key={u}>{u.startsWith('/') ? <button onClick={() => ctx.go(u)}>{u === '/' ? 'Home' : u}</button> : <code>{u}</code>}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- Find and replace --------------------------------------------------------------------------

function Find({ ctx }: { ctx: StudioCtx }) {
  const [text, setText] = useState('')
  const [rep, setRep] = useState('')
  const [scope, setScope] = useState<'page' | 'site'>('page')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [found, setFound] = useState<{ count: number; index: number } | null>(null)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const { tell, on } = ctx
  useEffect(() => input.current?.focus(), [])
  useEffect(() => on('found', (d) => setFound({ count: Number(d.count) || 0, index: Number(d.index) })), [on])

  // this page: highlight as you type (and again when the page or its edits change)
  const opCount = ctx.ops.length
  useEffect(() => {
    const t = setTimeout(() => tell({ type: 'find', q: text, matchCase, wholeWord, step: 0 }), 150)
    return () => clearTimeout(t)
  }, [text, matchCase, wholeWord, ctx.path, opCount, tell])
  // clear the highlights on leaving
  useEffect(() => () => tell({ type: 'find', q: '', step: 0 }), [tell])

  // every page: ask the server
  useEffect(() => {
    if (scope !== 'site' || text.trim().length < 2) return setHits(null)
    setSearching(true)
    const t = setTimeout(() => {
      getJson<{ hits: SearchHit[] }>(`./api/studio/search?${q({ project: ctx.projectId, q: text.trim(), case: matchCase ? 1 : null, word: wholeWord ? 1 : null })}`)
        .then((d) => setHits(d.hits))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 400)
    return () => clearTimeout(t)
  }, [scope, text, matchCase, wholeWord, ctx.projectId])

  const step = (n: number) => ctx.tell({ type: 'find', q: text, matchCase, wholeWord, step: n })
  const total = hits?.reduce((n, h) => n + h.count, 0) ?? 0
  const replace = (where: 'page' | 'site') => {
    if (!text.trim()) return
    ctx.addOp({ id: newId(), kind: 'replace', page: ctx.path, selector: 'body', label: 'Find and replace', text: '', find: text.trim(), replace: rep, matchCase, wholeWord, scope: where })
    ctx.say(where === 'site' ? `Replaced on every page (${total || 'all'} matches). Save to put it in the site.` : `Replaced on this page. Save to put it in the site.`)
    setTimeout(() => ctx.tell({ type: 'find', q: text, matchCase, wholeWord, step: 0 }), 100)
  }
  const pending = ctx.ops.filter((o): o is Extract<StudioOp, { kind: 'replace' }> => o.kind === 'replace')
  const mark = (s: string) => {
    const t = text.trim()
    if (!t) return s
    const i = (matchCase ? s : s.toLowerCase()).indexOf(matchCase ? t : t.toLowerCase())
    if (i < 0) return s
    return (
      <>
        {s.slice(0, i)}
        <mark>{s.slice(i, i + t.length)}</mark>
        {s.slice(i + t.length)}
      </>
    )
  }

  return (
    <div className="st-pad st-find">
      <Seg
        small
        value={scope}
        label="Where to look"
        onChange={setScope}
        options={[
          ['page', 'This page'],
          ['site', 'Every page'],
        ]}
      />
      <div className="st-find-box">
        <Icon.search size={14} />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
            if (e.key === 'Escape' && text) {
              e.stopPropagation()
              setText('')
            }
          }}
          placeholder="Find words"
          aria-label="Find"
          spellCheck={false}
        />
        {scope === 'page' && text && <small>{found ? (found.count ? `${found.index + 1} of ${found.count}` : 'none') : ''}</small>}
        {scope === 'page' && (
          <>
            <button className="st-mini" onClick={() => step(-1)} disabled={!found?.count} title="Previous (Shift Enter)">
              <Icon.arrowUp size={12} />
            </button>
            <button className="st-mini" onClick={() => step(1)} disabled={!found?.count} title="Next (Enter)">
              <Icon.arrowDown size={12} />
            </button>
          </>
        )}
      </div>
      <div className="st-row">
        <Toggle on={matchCase} onChange={setMatchCase} title="Off: capitals don’t matter when finding, and the new words follow each match’s capitals (small mid-sentence, a capital to start a sentence)">
          Match case
        </Toggle>
        <Toggle on={wholeWord} onChange={setWholeWord}>
          Whole words
        </Toggle>
      </div>
      <label className="st-cfield">
        <span>Replace with</span>
        <input value={rep} onChange={(e) => setRep(e.target.value)} placeholder="New words (leave it empty to take them out)" spellCheck />
      </label>
      <div className="st-row">
        <button className="st-pill" onClick={() => replace('page')} disabled={!text.trim() || ctx.working || (scope === 'page' && !found?.count)}>
          Replace on this page
        </button>
        <button className="st-pill" onClick={() => replace('site')} disabled={!text.trim() || ctx.working}>
          Replace on every page
        </button>
      </div>
      {pending.length > 0 && (
        <ul className="st-pending">
          {pending.map((o) => (
            <li key={o.id}>
              <span>
                “{o.find}” → “{o.replace}” <small>{o.scope === 'site' ? 'every page' : o.page === '/' ? 'home page' : o.page}</small>
              </span>
              <button className="st-btn" onClick={() => ctx.removeOp(o.id)} title="Take it back">
                <Icon.close size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {scope === 'site' && (
        <div className="st-hits">
          {searching && <Spin>Looking through every page…</Spin>}
          {!searching && hits && <h5>{hits.length ? `${total} on ${hits.length} page${hits.length === 1 ? '' : 's'}` : 'Not on any page'}</h5>}
          {hits?.map((h) => (
            <button key={h.path} className="st-hit" onClick={() => ctx.go(h.path)} data-here={h.path === ctx.path || undefined}>
              <b>
                {h.title || h.path} <small>{h.count}</small>
              </b>
              <small>{h.path}</small>
              {h.snippets.slice(0, 2).map((s, i) => (
                <span key={i}>{mark(s)}</span>
              ))}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
