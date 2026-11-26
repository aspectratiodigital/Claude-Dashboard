import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GoogleFont, StudioColour, StudioFont, StudioFontCategory, StudioFontFace, StudioFontSwap, StudioOp } from '../data/types'
import { Icon } from './icons'
import { Seg, Spin, getJson, post, q, type StudioCtx } from './StudioUi'

// The site's colours and fonts, for the whole site (Site → Theme).
//
// Colours: every colour written in the site's source, most used first. Untick
// one to take it out, and everything that used it takes the nearest colour
// you keep (or one you pick); click one to change it. It's one edit on the
// canvas, rewritten in place as you go, and saved into the source in the
// notation each colour was written in.
//
// Fonts: every font the site's CSS names. Swap one for another of the site's
// or any Google font: Studio measures both on the page and shows the new one
// at the size that looks the same (by the height of its small letters, or
// its capitals where the font is mostly set in capitals), held back if that
// would make lines longer, so text keeps fitting. Google fonts are
// self-hosted in the site when saved.

const newId = () => Math.random().toString(36).slice(2, 10)
type PaletteOp = Extract<StudioOp, { kind: 'palette' }>
type FontsOp = Extract<StudioOp, { kind: 'fonts' }>

/** the source changed (a save, a pull): read it again */
function useSourceKey(ctx: StudioCtx) {
  const last = ctx.site.last
  return `${ctx.site.sha}:${last && (last.kind === 'save' || last.kind === 'claude' || last.kind === 'discard' || last.kind === 'revert') ? last.at : ''}`
}

