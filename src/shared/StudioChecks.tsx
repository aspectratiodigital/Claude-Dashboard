import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SeoReport, StudioMetaField } from '../data/types'
import type { A11yIssue, NapReport, SearchReport, SpeedReport, VisitorReport, WeeklyReport } from '../data/studio-api'
import type { SeoLevel } from '../data/seo'
import { relTime } from '../data/derive'
import { Icon } from './icons'
import { LevelIcon, SeoPanel, type Crawl } from './StudioSeo'
import { GoogleConnect, SiteGoogleIds, useConnections } from './StudioConnect'
import { Modal, Seg, Spin, download, getJson, hexOf, post, q, uploadFile, type StudioCtx, type Uploaded } from './StudioUi'

// The Checks tab: how the page does with Google and with people. SEO (the
// page's search and share details, a target phrase, a share image maker and
// the weekly health check), Access (axe-core's accessibility check of the
// page as it is on the canvas), Speed (Google PageSpeed on the live page),
// Local (the business's name, address and phone the same everywhere) and
// Traffic (Search Console and Google Analytics).

type Sub = 'seo' | 'access' | 'speed' | 'local' | 'traffic'
const SUBS: readonly (readonly [Sub, string])[] = [
  ['seo', 'SEO'],
  ['access', 'Access'],
  ['speed', 'Speed'],
  ['local', 'Local'],
  ['traffic', 'Traffic'],
]

export function ChecksTab({
  ctx,
  sub,
  crawl,
  onMeta,
  onShareImage,
  onAlt,
  onCrawl,
  onStopCrawl,
  onRefresh,
}: {
  ctx: StudioCtx
  sub?: string
  crawl: Crawl | null
  onMeta: (field: StudioMetaField, value: string, photo?: Uploaded) => void
  onShareImage: () => void
  onAlt: (selector: string, src: string, value: string) => void
  onCrawl: () => void
  onStopCrawl: () => void
  onRefresh: () => void
}) {
  const [tab, setTab] = useState<Sub>(() => (SUBS.some(([k]) => k === sub) ? (sub as Sub) : ((localStorage.getItem('ard.studio.checks-sub') as Sub | null) ?? 'seo')))
  useEffect(() => {
    if (sub && SUBS.some(([k]) => k === sub)) setTab(sub as Sub)
  }, [sub])
  const pick = (s: Sub) => {
    setTab(s)
    try {
      localStorage.setItem('ard.studio.checks-sub', s)
    } catch {
      /* storage off */
    }
  }
  const [maker, setMaker] = useState(false)
  return (
    <div className="st-panel">
      <div className="st-subtabs">
        <Seg value={tab} options={SUBS} onChange={pick} label="Checks" small />
      </div>
      {tab === 'seo' && (
        <SeoPanel
          report={ctx.seo}
          site={ctx.site}
          project={ctx.project}
          origin={ctx.origin}
          ops={ctx.ops}
          crawl={crawl}
          working={ctx.working}
          onMeta={(f, v) => onMeta(f, v)}
          onShareImage={onShareImage}
          onAlt={onAlt}
          onClaude={ctx.claude}
          onReveal={(selector) => ctx.tell({ type: 'reveal', selector, keepTab: true })}
          onCrawl={onCrawl}
          onStopCrawl={onStopCrawl}
          onGo={ctx.go}
          onRefresh={onRefresh}
        >
          {ctx.seo && (
            <>
              <section>
                <h4>Make a share image</h4>
                <p className="st-muted">A 1200 × 630 picture for links shared on social media and in messages, in the site’s own fonts and colours.</p>
                <button className="st-pill" onClick={() => setMaker(true)} disabled={ctx.working}>
                  <Icon.wand size={13} /> Make one for this page
                </button>
              </section>
              <TargetPhrase ctx={ctx} report={ctx.seo} />
            </>
          )}
          <Weekly ctx={ctx} />
        </SeoPanel>
      )}
      {tab === 'access' && <Access ctx={ctx} />}
      {tab === 'speed' && <Speed ctx={ctx} />}
      {tab === 'local' && <Local ctx={ctx} />}
      {tab === 'traffic' && <Traffic ctx={ctx} />}
      {maker && ctx.seo && <ShareMaker ctx={ctx} report={ctx.seo} onUse={(up) => onMeta('og:image', up.name, up)} onClose={() => setMaker(false)} />}
    </div>
  )
}

// --- Target phrase ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
const countIn = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

