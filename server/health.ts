import type { Check, Health, Page, Psi } from '../src/data/types.ts'
import { now } from './util.ts'

// Free, lightweight site checks: one plain request for the page HTML, timed,
// plus a read of the tags search engines care about. No browser, no API key.
// If you add a free PageSpeed Insights key in Settings, Lighthouse scores are
// fetched once a day as well.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) JarvisDashboard/1.0 Safari/537.36'

export interface Fetched {
  ok: boolean
  code: number | null
  ms: number | null
  bytes: number | null
  html: string
  finalUrl: string
}

export async function fetchPage(url: string, timeout = 15_000): Promise<Fetched> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(timeout) })
    const html = (await res.text()).slice(0, 3_000_000)
    return { ok: res.ok, code: res.status, ms: Math.round(performance.now() - t0), bytes: Buffer.byteLength(html), html, finalUrl: res.url || url }
  } catch {
    return { ok: false, code: null, ms: null, bytes: null, html: '', finalUrl: url }
  }
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((x) => x !== undefined) ?? null

function metaContent(html: string, key: string): string | null {
  const re = /<meta\b[^>]*>/gi
  for (const m of html.matchAll(re)) {
    const tag = m[0]
    const n = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase()
    if (n === key) return attr(tag, 'content')
  }
  return null
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Reads the page's tags and returns pass/fail checks you'd see in an SEO audit. */
export function inspectHtml(html: string, url: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const description = decode(metaContent(html, 'description') ?? '')
  const h1 = [...html.matchAll(/<h1\b/gi)].length
  const canonical = /<link\b[^>]*rel\s*=\s*["']?canonical/i.test(html)
  const lang = attr(html.match(/<html\b[^>]*>/i)?.[0] ?? '', 'lang')
  const viewport = !!metaContent(html, 'viewport')
  const robots = (metaContent(html, 'robots') ?? '').toLowerCase()
  const ogTitle = !!metaContent(html, 'og:title')
  const ogImage = !!metaContent(html, 'og:image')
  const icon = /<link\b[^>]*rel\s*=\s*["']?[^"'>]*icon/i.test(html)
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0])
  const noAlt = imgs.filter((t) => attr(t, 'alt') === null).length
  const structured = /application\/ld\+json/i.test(html)
  const themeColor = metaContent(html, 'theme-color')
  const checks: Check[] = [
    { id: 'title', category: 'seo', label: 'Page title', pass: title.length >= 10 && title.length <= 65, detail: title ? `${title.length} chars: “${title}”` : 'Missing' },
    {
      id: 'description',
      category: 'seo',
      label: 'Meta description',
      pass: description.length >= 50 && description.length <= 165,
      detail: description ? `${description.length} chars` : 'Missing',
    },
    { id: 'h1', category: 'seo', label: 'One H1 heading', pass: h1 === 1, detail: `${h1} found` },
    { id: 'canonical', category: 'seo', label: 'Canonical link', pass: canonical },
    { id: 'indexable', category: 'seo', label: 'Indexable (no noindex)', pass: !robots.includes('noindex') },
    { id: 'og', category: 'seo', label: 'Social share tags', pass: ogTitle && ogImage, detail: ogTitle && ogImage ? 'og:title + og:image' : 'Missing og:title or og:image' },
    { id: 'schema', category: 'seo', label: 'Structured data', pass: structured },
    { id: 'lang', category: 'accessibility', label: 'Language set on <html>', pass: !!lang, detail: lang ?? 'Missing' },
    { id: 'alt', category: 'accessibility', label: 'Images have alt text', pass: noAlt === 0, detail: imgs.length ? `${imgs.length - noAlt} of ${imgs.length}` : 'No images' },
    { id: 'viewport', category: 'bestPractices', label: 'Mobile viewport tag', pass: viewport },
    { id: 'https', category: 'bestPractices', label: 'Served over HTTPS', pass: url.startsWith('https://') },
    { id: 'icon', category: 'bestPractices', label: 'Favicon', pass: icon },
  ]
  const seo = checks.filter((c) => c.category === 'seo')
  const seoScore = Math.round((seo.filter((c) => c.pass).length / seo.length) * 100)
  return { title, description, checks, seoScore, themeColor }
}

export async function checkHealth(url: string, prev: Health | undefined): Promise<Health> {
  const r = await fetchPage(url)
  const history = [...(prev?.history ?? []), r.ok && r.ms !== null ? r.ms : -1].slice(-48)
  const ups = history.filter((x) => x >= 0).length
  const tags = r.html ? inspectHtml(r.html, r.finalUrl) : null
  return {
    url,
    checked: now(),
    up: r.ok,
    code: r.code,
    ms: r.ms,
    bytes: r.bytes,
    history,
    uptimePct: history.length ? Math.round((ups / history.length) * 1000) / 10 : null,
    seoScore: tags?.seoScore ?? prev?.seoScore ?? null,
    checks: tags?.checks ?? prev?.checks ?? [],
    themeColor: tags?.themeColor ?? prev?.themeColor ?? null,
    psi: prev?.psi ?? null,
  }
}

/** Inspect a single page on demand (used by the dissection view). */
export async function inspectPage(url: string): Promise<Partial<Page>> {
  const r = await fetchPage(url)
  if (!r.html) return { code: r.code ?? undefined, checked: now() }
  const t = inspectHtml(r.html, r.finalUrl)
  return {
    title: t.title || undefined,
    description: t.description || undefined,
    checks: t.checks,
    code: r.code ?? undefined,
    ms: r.ms ?? undefined,
    bytes: r.bytes ?? undefined,
    checked: now(),
  }
}

// --- Page discovery: sitemap first, then the links in the home page nav -----------

export async function discoverPages(url: string): Promise<Page[]> {
  const origin = new URL(url).origin
  const seen = new Set<string>()
  const locs: string[] = []
  const queue: string[] = []
  const robots = await fetchPage(`${origin}/robots.txt`, 8000)
  if (robots.ok) for (const m of robots.html.matchAll(/^sitemap:\s*(\S+)/gim)) queue.push(m[1])
  queue.push(`${origin}/sitemap-index.xml`, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`)
  let fetched = 0
  while (queue.length && fetched < 8 && locs.length < 200) {
    const sm = queue.shift()!
    if (seen.has(sm)) continue
    seen.add(sm)
    const r = await fetchPage(sm, 8000)
    fetched++
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.html)) continue
    const found = [...r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]))
    if (/<sitemapindex/i.test(r.html)) queue.unshift(...found)
    else locs.push(...found)
    if (locs.length) break
  }
  const toPath = (u: string) => {
    try {
      const x = new URL(u, origin)
      if (x.origin !== origin) return null
      const p = x.pathname.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '')
      return p.length > 1 ? p.replace(/\/$/, '') : '/'
    } catch {
      return null
    }
  }
  if (locs.length) {
    const paths = [...new Set(locs.map(toPath).filter((p): p is string => !!p))]
    return paths.slice(0, 60).map((path) => ({ path, source: 'sitemap' as const }))
  }
  // no sitemap: read the home page links
  const home = await fetchPage(url, 10_000)
  const hrefs = [...home.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1])
  const paths = [...new Set(['/', ...hrefs.map(toPath).filter((p): p is string => !!p && !/\.(pdf|jpe?g|png|zip|xml)$/i.test(p))])]
  return paths.slice(0, 40).map((path) => ({ path, source: 'nav' as const }))
}

// --- Optional: PageSpeed Insights (free key from Google Cloud) ----------------------

export async function runPsi(url: string, key: string, strategy: 'mobile' | 'desktop' = 'mobile'): Promise<Psi | null> {
  const q = new URLSearchParams({ url, strategy, key })
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', c)
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(90_000) })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json()
    const cat = j.lighthouseResult?.categories ?? {}
    const au = j.lighthouseResult?.audits ?? {}
    const sc = (k: string) => Math.round((cat[k]?.score ?? 0) * 100)
    return {
      strategy,
      scores: { performance: sc('performance'), accessibility: sc('accessibility'), bestPractices: sc('best-practices'), seo: sc('seo') },
      lcp: au['largest-contentful-paint']?.numericValue ?? 0,
      cls: au['cumulative-layout-shift']?.numericValue ?? 0,
      tbt: au['total-blocking-time']?.numericValue ?? 0,
      fcp: au['first-contentful-paint']?.numericValue ?? 0,
      at: now(),
    }
  } catch {
    return null
  }
}