// --- Colour maths ----------------------------------------------------------------------------

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
/** a colour in OKLab, where distance is how different two colours look */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const labs = new Map<string, [number, number, number]>()
const labOf = (hex: string) => labs.get(hex) ?? (labs.set(hex, oklab(hex)), labs.get(hex)!)
const distance = (a: string, b: string) => {
  const x = labOf(a)
  const y = labOf(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}
const nearestOf = (hex: string, list: string[]) => list.reduce((best, c) => (distance(hex, c) < distance(hex, best) ? c : best), list[0])
/** greys by lightness, then colours by hue */
function hueKey(hex: string) {
  const [L, a, b] = labOf(hex)
  const chroma = Math.hypot(a, b)
  return chroma < 0.03 ? -1 + L : (Math.atan2(b, a) / Math.PI + 1) * 10 + L
}

/** every colour that changes: taken out ones to the nearest kept (or the one picked), changed ones to their new value */
function mapOf(all: string[], drop: Set<string>, over: Record<string, string>, set: Record<string, string>) {
  const kept = all.filter((c) => !drop.has(c))
  const map: Record<string, string> = {}
  const target: Record<string, string> = {}
  for (const d of drop) {
    if (!kept.length) break
    const t = over[d] && !drop.has(over[d]) && kept.includes(over[d]) ? over[d] : nearestOf(d, kept)
    target[d] = t
    map[d] = set[t] ?? t
  }
  for (const [h, v] of Object.entries(set)) if (!drop.has(h) && v !== h) map[h] = v
  return { map, target, kept }
}

// --- Colours ---------------------------------------------------------------------------------

export function Colours({ ctx }: { ctx: StudioCtx }) {
  const [list, setList] = useState<StudioColour[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<'used' | 'hue'>('used')
  const [open, setOpen] = useState<string | null>(null)
  const [shown, setShown] = useState<{ hex: string; count: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const key = useSourceKey(ctx)
  useEffect(() => {
    setError(null)
    getJson<{ colours: StudioColour[] }>(`./api/studio/palette?${q({ project: ctx.projectId })}`)
      .then((d) => setList(d.colours))
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId, key])

  const op = ctx.ops.find((o): o is PaletteOp => o.kind === 'palette')
  const drop = useMemo(() => new Set(op?.drop ?? []), [op])
  const over = op?.over ?? {}
  const set = op?.set ?? {}
  const styled = useMemo(() => (list ?? []).filter((c) => c.uses > 0), [list])
  const scriptOnly = useMemo(() => (list ?? []).filter((c) => c.uses === 0), [list])
  const all = useMemo(() => (list ?? []).map((c) => c.hex), [list])
  const { map, target, kept } = useMemo(() => mapOf(styled.map((c) => c.hex), drop, over, set), [styled, drop, over, set])

  /** the edit on the canvas, rewritten (or taken off when nothing's changed any more) */
  const write = useCallback(
    (next: { drop: Set<string>; over: Record<string, string>; set: Record<string, string> }) => {
      const { map: m } = mapOf(styled.map((c) => c.hex), next.drop, next.over, next.set)
      // a script-only colour can be changed too (it's not a choice to keep or take out)
      for (const [h, v] of Object.entries(next.set)) if (!m[h] && v !== h) m[h] = v
      const existing = ctx.ops.find((o) => o.kind === 'palette')
      if (!Object.keys(m).length) {
        if (existing) ctx.removeOp(existing.id)
        return
      }
      ctx.addOp({ id: existing?.id ?? newId(), kind: 'palette', page: ctx.path, selector: ':root', label: 'Colours', text: '', map: m, drop: [...next.drop], over: next.over, set: next.set }, existing?.id)
    },
    [ctx, styled],
  )

  const toggle = (hex: string) => {
    const d = new Set(drop)
    if (d.has(hex)) d.delete(hex)
    else {
      if (kept.length <= 1) return ctx.say('Keep at least one colour.')
      d.add(hex)
    }
    const o = { ...over }
    // colours that were standing in for this one look again
    for (const [k, v] of Object.entries(o)) if (v === hex && d.has(hex)) delete o[k]
    write({ drop: d, over: o, set })
  }
  const pickTarget = (hex: string, to: string) => write({ drop, over: { ...over, [hex]: to }, set })
  const timer = useRef<number | undefined>(undefined)
  const change = (hex: string, value: string) => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const s = { ...set }
      if (value.toLowerCase() === hex) delete s[hex]
      else s[hex] = value.toLowerCase()
      write({ drop, over, set: s })
    }, 250)
  }
  const tidy = () => {
    // a colour that looks almost the same as a more-used one goes to it
    const d = new Set(drop)
    let n = 0
    const byUse = [...styled].sort((a, b) => b.uses - a.uses)
    for (const c of byUse) {
      if (d.has(c.hex)) continue
      const twin = byUse.find((k) => k.uses > c.uses && !d.has(k.hex) && distance(k.hex, c.hex) < 0.025)
      if (twin) {
        d.add(c.hex)
        n++
      }
    }
    if (!n) return setNote('No near-duplicates: every colour looks clearly different from the others.')
    setNote(`Took out ${n} colour${n === 1 ? '' : 's'} that looked almost the same as a more-used one. Tick any you want back.`)
    write({ drop: d, over, set })
  }
  const show = (hex: string) => {
    if (shown?.hex === hex) {
      ctx.tell({ type: 'mark', what: null })
      return setShown(null)
    }
    const nonce = Math.random()
    const off = ctx.on('marked', (d) => {
      if (d.nonce !== nonce) return
      off()
      setShown({ hex, count: Number(d.count) || 0 })
    })
    ctx.tell({ type: 'mark', what: { colour: hex }, nonce })
  }
  // outlines go when you leave
  useEffect(() => () => ctx.tell({ type: 'mark', what: null }), [ctx.tell])

  const order = (l: StudioColour[]) => (sort === 'hue' ? [...l].sort((a, b) => hueKey(a.hex) - hueKey(b.hex)) : l)
  const changes = drop.size + Object.keys(set).filter((k) => !drop.has(k)).length

  if (error) return <p className="st-error st-pad">{error}</p>
  if (!list) return <Spin>Reading every colour in the site…</Spin>
  if (!list.length) return <p className="st-pad st-muted">No colours are written in this site’s styles.</p>
  const row = (c: StudioColour, choice: boolean) => {
    const out = drop.has(c.hex)
    const now = set[c.hex] ?? c.hex
    const to = target[c.hex]
    const isOpen = open === c.hex
    return (
      <li key={c.hex} data-out={out || undefined} data-changed={(!out && set[c.hex]) || undefined} data-open={isOpen || undefined}>
        <div className="st-pal-row">
          {choice ? <input type="checkbox" checked={!out} onChange={() => toggle(c.hex)} disabled={ctx.working} aria-label={`Keep ${c.hex}`} title={out ? 'Put it back' : 'Take it out: what uses it takes the nearest colour you keep'} /> : <i />}
          <button className="st-pal-main" onClick={() => setOpen(isOpen ? null : c.hex)} aria-expanded={isOpen} title={isOpen ? 'Close' : 'Change it, see where it’s used'}>
            <i className="st-pal-sw" style={{ background: now }} data-was={set[c.hex] && !out ? c.hex : undefined}>
              {set[c.hex] && !out && <i style={{ background: c.hex }} />}
            </i>
            <span>
              <b>{now}</b>
              {c.tokens.length > 0 && <small title={c.tokens.join(', ')}>{c.tokens.join(' ')}</small>}
            </span>
            <em title={`${c.uses} place${c.uses === 1 ? '' : 's'} in the site’s styles and markup${c.scripts ? `, ${c.scripts} in scripts and data` : ''}`}>{choice ? c.uses : c.scripts}</em>
          </button>
        </div>
        {out && to && (
          <label className="st-pal-to">
            <span>Becomes</span>
            <i className="st-pal-sw" style={{ background: map[c.hex] }} />
            <select value={to} onChange={(e) => pickTarget(c.hex, e.target.value)} disabled={ctx.working} aria-label={`What ${c.hex} becomes`}>
              {[...kept]
                .sort((a, b) => distance(c.hex, a) - distance(c.hex, b))
                .map((k, i) => {
                  const kc = styled.find((x) => x.hex === k)
                  return (
                    <option key={k} value={k}>
                      {set[k] ?? k}
                      {kc?.tokens[0] ? ` ${kc.tokens[0]}` : ''}
                      {i === 0 ? ' (nearest)' : ''}
                    </option>
                  )
                })}
            </select>
          </label>
        )}
        {isOpen && (
          <div className="st-pal-more">
            {!out && (
              <div className="st-row">
                <label className="st-sw st-sw-big" style={{ background: now }} title="Pick a new colour">
                  <input type="color" value={now} onChange={(e) => change(c.hex, e.target.value)} disabled={ctx.working} aria-label={`New value for ${c.hex}`} />
                </label>
                <HexBox value={now} onCommit={(v) => change(c.hex, v)} off={ctx.working} />
                {set[c.hex] && (
                  <button className="st-link" onClick={() => change(c.hex, c.hex)}>
                    Back to {c.hex}
                  </button>
                )}
              </div>
            )}
            <div className="st-row">
              <button className="st-pill" aria-pressed={shown?.hex === c.hex} onClick={() => show(c.hex)} title="Outline everything on this page that’s this colour">
                <Icon.eye size={13} /> Show on the page
              </button>
              {shown?.hex === c.hex && <span className="st-muted">{shown.count ? `${shown.count}${shown.count >= 400 ? '+' : ''} on this page` : 'None on this page'}</span>}
            </div>
            <p className="st-tip">
              {[c.seeThrough ? `${c.seeThrough} see-through (they stay see-through)` : '', c.scripts ? `${c.scripts} in scripts and data: these change when you save, and may only show then` : ''].filter(Boolean).join('. ')}
              {(c.seeThrough || c.scripts) > 0 && '. '}
              Written in {c.files.map((f) => `${f.file}${f.count > 1 ? ` (${f.count})` : ''}`).join(', ')}.
            </p>
          </div>
        )}
      </li>
    )
  }
  return (
    <div className="st-pad">
      <p className="st-tip">Every colour written in the site’s styles, on every page. Untick one to take it out: everything that used it takes the nearest colour you keep. Click a colour to change it.</p>
      <div className="st-row">
        <Seg
          small
          value={sort}
          onChange={setSort}
          label="Order"
          options={[
            ['used', 'Most used'],
            ['hue', 'By colour'],
          ]}
        />
        <span className="st-gap" />
        <button className="st-link" onClick={tidy} disabled={ctx.working} title="Take out colours that look almost the same as a more-used one">
          Tidy near-duplicates
        </button>
      </div>
      {note && <p className="st-tip">{note}</p>}
      {changes > 0 && (
        <p className="st-chip">
          {[drop.size ? `${drop.size} colour${drop.size === 1 ? '' : 's'} taken out` : '', changes - drop.size ? `${changes - drop.size} changed` : ''].filter(Boolean).join(', ')}, not saved yet.{' '}
          <button
            className="st-link"
            onClick={() => {
              setNote(null)
              write({ drop: new Set(), over: {}, set: {} })
            }}
          >
            Undo them
          </button>
        </p>
      )}
      <ul className="st-pal">{order(styled).map((c) => row(c, true))}</ul>
      {scriptOnly.length > 0 && (
        <details className="st-pal-extra">
          <summary>
            Only in scripts and data <small>{scriptOnly.length}</small>
          </summary>
          <p className="st-tip">Colours set by the site’s scripts (3D scenes, charts, placeholders). They aren’t taken out with the others; change one and it changes when you save.</p>
          <ul className="st-pal">{order(scriptOnly).map((c) => row(c, false))}</ul>
        </details>
      )}
      <p className="st-tip">Photos, logos and SVG files keep their own colours.</p>
      {all.length >= 400 && <p className="st-tip">Showing the 400 most used.</p>}
    </div>
  )
}