function TargetPhrase({ ctx, report }: { ctx: StudioCtx; report: SeoReport }) {
  const key = `ard.studio.phrase.${ctx.projectId}`
  const [all, setAll] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}')
    } catch {
      return {}
    }
  })
  const phrase = all[report.path] ?? ''
  const [typed, setTyped] = useState(phrase)
  useEffect(() => setTyped(phrase), [phrase, report.path])
  const save = (v: string) => {
    const next = { ...all, [report.path]: v.trim() }
    if (!v.trim()) delete next[report.path]
    setAll(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* storage off */
    }
  }
  const checks = useMemo(() => {
    const p = norm(phrase)
    if (!p) return []
    const words = p.split(' ')
    const has = (s: string | null | undefined) => {
      const n = norm(s ?? '')
      return n.includes(p) ? 'good' : words.every((w) => n.includes(w)) ? 'improve' : 'fix'
    }
    const h1 = report.headings.find((h) => h.level === 1)?.text ?? ''
    const slug = norm(decodeURIComponent(report.path).replace(/[-_/]+/g, ' '))
    const body = norm(report.text)
    const times = countIn(body, p)
    const per = report.words ? (times / report.words) * 1000 : 0
    const elsewhere = Object.entries(all).filter(([path, ph]) => path !== report.path && norm(ph) === p).map(([path]) => path)
    const out: { level: SeoLevel; label: string; detail: string }[] = [
      { level: has(report.title) as SeoLevel, label: 'In the Google title', detail: 'The title is the strongest signal of what the page is about. Put the phrase near the start.' },
      { level: has(report.description) as SeoLevel, label: 'In the Google description', detail: 'Google shows the matching words in bold, which draws the eye.' },
      { level: (h1 ? has(h1) : 'fix') as SeoLevel, label: 'In the main heading', detail: h1 ? `“${h1.slice(0, 70)}”` : 'The page has no main heading (H1).' },
      { level: has(report.lead) as SeoLevel, label: 'In the first paragraph', detail: 'Saying it early tells people (and Google) they’re in the right place.' },
      { level: slug.includes(p) ? 'good' : words.some((w) => w.length > 3 && slug.includes(w)) ? 'improve' : 'improve', label: 'In the page address', detail: report.path === '/' ? 'The home page’s address is the site itself, which is fine.' : `${report.path}: changing an address needs a redirect from the old one, so only do it on a new page.` },
      {
        level: times === 0 ? 'fix' : per > 30 ? 'improve' : 'good',
        label: times === 0 ? 'Not in the page’s words' : `${times} time${times === 1 ? '' : 's'} in ${report.words} words`,
        detail: per > 30 ? 'That’s a lot: it can read as stuffed. Use natural variations too.' : times === 0 ? 'Use it in the copy where it reads naturally.' : 'A natural amount.',
      },
    ]
    if (report.path === '/' && out[4]) out[4].level = 'good'
    if (elsewhere.length) out.push({ level: 'improve', label: 'Also the target of another page', detail: `${elsewhere.join(', ')} aims for the same phrase, so the two pages compete in Google. Give each page its own.` })
    return out
  }, [phrase, report, all])
  const misses = checks.filter((c) => c.level !== 'good')
  return (
    <section>
      <h4>Target phrase</h4>
      <p className="st-muted">What would someone type into Google to find this page? Studio checks the page uses it where it counts.</p>
      <form
        className="st-field"
        onSubmit={(e) => {
          e.preventDefault()
          save(typed)
        }}
      >
        <div>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. dentist in Kings Hill" aria-label="Target phrase" spellCheck />
          <button className="st-pill" disabled={typed.trim() === phrase}>
            Check
          </button>
        </div>
      </form>
      {checks.length > 0 && (
        <ul className="st-checks">
          {checks.map((c) => (
            <li key={c.label} data-level={c.level}>
              <LevelIcon level={c.level} />
              <div>
                <b>{c.label}</b>
                <p>{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {misses.length > 0 && (
        <button
          className="st-pill"
          disabled={ctx.working}
          onClick={() =>
            ctx.claude(
              `Help this page rank for “${phrase}”. It's missing from: ${misses.map((m) => m.label.toLowerCase()).join('; ')}. Work the phrase (or a natural variation) into the title, description, main heading and first paragraph where it reads naturally, in UK English and the site's existing tone. Don't stuff it in, don't change the page address, and keep every heading short.`,
            )
          }
        >
          <Icon.claude size={12} /> Ask Claude to work it in
        </button>
      )}
    </section>
  )
}

// --- Share image maker -----------------------------------------------------------------------

function ShareMaker({ ctx, report, onUse, onClose }: { ctx: StudioCtx; report: SeoReport; onUse: (u: Uploaded) => void; onClose: () => void }) {
  const tokens = useMemo(() => (ctx.design?.tokens ?? []).filter((t) => t.kind === 'colour' && hexOf(t.value)), [ctx.design])
  const fonts = useMemo(() => (ctx.design?.fonts ?? []).map((f) => f.family).filter((f, i, a) => a.indexOf(f) === i), [ctx.design])
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  }
  const dark = useMemo(() => [...tokens].sort((a, b) => lum(hexOf(a.value)!) - lum(hexOf(b.value)!))[0]?.value ?? '#1b1511', [tokens])
  const light = useMemo(() => [...tokens].sort((a, b) => lum(hexOf(b.value)!) - lum(hexOf(a.value)!))[0]?.value ?? '#ffffff', [tokens])
  const domain = (() => {
    try {
      return new URL(ctx.project?.url ?? ctx.project?.previewUrl ?? '').host.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()
  // the page's own words for the headline: not the site's name, which goes in the small line above
  const name = ctx.project?.name ?? ''
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const parts = (report.og.title || report.title || '').split(/\s[|–—-]\s/).map((t) => t.trim()).filter(Boolean)
  const h1 = report.headings.find((x) => x.level === 1)?.text ?? ''
  const headline = parts.find((t) => !same(t, name)) ?? (h1 && !same(h1, name) ? h1 : parts[0] ?? '')
  const [spec, setSpec] = useState({
    title: headline,
    kicker: same(headline, name) ? '' : name,
    photo: null as string | null,
    background: dark,
    color: light,
    accent: tokens[2]?.value ?? '#e0a192',
    font: fonts[0] ?? 'system-ui',
    layout: 'split' as 'split' | 'full' | 'plain',
    domain,
  })
  const [images, setImages] = useState<string[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nonce = useRef(0)
  const waiting = useRef(new Map<number, (out: unknown) => void>())
  const { tell, on } = ctx

  useEffect(() => on('images', (d) => setImages((d.images as string[]) ?? [])), [on])
  useEffect(
    () =>
      on('share-image', (d) => {
        const done = waiting.current.get(Number(d.nonce))
        if (done) {
          waiting.current.delete(Number(d.nonce))
          done(d.out)
        }
      }),
    [on],
  )
  useEffect(() => tell({ type: 'images' }), [tell])
  useEffect(() => {
    if (images.length && spec.photo === null) setSpec((s) => ({ ...s, photo: images[0] }))
  }, [images, spec.photo])

  const draw = useCallback(
    (full: boolean) =>
      new Promise<unknown>((resolve) => {
        const n = ++nonce.current
        waiting.current.set(n, resolve)
        tell({ type: 'share-image', spec, full, nonce: n })
        setTimeout(() => {
          if (waiting.current.delete(n)) resolve(null)
        }, 15_000)
      }),
    [spec, tell],
  )
  useEffect(() => {
    const t = setTimeout(() => void draw(false).then((out) => typeof out === 'string' && setPreview(out)), 200)
    return () => clearTimeout(t)
  }, [draw])

  const finish = async (use: boolean) => {
    setBusy(true)
    try {
      const out = await draw(true)
      if (!(out instanceof Blob)) throw new Error('The image couldn’t be made. A photo from another website can’t be used: pick one from this site.')
      const slug = report.path === '/' ? 'home' : report.path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      if (!use) return download(out, `share-${slug}.png`)
      const up = await uploadFile(out, { name: `share-${slug}.png` })
      onUse(up)
      ctx.say('Share image set. Save to put it in the site.')
      onClose()
    } catch (e) {
      ctx.say((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = (patch: Partial<typeof spec>) => setSpec((s) => ({ ...s, ...patch }))
  // a plain function, not a component, so the colour input isn't swapped out while it's open
  const colourPick = (label: string, value: string, onPick: (v: string) => void) => (
    <div className="st-prop st-prop-top" key={label}>
      <span>{label}</span>
      <div className="st-swatches">
        {tokens.slice(0, 14).map((t) => (
          <button key={t.name} className="st-sw" style={{ background: t.value }} aria-pressed={hexOf(t.value) === hexOf(value)} title={t.name.replace(/^--/, '')} onClick={() => onPick(t.value)} />
        ))}
        <label className="st-sw st-sw-any" title="Any colour">
          <input type="color" value={hexOf(value) ?? '#000000'} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  )

  return (
    <Modal
      title="Make a share image"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="st-muted">1200 × 630 PNG</span>
          <span className="st-gap" />
          <button className="st-pill" onClick={() => finish(false)} disabled={busy}>
            <Icon.download size={13} /> Download
          </button>
          <button className="st-primary" onClick={() => finish(true)} disabled={busy || ctx.working}>
            {busy ? 'Making it…' : 'Use for this page'}
          </button>
        </>
      }
    >
      <div className="st-maker">
        <div className="st-maker-preview">{preview ? <img src={preview} alt="Preview of the share image" /> : <Spin>Drawing it…</Spin>}</div>
        <div className="st-maker-form">
          <label className="st-cfield">
            <span>Headline</span>
            <input value={spec.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} spellCheck />
          </label>
          <label className="st-cfield">
            <span>Small line above</span>
            <input value={spec.kicker} onChange={(e) => set({ kicker: e.target.value })} maxLength={60} spellCheck />
          </label>
          <div className="st-prop">
            <span>Layout</span>
            <Seg
              small
              label="Layout"
              value={spec.layout}
              onChange={(layout) => set({ layout })}
              options={[
                ['split', 'Photo beside'],
                ['full', 'Photo behind'],
                ['plain', 'No photo'],
              ]}
            />
          </div>
          {spec.layout !== 'plain' && (
            <div className="st-cfield">
              <span>Photo from this page</span>
              {images.length ? (
                <div className="st-maker-photos">
                  {images.map((src) => (
                    <button key={src} aria-pressed={spec.photo === src} onClick={() => set({ photo: src })}>
                      <img src={src} alt="" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="st-muted">No large photos on this page: try “No photo”.</p>
              )}
            </div>
          )}
          {colourPick('Background', spec.background, (background) => set({ background }))}
          {colourPick('Words', spec.color, (color) => set({ color }))}
          {colourPick('Accent line', spec.accent, (accent) => set({ accent }))}
          {fonts.length > 1 && (
            <label className="st-prop">
              <span>Font</span>
              <select value={spec.font} onChange={(e) => set({ font: e.target.value })}>
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    </Modal>
  )
}

// --- Weekly health check ---------------------------------------------------------------------

function Weekly({ ctx }: { ctx: StudioCtx }) {
  const [rep, setRep] = useState<WeeklyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      getJson<WeeklyReport>(`./api/studio/weekly?${q({ project: ctx.projectId })}`)
        .then(setRep)
        .catch((e) => setError((e as Error).message)),
    [ctx.projectId],
  )
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (!rep?.running) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [rep?.running, load])
  const run = async () => {
    try {
      setRep(await post<WeeklyReport>('./api/studio/weekly', { projectId: ctx.projectId }))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const last = rep?.runs[0]
  return (
    <section>
      <h4>Weekly health check</h4>
      {!rep && !error && <Spin />}
      {error && <p className="st-error">{error}</p>}
      {rep && !rep.url && <p className="st-muted">This site has no live address set, so there’s nothing to check.</p>}
      {rep?.url && (
        <>
          <p className="st-muted">
            Once a week Studio visits every page of the live site: pages that don’t load, broken links, slow pages, and missing titles or descriptions. You get a note if something new goes wrong.
          </p>
          {last ? (
            <div className="st-weekly">
              <p>
                <b>{last.problems.length ? `${last.problems.length} problem${last.problems.length === 1 ? '' : 's'}` : 'All good'}</b> <span className="st-muted">· {last.pages.length} pages checked {relTime(last.at)}</span>
              </p>
              {rep.slipped.length > 0 && (
                <div className="st-weekly-list" data-tone="bad">
                  <h5>New since the week before</h5>
                  <ul>
                    {rep.slipped.slice(0, 8).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {rep.fixed.length > 0 && (
                <div className="st-weekly-list" data-tone="good">
                  <h5>Fixed since the week before</h5>
                  <ul>
                    {rep.fixed.slice(0, 8).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {last.problems.length > 0 && (
                <details>
                  <summary>Every problem</summary>
                  <ul className="st-plain-list">
                    {last.problems.slice(0, 60).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : (
            !rep.running && <p className="st-muted">Not run yet. The first one runs by itself within the hour, or now:</p>
          )}
          <div className="st-row">
            <button className="st-pill" onClick={run} disabled={rep.running}>
              {rep.running ? (
                <>
                  <i className="st-spin" /> Checking the live site…
                </>
              ) : (
                'Check now'
              )}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

// --- Accessibility ---------------------------------------------------------------------------

const IMPACT_LEVEL: Record<A11yIssue['impact'], SeoLevel> = { critical: 'fix', serious: 'fix', moderate: 'improve', minor: 'improve' }
const IMPACT_WORD: Record<A11yIssue['impact'], string> = { critical: 'Blocks some people', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' }

function Access({ ctx }: { ctx: StudioCtx }) {
  const [issues, setIssues] = useState<A11yIssue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const { tell, on } = ctx
  useEffect(
    () =>
      on('a11y', (d) => {
        setRunning(false)
        if (d.error) setError(String(d.error))
        else setIssues((d.issues as A11yIssue[]) ?? [])
      }),
    [on],
  )
  const check = useCallback(() => {
    setRunning(true)
    setError(null)
    tell({ type: 'a11y' })
  }, [tell])
  // the page on the canvas, as it is with your edits: again when either changes
  const opCount = ctx.ops.length
  useEffect(() => {
    setIssues(null)
    const t = setTimeout(check, 600)
    return () => clearTimeout(t)
  }, [ctx.path, opCount, check])
  const sorted = useMemo(() => [...(issues ?? [])].sort((a, b) => ['critical', 'serious', 'moderate', 'minor'].indexOf(a.impact) - ['critical', 'serious', 'moderate', 'minor'].indexOf(b.impact)), [issues])
  const fix = sorted.filter((i) => IMPACT_LEVEL[i.impact] === 'fix').length
  return (
    <div className="st-pad st-checks-pane">
      <header className="st-seo-head">
        <p className="st-muted">The page on the canvas, with your edits, checked against WCAG 2.2 AA by axe.</p>
        <button className="st-btn" onClick={check} disabled={running} title="Check again">
          <Icon.refresh size={15} />
        </button>
      </header>
      {running && <Spin>Checking this page…</Spin>}
      {error && <p className="st-error">{error}</p>}
      {issues && !running && (
        <p className={issues.length ? 'st-chip' : 'st-ok'}>
          {issues.length ? `${fix} to fix, ${issues.length - fix} to improve.` : 'No problems found.'} Automatic checks catch around a third of problems: also try the page with only a keyboard.
        </p>
      )}
      <ul className="st-checks">
        {sorted.map((i) => (
          <li key={i.id} data-level={IMPACT_LEVEL[i.impact]}>
            <LevelIcon level={IMPACT_LEVEL[i.impact]} />
            <div>
              <b>
                {i.help} <small className="st-muted">{i.count > 1 ? `${i.count} places` : '1 place'}</small>
              </b>
              <p>
                {IMPACT_WORD[i.impact]}. {i.description}
              </p>
              <div className="st-row">
                <button className="st-pill" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
                  {open === i.id ? 'Hide where' : 'Show where'}
                </button>
                <button
                  className="st-pill"
                  disabled={ctx.working}
                  onClick={() =>
                    ctx.claude(
                      `Fix this accessibility problem on this page (axe rule ${i.id}: ${i.help}). ${i.description} Where it happens:\n${i.nodes
                        .slice(0, 10)
                        .map((n) => `- ${n.label || n.selector}: ${n.summary} (${n.html.slice(0, 140)})`)
                        .join('\n')}\nFix it in the site's source so it's fixed everywhere the same markup is used, without changing how it looks.`,
                    )
                  }
                >
                  <Icon.claude size={12} /> Ask Claude to fix
                </button>
                <a className="st-link" href={i.helpUrl} target="_blank" rel="noreferrer">
                  Why it matters
                </a>
              </div>
              {open === i.id && (
                <ul className="st-where">
                  {i.nodes.map((n, k) => (
                    <li key={k}>
                      <button onClick={() => n.selector && tell({ type: 'reveal', selector: n.selector, keepTab: true })} onMouseEnter={() => n.selector && tell({ type: 'hover', selector: n.selector })} onMouseLeave={() => tell({ type: 'hover', selector: null })} disabled={!n.selector}>
                        <b>{n.label || 'Element'}</b> {n.text && <small>“{n.text.slice(0, 50)}”</small>}
                      </button>
                      <span>{n.summary}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Speed -----------------------------------------------------------------------------------

const speedCache = new Map<string, SpeedReport>()
const scoreLevel = (n: number): SeoLevel => (n >= 90 ? 'good' : n >= 50 ? 'improve' : 'fix')

function Speed({ ctx }: { ctx: StudioCtx }) {
  const [strategy, setStrategy] = useState<'mobile' | 'desktop'>('mobile')
  const key = `${ctx.projectId}|${ctx.path}|${strategy}`
  const [rep, setRep] = useState<SpeedReport | null>(speedCache.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    setRep(speedCache.get(key) ?? null)
    setError(null)
  }, [key])
  const live = ctx.project?.url ?? ctx.project?.previewUrl
  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await getJson<SpeedReport>(`./api/studio/psi?${q({ project: ctx.projectId, page: ctx.path, strategy })}`)
      speedCache.set(key, r)
      setRep(r)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const scores = rep ? ([['Performance', rep.scores.performance], ['Accessibility', rep.scores.accessibility], ['Best practices', rep.scores.bestPractices], ['SEO', rep.scores.seo]] as const) : []
  return (
    <div className="st-pad st-checks-pane">
      <div className="st-row">
        <Seg
          small
          value={strategy}
          label="Device"
          onChange={setStrategy}
          options={[
            ['mobile', <>
              <Icon.mobile size={13} /> Phone
            </>],
            ['desktop', <>
              <Icon.desktop size={13} /> Laptop
            </>],
          ]}
        />
        <button className="st-primary" onClick={run} disabled={running || !live}>
          {running ? 'Testing…' : rep ? 'Test again' : 'Test this page'}
        </button>
      </div>
      <p className="st-muted">{live ? `Google PageSpeed tests the live page, ${new URL(ctx.path, live).href.replace(/^https?:\/\//, '')}, so saved edits show here once they’re live. It takes about half a minute.` : 'This site has no live address set, so Google can’t test it.'}</p>
      {running && <Spin>Google is loading the page on a {strategy === 'mobile' ? 'mid-range phone on a 4G connection' : 'laptop'}…</Spin>}
      {error && <p className="st-error">{error}</p>}
      {rep && (
        <>
          <div className="st-scores">
            {scores.map(([label, n]) => (
              <div key={label} data-level={scoreLevel(n)}>
                <svg viewBox="0 0 36 36" aria-hidden>
                  <circle cx="18" cy="18" r="15.5" />
                  <circle cx="18" cy="18" r="15.5" strokeDasharray={`${(n / 100) * 97.4} 97.4`} />
                </svg>
                <b>{n}</b>
                <small>{label}</small>
              </div>
            ))}
          </div>
          <ul className="st-metrics">
            {rep.metrics.map((m) => (
              <li key={m.id} data-level={scoreLevel(m.score)}>
                <LevelIcon level={scoreLevel(m.score)} size={12} />
                <span>{m.label}</span>
                <b>{m.value}</b>
              </li>
            ))}
          </ul>
          {rep.fixes.length > 0 && (
            <>
              <h5>What would make it faster</h5>
              <ul className="st-checks">
                {rep.fixes.map((f) => (
                  <li key={f.title} data-level="improve">
                    <LevelIcon level="improve" />
                    <div>
                      <b>
                        {f.title} {f.saving && <small className="st-muted">· {f.saving}</small>}
                      </b>
                      <p>{f.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                className="st-pill"
                disabled={ctx.working}
                onClick={() => ctx.claude(`Google PageSpeed (${strategy}) scores this page ${rep.scores.performance} for performance. It suggests: ${rep.fixes.map((f) => `${f.title}${f.saving ? ` (${f.saving})` : ''}`).join('; ')}. Make the changes that are safe to make in this site's source without changing how it looks.`)}
              >
                <Icon.claude size={12} /> Ask Claude to speed it up
              </button>
            </>
          )}
          {rep.shot && <img className="st-psi-shot" src={rep.shot} alt="The page as Google loaded it" />}
          <p className="st-muted">Tested {relTime(rep.at)}.</p>
        </>
      )}
    </div>
  )
}

// --- Local: name, address and phone --------------------------------------------------------------

function Local({ ctx }: { ctx: StudioCtx }) {
  const [rep, setRep] = useState<NapReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nap = ctx.seo?.nap
  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setRep(await getJson<NapReport>(`./api/studio/nap?${q({ project: ctx.projectId })}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const Pages = ({ pages }: { pages: string[] }) => (
    <small className="st-muted">
      {pages.length === rep?.pages ? 'every page' : `${pages.length} page${pages.length === 1 ? '' : 's'}`}
      {pages.length < 4 ? `: ${pages.map((p) => (p === '/' ? 'home' : p)).join(', ')}` : ''}
    </small>
  )
  return (
    <div className="st-pad st-checks-pane">
      <p className="st-muted">For local search, the business’s name, address and phone number (NAP) should be written the same way on every page, in the page’s structured data, and on its Google Business Profile.</p>
      <section className="st-card">
        <h5>This page says</h5>
        {!nap ? (
          <Spin />
        ) : (
          <dl className="st-dl">
            <dt>Name</dt>
            <dd>{nap.name ?? <em>not in its structured data</em>}</dd>
            <dt>Phone</dt>
            <dd>{nap.phones.length ? nap.phones.join(', ') : <em>no tap-to-call number</em>}</dd>
            <dt>Email</dt>
            <dd>{nap.emails.length ? nap.emails.join(', ') : <em>none</em>}</dd>
            <dt>Address</dt>
            <dd>{nap.address ?? <em>not in its structured data</em>}</dd>
            {nap.hours.length > 0 && (
              <>
                <dt>Hours</dt>
                <dd>{nap.hours.slice(0, 4).join(' · ')}</dd>
              </>
            )}
          </dl>
        )}
      </section>
      <button className="st-primary" onClick={run} disabled={running}>
        {running ? 'Reading every page…' : rep ? 'Check every page again' : 'Check every page'}
      </button>
      {error && <p className="st-error">{error}</p>}
      {rep && (
        <>
          <p className={rep.problems.length ? 'st-chip' : 'st-ok'}>{rep.problems.length ? `${rep.problems.length} thing${rep.problems.length === 1 ? '' : 's'} to look at across ${rep.pages} pages.` : `Consistent across all ${rep.pages} pages.`}</p>
          {rep.problems.length > 0 && (
            <ul className="st-checks">
              {rep.problems.map((p) => (
                <li key={p} data-level="improve">
                  <LevelIcon level="improve" />
                  <div>
                    <p>{p}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <section className="st-card">
            <h5>Phone numbers</h5>
            <ul className="st-plain-list">
              {rep.phones.map((p) => (
                <li key={p.value}>
                  <b>{p.value}</b> <Pages pages={p.pages} />
                </li>
              ))}
              {!rep.phones.length && <li className="st-muted">None found</li>}
            </ul>
            {rep.emails.length > 0 && (
              <>
                <h5>Emails</h5>
                <ul className="st-plain-list">
                  {rep.emails.map((p) => (
                    <li key={p.value}>
                      <b>{p.value}</b> <Pages pages={p.pages} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h5>Structured data</h5>
            <p className="st-muted">{rep.schema.pages.length ? `On ${rep.schema.pages.length} of ${rep.pages} pages${rep.schema.phone ? `, phone ${rep.schema.phone}` : ''}${rep.schema.address ? `, ${rep.schema.address}` : ''}.` : 'No page describes the business in structured data (LocalBusiness), which helps Google show it in local results.'}</p>
          </section>
          {(rep.problems.length > 0 || !rep.schema.pages.length) && (
            <button
              className="st-pill"
              disabled={ctx.working}
              onClick={() =>
                ctx.claude(
                  `Make the business's name, address and phone number consistent across the site. ${rep.problems.join(' ')} ${!rep.schema.pages.length ? 'Also add LocalBusiness structured data (JSON-LD) to the home page with the name, address, phone and opening hours as the site shows them.' : ''} Don't invent details the site doesn't already give.`,
                )
              }
            >
              <Icon.claude size={12} /> Ask Claude to sort it
            </button>
          )}
        </>
      )}
    </div>
  )
}

// --- Traffic: Search Console and Analytics -------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`
const num = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

function Change({ now, before, lower }: { now: number; before: number; lower?: boolean }) {
  if (!before) return null
  const d = (now - before) / before
  if (Math.abs(d) < 0.02) return <small className="st-delta">same</small>
  const good = lower ? d < 0 : d > 0
  return (
    <small className="st-delta" data-good={good}>
      {d > 0 ? '▲' : '▼'} {Math.abs(Math.round(d * 100))}%
    </small>
  )
}

function Traffic({ ctx }: { ctx: StudioCtx }) {
  const { conn, error, save } = useConnections(ctx.projectId)
  const [days, setDays] = useState<'7' | '28' | '90'>('28')
  const [scope, setScope] = useState<'page' | 'site'>('page')
  const [search, setSearch] = useState<SearchReport | { error: string } | null>(null)
  const [visits, setVisits] = useState<VisitorReport | { error: string } | null>(null)
  const [settings, setSettings] = useState(false)
  const page = scope === 'page' ? ctx.path : null
  useEffect(() => {
    if (!conn?.google) return
    setSearch(null)
    setVisits(null)
    const qs = q({ project: ctx.projectId, page, days })
    getJson<SearchReport>(`./api/studio/search-console?${qs}`)
      .then(setSearch)
      .catch((e) => setSearch({ error: (e as Error).message }))
    getJson<VisitorReport>(`./api/studio/analytics?${qs}`)
      .then(setVisits)
      .catch((e) => setVisits({ error: (e as Error).message }))
  }, [conn?.google, ctx.projectId, page, days, conn?.site?.searchConsole, conn?.site?.ga4])

  if (error) return <p className="st-error st-pad">{error}</p>
  if (!conn) return <Spin />
  if (!conn.google)
    return (
      <div className="st-pad st-checks-pane">
        <p>See what people search for to find this site, and how many visit each page, from Google Search Console and Google Analytics.</p>
        <GoogleConnect conn={conn} save={save} />
      </div>
    )
  return (
    <div className="st-pad st-checks-pane">
      <div className="st-row">
        <Seg
          small
          value={scope}
          label="Which pages"
          onChange={setScope}
          options={[
            ['page', 'This page'],
            ['site', 'Whole site'],
          ]}
        />
        <select className="st-small-select" value={days} onChange={(e) => setDays(e.target.value as '7' | '28' | '90')} aria-label="Period">
          <option value="7">Last 7 days</option>
          <option value="28">Last 28 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <button className="st-btn" aria-pressed={settings} onClick={() => setSettings(!settings)} title="Google settings for this site">
          <Icon.gear size={15} />
        </button>
      </div>
      {settings && (
        <section className="st-card">
          <h5>Google for this site</h5>
          <SiteGoogleIds conn={conn} save={save} projectId={ctx.projectId} />
          <GoogleConnect conn={conn} save={save} />
        </section>
      )}
      <section className="st-card">
        <h5>
          <Icon.search size={13} /> Google Search {search && !('error' in search) && <small className="st-muted">{search.property}</small>}
        </h5>
        {!search && <Spin />}
        {search && 'error' in search && <p className="st-error">{search.error}</p>}
        {search && !('error' in search) && (
          <>
            <div className="st-stats">
              <div>
                <b>{num(search.now.clicks)}</b>
                <small>clicks</small>
                <Change now={search.now.clicks} before={search.before.clicks} />
              </div>
              <div>
                <b>{num(search.now.impressions)}</b>
                <small>times shown</small>
                <Change now={search.now.impressions} before={search.before.impressions} />
              </div>
              <div>
                <b>{pct(search.now.ctr)}</b>
                <small>clicked</small>
                <Change now={search.now.ctr} before={search.before.ctr} />
              </div>
              <div>
                <b>{search.now.position ? search.now.position.toFixed(1) : '–'}</b>
                <small>avg. position</small>
                <Change now={search.now.position} before={search.before.position} lower />
              </div>
            </div>
            <p className="st-muted">
              {search.from} to {search.to}, compared with the {days} days before. Google’s figures are about three days behind.
            </p>
            {search.queries.length > 0 ? (
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Searched for</th>
                    <th>Clicks</th>
                    <th>Shown</th>
                    <th>Pos.</th>
                  </tr>
                </thead>
                <tbody>
                  {search.queries.slice(0, 15).map((r) => (
                    <tr key={r.query}>
                      <td>{r.query}</td>
                      <td>{num(r.clicks)}</td>
                      <td>{num(r.impressions)}</td>
                      <td>{r.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="st-muted">No searches showed {scope === 'page' ? 'this page' : 'the site'} in this period.</p>
            )}
            {scope === 'site' && search.pages.length > 0 && (
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Clicks</th>
                    <th>Shown</th>
                  </tr>
                </thead>
                <tbody>
                  {search.pages.slice(0, 10).map((r) => (
                    <tr key={r.page}>
                      <td>
                        <button className="st-link" onClick={() => ctx.go(r.page)}>
                          {r.page === '/' ? 'Home' : r.page}
                        </button>
                      </td>
                      <td>{num(r.clicks)}</td>
                      <td>{num(r.impressions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
      <section className="st-card">
        <h5>
          <Icon.pulse size={13} /> Visitors {visits && !('error' in visits) && <small className="st-muted">GA4 {visits.property}</small>}
        </h5>
        {!visits && <Spin />}
        {visits && 'error' in visits && <p className="st-error">{visits.error}</p>}
        {visits && !('error' in visits) && (
          <>
            <div className="st-stats">
              <div>
                <b>{num(visits.now.visitors)}</b>
                <small>people</small>
                <Change now={visits.now.visitors} before={visits.before.visitors} />
              </div>
              <div>
                <b>{num(visits.now.views)}</b>
                <small>page views</small>
                <Change now={visits.now.views} before={visits.before.views} />
              </div>
              <div>
                <b>{pct(visits.now.engagement)}</b>
                <small>engaged</small>
                <Change now={visits.now.engagement} before={visits.before.engagement} />
              </div>
            </div>
            {visits.sources.length > 0 && (
              <ul className="st-bars">
                {visits.sources.slice(0, 6).map((s) => {
                  const max = visits.sources[0].sessions || 1
                  return (
                    <li key={s.name}>
                      <span>{s.name}</span>
                      <i style={{ width: `${(s.sessions / max) * 100}%` }} />
                      <b>{num(s.sessions)}</b>
                    </li>
                  )
                })}
              </ul>
            )}
            {scope === 'site' && visits.pages.length > 0 && (
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Views</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.pages.slice(0, 10).map((r) => (
                    <tr key={r.page}>
                      <td>
                        <button className="st-link" onClick={() => ctx.go(r.page)}>
                          {r.page === '/' ? 'Home' : r.page}
                        </button>
                      </td>
                      <td>{num(r.views)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  )
}
