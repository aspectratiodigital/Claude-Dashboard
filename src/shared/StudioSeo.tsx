import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, SeoReport, StudioMetaField, StudioOp, StudioSite } from '../data/types'
import { displayUrl, seoChecks, seoScore, type SeoCheck, type SeoLevel } from '../data/seo'
import { Icon } from './icons'

// Studio's SEO tab: what Google and the social networks see for the page on the
// canvas, each detail marked with a green tick (sorted), an orange line (could
// be better) or a red cross (needs sorting). The title, description and share
// picture are edited right here, as edits on the canvas like any other; the
// rest have a one-click fix (the alt-text list, or a ready-made ask for Claude).
// "Check every page" loads each page in a hidden frame for a whole-site view.

const LEVEL_WORD: Record<SeoLevel, string> = { good: 'Sorted', improve: 'Could improve', fix: 'Needs sorting' }

export function LevelIcon({ level, size = 16 }: { level: SeoLevel; size?: number }) {
  return (
    <svg className="st-lv" data-level={level} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={LEVEL_WORD[level]}>
      <circle cx="8" cy="8" r="8" />
      {level === 'good' && <path d="M4.6 8.4l2.2 2.2 4.6-5" />}
      {level === 'improve' && <path d="M4.6 8h6.8" />}
      {level === 'fix' && <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" />}
    </svg>
  )
}

const lengthLevel = (n: number, min: number, max: number): SeoLevel => (n === 0 ? 'fix' : n < min || n > max ? 'improve' : 'good')
const cutAt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')} …` : s)

/** the share picture's address, from the canvas when the page gives a relative one */
const absolute = (src: string | null, origin: string, path: string) => {
  if (!src) return null
  try {
    return new URL(src, `${origin}${path}`).href
  } catch {
    return null
  }
}

export interface Crawl {
  /** pages still to check, the first one loading now */
  queue: string[]
  total: number
  /** each page's details, or null when it didn't answer in time */
  reports: Record<string, SeoReport | null>
}

export function SeoPanel({
  report,
  site,
  project,
  origin,
  ops,
  crawl,
  working,
  onMeta,
  onShareImage,
  onAlt,
  onClaude,
  onReveal,
  onCrawl,
  onStopCrawl,
  onGo,
  onRefresh,
}: {
  report: SeoReport | null
  site: StudioSite
  project: Project | null
  origin: string
  ops: StudioOp[]
  crawl: Crawl | null
  working: boolean
  onMeta: (field: StudioMetaField, value: string) => void
  onShareImage: () => void
  onAlt: (selector: string, src: string, value: string) => void
  onClaude: (prompt: string) => void
  onReveal: (selector: string) => void
  onCrawl: () => void
  onStopCrawl: () => void
  onGo: (path: string) => void
  onRefresh: () => void
}) {
  const others = useMemo(() => (crawl ? (Object.values(crawl.reports).filter(Boolean) as SeoReport[]) : []), [crawl])
  const page = useMemo(() => (report ? { ...report, site: site.seo ?? report.site } : null), [report, site.seo])
  const checks = useMemo(() => (page ? seoChecks(page, others) : []), [page, others])
  const [title, setTitle] = useState(report?.title ?? '')
  const [desc, setDesc] = useState(report?.description ?? '')
  const [shareTitle, setShareTitle] = useState(report?.og.title ?? '')
  const [shareDesc, setShareDesc] = useState(report?.og.description ?? '')
  const [altOpen, setAltOpen] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setTitle(report?.title ?? ''), [report?.path, report?.title])
  useEffect(() => setDesc(report?.description ?? ''), [report?.path, report?.description])
  useEffect(() => setShareTitle(report?.og.title ?? ''), [report?.path, report?.og.title])
  useEffect(() => setShareDesc(report?.og.description ?? ''), [report?.path, report?.og.description])

  if (!page) {
    return (
      <div className="st-seo">
        <p className="st-working">
          <i className="st-spin" /> Reading this page’s search details…
        </p>
      </div>
    )
  }

  const checking = !page.links.checked
  const shown = checking ? checks.filter((c) => c.id !== 'links') : checks
  const score = seoScore(shown)
  const pending = ops.filter((o) => o.kind === 'meta' && o.page === page.path).length
  const share = absolute(page.og.image, origin, page.path)
  const commit = (field: StudioMetaField, value: string, was: string | null) => {
    if (value.replace(/\s+/g, ' ').trim() !== (was ?? '').trim()) onMeta(field, value)
  }

  const focus = (el: HTMLElement | null) => {
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.focus()
  }
  const action = (c: SeoCheck) => {
    if (c.fix === 'title') return <button className="st-pill" onClick={() => focus(titleRef.current)}>Edit the title</button>
    if (c.fix === 'description') return <button className="st-pill" onClick={() => focus(descRef.current)}>Edit the description</button>
    if (c.fix === 'share') return <button className="st-pill" onClick={onShareImage} disabled={working}>Choose a share image</button>
    if (c.fix === 'alt') return <button className="st-pill" aria-expanded={altOpen} onClick={() => setAltOpen(!altOpen)}>{altOpen ? 'Hide the list' : 'Add alt text'}</button>
    if (c.fix === 'claude' && c.ask) return <button className="st-pill" onClick={() => onClaude(c.ask!)} disabled={working}><Icon.claude size={12} /> Ask Claude</button>
    return null
  }

  return (
    <div className="st-seo">
      <header className="st-seo-head">
        <div className="st-score" aria-label="This page’s SEO">
          <span data-level="good" title={`${score.good} sorted`}><LevelIcon level="good" /> {score.good}</span>
          <span data-level="improve" title={`${score.improve} could improve`}><LevelIcon level="improve" /> {score.improve}</span>
          <span data-level="fix" title={`${score.fix} need sorting`}><LevelIcon level="fix" /> {score.fix}</span>
        </div>
        <button className="st-btn" onClick={onRefresh} title="Check this page again">
          <Icon.refresh size={15} />
        </button>
      </header>
      {pending > 0 && <p className="st-chip">{pending} SEO edit{pending === 1 ? '' : 's'} on this page, not saved yet. They show below as they’ll look.</p>}

      <section>
        <h4>On Google</h4>
        <div className="st-serp">
          <div className="st-serp-site">
            <i>{(project?.name ?? 'S').slice(0, 1)}</i>
            <span>
              <b>{project?.name ?? 'Your site'}</b>
              <small>{displayUrl(project?.url ?? null, page.path)}</small>
            </span>
          </div>
          <p className="st-serp-title">{title.trim() ? cutAt(title.trim(), 60) : 'No title'}</p>
          <p className="st-serp-desc">{desc.trim() ? cutAt(desc.trim(), 158) : <em>No description: Google picks some text from the page instead.</em>}</p>
        </div>
        <label className="st-seo-field">
          <span>
            Title <Count n={title.trim().length} min={30} max={60} />
          </span>
          <input
            ref={titleRef}
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => commit('title', title, page.title)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setTitle(page.title)
            }}
            placeholder="What the page is about | Business name"
            disabled={working}
          />
        </label>
        <label className="st-seo-field">
          <span>
            Description <Count n={desc.trim().length} min={70} max={160} />
          </span>
          <textarea
            ref={descRef}
            value={desc}
            rows={4}
            maxLength={600}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => commit('description', desc, page.description)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') setDesc(page.description ?? '')
            }}
            placeholder="One or two sentences that make people want to click"
            disabled={working}
          />
        </label>
      </section>

      <section>
        <h4>When shared</h4>
        <div className="st-share">
          {share ? <img src={share} alt="" /> : <div className="st-share-none">No share image</div>}
          <div>
            <small>{(() => { try { return new URL(project?.url ?? '').host.replace(/^www\./, '') } catch { return 'your site' } })()}</small>
            <b>{shareTitle.trim() || title.trim() || 'No title'}</b>
            <span>{shareDesc.trim() || desc.trim()}</span>
          </div>
        </div>
        <div className="st-row">
          <button className="st-pill" onClick={onShareImage} disabled={working}>
            <Icon.image size={13} /> {share ? 'Change share image' : 'Choose a share image'}
          </button>
        </div>
        <details className="st-seo-more">
          <summary>Different words when shared</summary>
          <label className="st-seo-field">
            <span>Share headline</span>
            <input value={shareTitle} maxLength={300} onChange={(e) => setShareTitle(e.target.value)} onBlur={() => commit('og:title', shareTitle, page.og.title)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} placeholder={title || 'Uses the page title'} disabled={working} />
          </label>
          <label className="st-seo-field">
            <span>Share text</span>
            <textarea value={shareDesc} rows={2} maxLength={600} onChange={(e) => setShareDesc(e.target.value)} onBlur={() => commit('og:description', shareDesc, page.og.description)} placeholder={desc || 'Uses the description'} disabled={working} />
          </label>
        </details>
      </section>

      <section>
        <h4>Checks</h4>
        <ul className="st-checks">
          {shown.map((c) => (
            <li key={c.id} data-level={c.level}>
              <LevelIcon level={c.level} />
              <div>
                <b>{c.label}</b>
                <p>{c.detail}</p>
                {c.level !== 'good' && action(c)}
                {c.fix === 'alt' && altOpen && <AltList report={page} onAlt={onAlt} onReveal={onReveal} onClaude={onClaude} working={working} />}
              </div>
            </li>
          ))}
          {checking && (
            <li>
              <i className="st-spin" />
              <div>
                <b>Links</b>
                <p>Checking the {page.links.internal} links to other pages…</p>
              </div>
            </li>
          )}
        </ul>
      </section>

      <SiteSection crawl={crawl} pages={site.pages.length} seoSite={site.seo} current={page.path} onCrawl={onCrawl} onStop={onStopCrawl} onGo={onGo} />
    </div>
  )
}