function HexBox({ value, onCommit, off }: { value: string; onCommit: (v: string) => void; off: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const ok = (x: string) => /^#[0-9a-f]{6}$/i.test(x.trim())
  return (
    <input
      className="st-hex"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && ok(v)) onCommit(v.trim())
        if (e.key === 'Escape') setV(value)
      }}
      onBlur={() => (ok(v) && v.trim().toLowerCase() !== value ? onCommit(v.trim()) : setV(value))}
      disabled={off}
      aria-label="Colour as hex"
      spellCheck={false}
      data-bad={!ok(v) || undefined}
    />
  )
}

// --- Fonts -----------------------------------------------------------------------------------

interface Metrics {
  x: number
  cap: number
  w: number
  caps: number
  missing: boolean
}
interface Usage {
  elements: number
  letters: number
  upper: number
  roles: Record<string, number>
  weights: Record<string, number>
  italic: number
}

const CATEGORY_NAME: Record<StudioFontCategory, string> = { serif: 'Serif', 'sans-serif': 'Sans serif', display: 'Display', handwriting: 'Handwriting', monospace: 'Monospace' }
const ROLE_NAME: Record<string, string> = { headings: 'headings', buttons: 'buttons', menu: 'the menu', forms: 'forms', footer: 'the footer', text: 'body text' }

/** load a font into Studio's own page, to draw a name in it */
const loaded = new Map<string, string>()
function useFace(key: string, src: () => { url: string; weight?: string; style?: string }[] | null) {
  const [ready, setReady] = useState(loaded.has(key))
  useEffect(() => {
    if (loaded.has(key)) return setReady(true)
    const list = src()
    if (!list?.length) return
    const name = `st-face-${loaded.size}`
    const faces = list.map((f) => new FontFace(name, `url("${f.url}")`, { weight: f.weight ?? '400', style: f.style ?? 'normal' }))
    let live = true
    faces.forEach((f) => document.fonts.add(f))
    Promise.any(faces.map((f) => f.load()))
      .then(() => {
        loaded.set(key, name)
        if (live) setReady(true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return ready ? loaded.get(key)! : null
}

function SiteFontName({ font, project, children }: { font: StudioFont; project: string; children?: React.ReactNode }) {
  // (through Studio's server: the site's own dev server may not share its fonts with Studio's page)
  const family = useFace(`site:${project}:${font.family}:${font.faces.map((f) => f.url).join()}`, () =>
    font.faces.length ? font.faces.map((f) => ({ ...f, url: `./api/studio/site-font?${q({ project, url: f.url })}` })) : font.source === 'google' ? [{ url: `./api/studio/google-font-preview?${q({ family: font.family })}` }] : null,
  )
  return <span style={{ fontFamily: family ? `"${family}", system-ui` : font.source === 'system' ? `"${font.family}", system-ui` : undefined }}>{children ?? font.family}</span>
}

function GoogleName({ family }: { family: string }) {
  const face = useFace(`google:${family}`, () => [{ url: `./api/studio/google-font-preview?${q({ family })}` }])
  return <span style={{ fontFamily: face ? `"${face}", system-ui` : undefined, opacity: face ? 1 : 0.55 }}>{family}</span>
}

/** how much bigger or smaller the new font is shown, so it looks the size the old one did and lines don't get longer */
function matchSize(from: Metrics, to: Metrics, capitals: boolean) {
  const basis = capitals ? 'cap' : 'x'
  let scale = to[basis] > 0 ? from[basis] / to[basis] : 1
  const oldWidth = capitals ? from.caps : from.w
  const newWidth = capitals ? to.caps : to.w
  let held = false
  if (newWidth * scale > oldWidth * 1.04) {
    scale = (oldWidth * 1.04) / newWidth
    held = true
  }
  scale = Math.round(Math.max(0.6, Math.min(1.6, scale)) * 100) / 100
  return { scale, basis: basis as 'cap' | 'x', held }
}

interface Match {
  basis: 'cap' | 'x'
  held: boolean
}

export function Fonts({ ctx }: { ctx: StudioCtx }) {
  const [fonts, setFonts] = useState<StudioFont[] | null>(null)
  const [googleOk, setGoogleOk] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<Record<string, Usage> | null>(null)
  const [metrics, setMetrics] = useState<Record<string, Metrics | null>>({})
  const [picking, setPicking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [why, setWhy] = useState<Record<string, Match>>({})
  const [shown, setShown] = useState<{ family: string; count: number } | null>(null)
  const key = useSourceKey(ctx)
  useEffect(() => {
    setError(null)
    getJson<{ fonts: StudioFont[]; google: boolean }>(`./api/studio/fonts?${q({ project: ctx.projectId })}`)
      .then((d) => {
        setFonts(d.fonts)
        setGoogleOk(d.google)
      })
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId, key])

  /** ask the page to measure fonts (and say what each is used for) */
  const measure = useCallback(
    (list: { key: string; family?: string; faces?: StudioFontFace[]; weight?: number; style?: string }[], withUsage = false) =>
      new Promise<{ metrics: Record<string, Metrics | null>; usage?: Record<string, Usage> }>((resolve) => {
        const nonce = Math.random()
        const done = setTimeout(() => {
          off()
          resolve({ metrics: {} })
        }, 15000)
        const off = ctx.on('fonts-measured', (d) => {
          if (d.nonce !== nonce) return
          off()
          clearTimeout(done)
          resolve(d as unknown as { metrics: Record<string, Metrics | null>; usage?: Record<string, Usage> })
        })
        ctx.tell({ type: 'fonts-measure', fonts: list, usage: withUsage, nonce })
      }),
    [ctx.on, ctx.tell],
  )

  // what each font is used for on this page, and how big it looks (again whenever the page loads)
  const [loads, setLoads] = useState(0)
  useEffect(() => ctx.on('ready', () => setLoads((n) => n + 1)), [ctx.on])
  useEffect(() => {
    if (!fonts?.length || ctx.site.status !== 'ready') return
    let live = true
    void measure(
      fonts.map((f) => ({ key: f.family, family: f.family })),
      true,
    ).then((d) => {
      if (!live) return
      setMetrics((m) => ({ ...m, ...d.metrics }))
      if (d.usage) setUsage(d.usage)
    })
    return () => {
      live = false
    }
  }, [fonts, ctx.path, measure, ctx.site.status, loads])

  const op = ctx.ops.find((o): o is FontsOp => o.kind === 'fonts')
  const swaps = useMemo(() => op?.swaps ?? [], [op])
  const swapOf = (family: string) => swaps.find((s) => s.from.toLowerCase() === family.toLowerCase())

  const write = useCallback(
    (next: StudioFontSwap[]) => {
      const existing = ctx.ops.find((o) => o.kind === 'fonts')
      if (!next.length) {
        if (existing) ctx.removeOp(existing.id)
        return
      }
      ctx.addOp({ id: existing?.id ?? newId(), kind: 'fonts', page: ctx.path, selector: ':root', label: 'Fonts', text: '', swaps: next }, existing?.id)
    },
    [ctx],
  )

  const usageOf = (f: StudioFont) => usage?.[f.family.toLowerCase()] ?? null
  /** the weight it's mostly used at on this page, for measuring */
  const mainWeight = (f: StudioFont) => {
    const u = usageOf(f)
    const top = u ? Object.entries(u.weights).sort((a, b) => b[1] - a[1])[0]?.[0] : null
    return f.pinned ?? (top ? Number(top) : 400)
  }
  const capitals = (f: StudioFont) => {
    const u = usageOf(f)
    return !!u && u.letters > 0 && u.upper / u.letters > 0.6
  }

  /** swap `from` for a site font or a Google font, sized to match */
  const choose = async (from: StudioFont, to: { family: string; google: boolean; category: StudioFontCategory; g?: GoogleFont }) => {
    setPicking(null)
    if (to.family.toLowerCase() === from.family.toLowerCase()) return write(swaps.filter((s) => s.from !== from.family))
    setBusy(from.family)
    try {
      const u = usageOf(from)
      const weights = [...new Set([...(u ? Object.keys(u.weights).map(Number) : []), ...from.weights.flatMap((w) => w.split(' ').map(Number)).filter((w) => w % 100 === 0 && w >= 100)])]
      let faces: StudioFontFace[] | undefined
      if (to.google) {
        const pin = from.pinned ? { weight: from.pinned, declare: from.weights[0] ?? '100 900' } : null
        faces = (await post<{ faces: StudioFontFace[] }>('./api/studio/google-font', { family: to.family, weights: weights.length ? weights : [400, 700], italic: from.italic || (u?.italic ?? 0) > 0, pin })).faces
      }
      const weight = mainWeight(from)
      const caps = capitals(from)
      const m = await measure([
        { key: 'from', family: from.family, weight },
        to.google ? { key: 'to', faces, weight } : { key: 'to', family: to.family, weight },
      ])
      const a = m.metrics.from ?? metrics[from.family]
      const b = m.metrics.to
      const fit = a && b && !a.missing && !b.missing ? matchSize(a, b, caps) : null
      setWhy((w) => {
        const n: Record<string, Match> = { ...w, [from.family]: fit ? { basis: fit.basis, held: fit.held } : { basis: 'x', held: false } }
        // fonts that follow this one to the new font were matched another way
        for (const s of swaps) if (s.to.toLowerCase() === from.family.toLowerCase()) delete n[s.from]
        return n
      })
      const swap: StudioFontSwap = { from: from.family, to: to.family, google: to.google, scale: fit?.scale ?? 1, auto: !!fit, category: to.category, ...(faces ? { faces } : {}) }
      // anything that stood in for this font follows it to the new one
      // (at its size times this one's: it looked the size of this font, which now looks the size of the old one)
      const next = swaps
        .filter((s) => s.from !== from.family)
        .map((s) => (s.to.toLowerCase() === from.family.toLowerCase() ? { ...s, to: to.family, google: to.google, category: to.category, faces, scale: Math.round(Math.max(0.6, Math.min(1.6, s.scale * swap.scale)) * 100) / 100, auto: s.auto && swap.auto } : s))
      write([...next, swap])
      if (!fit) ctx.say('Couldn’t measure the fonts on this page, so the new one is shown at the same size. Adjust it if it looks off.')
    } catch (e) {
      ctx.say((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const setScale = (from: string, scale: number) => write(swaps.map((s) => (s.from === from ? { ...s, scale: Math.round(Math.max(0.6, Math.min(1.6, scale)) * 100) / 100, auto: false } : s)))
  const reMatch = (f: StudioFont) => {
    const s = swapOf(f.family)
    if (s) void choose(f, { family: s.to, google: s.google, category: s.category })
  }
  const show = (family: string) => {
    if (shown?.family === family) {
      ctx.tell({ type: 'mark', what: null })
      return setShown(null)
    }
    const nonce = Math.random()
    const off = ctx.on('marked', (d) => {
      if (d.nonce !== nonce) return
      off()
      setShown({ family, count: Number(d.count) || 0 })
    })
    ctx.tell({ type: 'mark', what: { font: family }, nonce })
  }
  useEffect(() => () => ctx.tell({ type: 'mark', what: null }), [ctx.tell])

  if (error) return <p className="st-error st-pad">{error}</p>
  if (!fonts) return <Spin>Reading the site’s fonts…</Spin>
  if (!fonts.length) return <p className="st-pad st-muted">This site doesn’t name any fonts of its own: it uses each visitor’s system font.</p>
  const leaving = new Set(swaps.map((s) => s.from.toLowerCase()))
  return (
    <div className="st-pad">
      <p className="st-tip">The fonts the site uses, on every page. Swap one for another of the site’s or any Google font: Studio shows it at the size that looks the same, so text keeps fitting.</p>
      {swaps.length > 0 && (
        <p className="st-chip">
          {swaps.length} font{swaps.length === 1 ? '' : 's'} swapped, not saved yet.{' '}
          <button className="st-link" onClick={() => write([])}>
            Undo them
          </button>
        </p>
      )}
      <ul className="st-fonts">
        {fonts.map((f) => {
          const s = swapOf(f.family)
          const u = usageOf(f)
          const roles = u
            ? Object.entries(u.roles)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([r]) => ROLE_NAME[r] ?? r)
            : []
          const m = why[f.family]
          return (
            <li key={f.family} data-changed={!!s || undefined}>
              <div className="st-font-head">
                <div>
                  <b className="st-font-name" style={s ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}>
                    <SiteFontName font={f} project={ctx.projectId} />
                  </b>
                  <small>
                    {[f.actual, CATEGORY_NAME[f.category], f.source === 'google' ? 'from Google Fonts' : f.source === 'system' ? 'on visitors’ computers' : '', roles.length ? roles.join(' and ') : u === null && usage ? 'not on this page' : '', `${f.uses} place${f.uses === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                  </small>
                </div>
                <button className="st-btn" onClick={() => show(f.family)} aria-pressed={shown?.family === f.family} title="Outline the text on this page in this font">
                  <Icon.eye size={14} />
                </button>
                <button className="st-pill" onClick={() => setPicking(picking === f.family ? null : f.family)} aria-expanded={picking === f.family} disabled={ctx.working || !!busy}>
                  {busy === f.family ? 'Matching…' : s ? 'Change' : 'Swap'}
                </button>
              </div>
              {shown?.family === f.family && <p className="st-tip">{shown.count ? `${shown.count}${shown.count >= 400 ? '+' : ''} bits of text on this page.` : 'Not used on this page.'}</p>}
              {s && (
                <div className="st-font-swap">
                  <div className="st-row">
                    <span className="st-muted">Now</span>
                    <b className="st-font-name">{s.google ? <GoogleName family={s.to} /> : fonts.find((x) => x.family === s.to) ? <SiteFontName font={fonts.find((x) => x.family === s.to)!} project={ctx.projectId} /> : s.to}</b>
                    <span className="st-gap" />
                    <button className="st-btn" onClick={() => write(swaps.filter((x) => x !== s))} title={`Back to ${f.family}`}>
                      <Icon.undo size={13} />
                    </button>
                  </div>
                  <div className="st-row st-font-size">
                    <span>Size</span>
                    <button className="st-btn" onClick={() => setScale(f.family, s.scale - 0.01)} disabled={s.scale <= 0.6} aria-label="Smaller">
                      <Icon.minus size={12} />
                    </button>
                    <input type="range" min={60} max={160} value={Math.round(s.scale * 100)} onChange={(e) => setScale(f.family, Number(e.target.value) / 100)} aria-label="Size of the new font" />
                    <button className="st-btn" onClick={() => setScale(f.family, s.scale + 0.01)} disabled={s.scale >= 1.6} aria-label="Bigger">
                      <Icon.plus size={12} />
                    </button>
                    <b>{Math.round(s.scale * 100)}%</b>
                  </div>
                  <p className="st-tip">
                    {s.auto && m
                      ? `Matched to look the same size: the height of its ${m.basis === 'cap' ? 'capitals (it’s mostly set in capitals here)' : 'small letters'}${m.held ? ', then held back so lines don’t get longer' : ''}.`
                      : s.auto
                        ? 'Matched to look the same size.'
                        : 'Set by hand.'}{' '}
                    {!s.auto && (
                      <button className="st-link" onClick={() => reMatch(f)}>
                        Match it again
                      </button>
                    )}
                  </p>
                </div>
              )}
              {picking === f.family && <FontPicker font={f} fonts={fonts.filter((x) => x.family !== f.family && !leaving.has(x.family.toLowerCase()))} project={ctx.projectId} google={googleOk} current={s?.to ?? null} onPick={(to) => void choose(f, to)} onClose={() => setPicking(null)} />}
            </li>
          )
        })}
      </ul>
      <p className="st-tip">Google fonts are copied into the site when you save, so it doesn’t load anything from Google.</p>
    </div>
  )
}

type Cat = StudioFontCategory | 'all'
const CATS: readonly (readonly [Cat, string])[] = [
  ['all', 'All'],
  ['serif', 'Serif'],
  ['sans-serif', 'Sans'],
  ['display', 'Display'],
  ['handwriting', 'Hand'],
  ['monospace', 'Mono'],
]

function FontPicker({ font, fonts, project, google, current, onPick, onClose }: { font: StudioFont; fonts: StudioFont[]; project: string; google: boolean; current: string | null; onPick: (to: { family: string; google: boolean; category: StudioFontCategory; g?: GoogleFont }) => void; onClose: () => void }) {
  const [words, setWords] = useState('')
  const [cat, setCat] = useState<Cat>(font.category)
  const [list, setList] = useState<GoogleFont[] | null>(null)
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(40)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!google) return
    const t = setTimeout(() => {
      getJson<{ fonts: GoogleFont[]; total: number }>(`./api/studio/google-fonts?${q({ q: words.trim(), category: words.trim() ? 'all' : cat, limit })}`)
        .then((d) => {
          setList(d.fonts)
          setTotal(d.total)
          setError(null)
        })
        .catch((e) => setError((e as Error).message))
    }, 200)
    return () => clearTimeout(t)
  }, [words, cat, limit, google])
  const mine = fonts.filter((f) => (!words.trim() || f.family.toLowerCase().includes(words.trim().toLowerCase())) && f.source !== 'system')
  const weightsOf = (g: GoogleFont) => (g.variable ? `${g.variable.min}–${g.variable.max}` : g.weights.length === 1 ? `${g.weights[0]} only` : `${g.weights.length} weights`)
  return (
    <div className="st-font-pick" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <input className="st-search" value={words} onChange={(e) => setWords(e.target.value)} placeholder={google ? 'Search Google Fonts' : 'Search'} aria-label="Search fonts" autoFocus spellCheck={false} />
      {!words.trim() && google && <Seg small value={cat} onChange={setCat} label="Kind of font" options={CATS} />}
      {mine.length > 0 && (
        <>
          <h5>On this site</h5>
          <ul>
            {mine.map((f) => (
              <li key={f.family}>
                <button onClick={() => onPick({ family: f.family, google: false, category: f.category })} aria-pressed={current === f.family}>
                  <SiteFontName font={f} project={project} />
                  <small>{CATEGORY_NAME[f.category]}</small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {google ? (
        <>
          <h5>Google Fonts {total > 0 && <small>{total}</small>}</h5>
          {error && <p className="st-error">{error}</p>}
          {!list && !error && <Spin>Loading Google Fonts…</Spin>}
          {list && !list.length && <p className="st-muted">No Google font by that name.</p>}
          <ul>
            {list?.map((g) => (
              <li key={g.family}>
                <button onClick={() => onPick({ family: g.family, google: true, category: g.category, g })} aria-pressed={current === g.family} title={`${g.family}: ${CATEGORY_NAME[g.category]}, ${g.variable ? `weights ${weightsOf(g)}` : weightsOf(g)}${g.italics.length ? ', with italics' : ''}`}>
                  <GoogleName family={g.family} />
                  <small>
                    {CATEGORY_NAME[g.category]} · {weightsOf(g)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {list && total > list.length && (
            <button className="st-link" onClick={() => setLimit((n) => n + 40)}>
              Show more
            </button>
          )}
        </>
      ) : (
        <p className="st-tip">Google Fonts can’t be reached right now, so only the site’s own fonts can be picked.</p>
      )}
    </div>
  )
}