function Count({ n, min, max }: { n: number; min: number; max: number }) {
  const level = lengthLevel(n, min, max)
  return (
    <em className="st-count" data-level={level} title={`Aim for ${min} to ${max} characters`}>
      <LevelIcon level={level} size={12} /> {n} / {max}
    </em>
  )
}

function AltList({ report, onAlt, onReveal, onClaude, working }: { report: SeoReport; onAlt: (selector: string, src: string, value: string) => void; onReveal: (selector: string) => void; onClaude: (prompt: string) => void; working: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const files = report.images.missingAlt.map((m) => m.src.split('/').pop()?.split('?')[0] ?? m.src)
  return (
    <div className="st-alts">
      {report.images.missingAlt.map((m) => (
        <form
          key={m.selector}
          onSubmit={(e) => {
            e.preventDefault()
            const v = (values[m.selector] ?? '').trim()
            if (v) onAlt(m.selector, m.src, v)
          }}
        >
          <button type="button" className="st-alt-thumb" onClick={() => onReveal(m.selector)} title="Show it on the page">
            <img src={m.src} alt="" />
          </button>
          <input value={values[m.selector] ?? ''} onChange={(e) => setValues({ ...values, [m.selector]: e.target.value })} placeholder="What the photo shows" disabled={working} />
          <button className="st-pill" disabled={working || !(values[m.selector] ?? '').trim()}>
            Set
          </button>
        </form>
      ))}
      <button
        className="st-pill"
        disabled={working}
        onClick={() =>
          onClaude(
            `These images on this page have no alt text: ${files.join(', ')}. Open each image file to see what it shows, write a short plain description (under 125 characters, without “image of”), and set it as the alt text wherever the page’s markup or data sets that image.`,
          )
        }
      >
        <Icon.claude size={12} /> Ask Claude to write them all
      </button>
    </div>
  )
}

function SiteSection({ crawl, pages, seoSite, current, onCrawl, onStop, onGo }: { crawl: Crawl | null; pages: number; seoSite: StudioSite['seo']; current: string; onCrawl: () => void; onStop: () => void; onGo: (p: string) => void }) {
  const rows = useMemo(() => {
    if (!crawl) return []
    const all = Object.values(crawl.reports).filter(Boolean) as SeoReport[]
    return Object.entries(crawl.reports)
      .map(([path, r]) => {
        if (!r) return { path, title: 'Couldn’t check it (it may redirect to another site)', score: null }
        return { path, title: r.title, score: seoScore(seoChecks({ ...r, site: seoSite ?? r.site }, all)) }
      })
      .sort((a, b) => (b.score?.fix ?? 99) - (a.score?.fix ?? 99) || (b.score?.improve ?? 0) - (a.score?.improve ?? 0) || a.path.localeCompare(b.path))
  }, [crawl, seoSite])
  const running = !!crawl && crawl.queue.length > 0
  const done = crawl ? Object.keys(crawl.reports).length : 0
  const worst = rows.reduce((n, r) => ({ fix: n.fix + (r.score?.fix ? 1 : 0), improve: n.improve + (r.score && !r.score.fix && r.score.improve ? 1 : 0), good: n.good + (r.score && !r.score.fix && !r.score.improve ? 1 : 0) }), { fix: 0, improve: 0, good: 0 })
  return (
    <section>
      <h4>Whole site</h4>
      {!crawl && (
        <>
          <p className="st-muted">Check all {pages} pages at once: it also spots titles and descriptions used on more than one page, and links that go nowhere.</p>
          <button className="st-pill" onClick={onCrawl} disabled={!pages}>
            Check every page
          </button>
        </>
      )}
      {running && (
        <div className="st-crawling">
          <p className="st-working">
            <i className="st-spin" /> Checking {Math.min(done + 1, crawl!.total)} of {crawl!.total}: {crawl!.queue[0]}
          </p>
          <progress max={crawl!.total} value={done} />
          <button className="st-pill" onClick={onStop}>
            Stop
          </button>
        </div>
      )}
      {crawl && !running && (
        <div className="st-row">
          <p className="st-muted">
            {done} page{done === 1 ? '' : 's'}: {worst.fix} need sorting, {worst.improve} could improve, {worst.good} sorted.
          </p>
          <button className="st-pill" onClick={onCrawl}>
            Check again
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <ol className="st-pages">
          {rows.map((r) => (
            <li key={r.path}>
              <button onClick={() => onGo(r.path)} aria-current={r.path === current ? 'page' : undefined} title={r.title}>
                <span className="st-pages-path">{r.path === '/' ? 'Home' : r.path}</span>
                {r.score ? (
                  <span className="st-pages-score">
                    {r.score.fix > 0 && (
                      <span data-level="fix">
                        <LevelIcon level="fix" size={12} /> {r.score.fix}
                      </span>
                    )}
                    {r.score.improve > 0 && (
                      <span data-level="improve">
                        <LevelIcon level="improve" size={12} /> {r.score.improve}
                      </span>
                    )}
                    <span data-level="good">
                      <LevelIcon level="good" size={12} /> {r.score.good}
                    </span>
                  </span>
                ) : (
                  <span className="st-muted">Couldn’t check</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

// same as the canvas's
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'

/**
 * One page of the whole-site check, loaded in a hidden frame at laptop size with
 * the unsaved edits applied. Reports once its links have been checked, or null
 * after 25 seconds. Mounted with a key per page.
 */
export function SiteCrawl({ origin, path, ops, known, onReport }: { origin: string; path: string; ops: StudioOp[]; known: React.MutableRefObject<Record<string, number>>; onReport: (path: string, r: SeoReport | null) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ ops, onReport })
  latest.current = { ops, onReport }
  useEffect(() => {
    let done = false
    const finish = (r: SeoReport | null) => {
      if (done) return
      done = true
      latest.current.onReport(path, r)
    }
    const on = (e: MessageEvent) => {
      const w = frame.current?.contentWindow
      if (e.origin !== origin || !w || e.source !== w || e.data?.studio !== true) return
      const d = e.data as { type: string; report?: SeoReport }
      if (d.type === 'ready') {
        w.postMessage({ studio: true, type: 'apply-all', ops: latest.current.ops }, origin)
        w.postMessage({ studio: true, type: 'seo-request', known: known.current, links: true }, origin)
      }
      if (d.type === 'seo' && d.report?.links.checked) {
        Object.assign(known.current, d.report.links.statuses)
        finish(d.report)
      }
    }
    window.addEventListener('message', on)
    const t = setTimeout(() => finish(null), 25_000)
    return () => {
      window.removeEventListener('message', on)
      clearTimeout(t)
    }
  }, [origin, path, known])
  return <iframe ref={frame} className="st-crawl" src={`${origin}${path}`} sandbox={SANDBOX} title="Checking the page" aria-hidden tabIndex={-1} />
}
