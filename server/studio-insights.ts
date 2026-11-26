import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings, psiKey, saveStudioSettings } from './config.ts'
import { discoverPages, fetchPage, inspectHtml } from './health.ts'
import { decodeEntities, visibleText } from './studio-source.ts'
import { DATA_DIR, log, now, readJson, writeJsonNow } from './util.ts'

// What Studio's Checks tab reads from outside the site: Google Search Console
// and GA4 (through a service account you add in Settings, read-only), the
// detailed PageSpeed report, a site-wide check of the business's name, phone
// and address, and the weekly health check of the live sites.

// --- Google: a service account's access token -------------------------------------------------

const tokens = new Map<string, { token: string; exp: number }>()
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

async function googleToken(scope: string): Promise<string> {
  const g = loadSettings().studio?.google
  if (!g?.client_email || !g.private_key) throw new Error('Add a Google service account in Settings → Studio connections first.')
  const key = `${g.client_email}|${scope}`
  const hit = tokens.get(key)
  if (hit && hit.exp > Date.now() + 60_000) return hit.token
  const iat = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: g.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }))
  let sig: Buffer
  try {
    // a key pasted from the JSON file sometimes keeps its \n escapes
    sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(g.private_key.replace(/\\n/g, '\n'))
  } catch {
    throw new Error('The Google service account’s private key can’t be read. Paste the whole key file again in Settings.')
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
  if (!res.ok || !j.access_token) throw new Error(`Google didn’t accept the service account (${j.error_description ?? res.status}).`)
  tokens.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 })
  return j.access_token
}

async function google<T>(url: string, scope: string, body?: unknown): Promise<T> {
  const token = await googleToken(scope)
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } }
  if (!res.ok) {
    const msg = j.error?.message ?? `HTTP ${res.status}`
    if (res.status === 403) throw new Error(`The service account can’t see this yet. Add ${loadSettings().studio?.google?.client_email ?? 'it'} as a user there. (${msg})`)
    throw new Error(msg)
  }
  return j
}

const day = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** a page path as a regular expression that also matches its / and index.html forms */
function pathRegex(page: string) {
  const p = page.replace(/\/(index\.html?)?$/, '')
  return `${escapeRe(p)}(/|/index\\.html?)?(\\?.*)?$`
}

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

// --- Search Console ---------------------------------------------------------------------------

const SC = 'https://www.googleapis.com/auth/webmasters.readonly'

export interface SearchTotals {
  clicks: number
  impressions: number
  ctr: number
  position: number
}
export interface SearchReport {
  property: string
  from: string
  to: string
  now: SearchTotals
  before: SearchTotals
  queries: { query: string; clicks: number; impressions: number; position: number }[]
  pages: { page: string; clicks: number; impressions: number }[]
}

/** the Search Console property for a site: the saved one, else the one the service account can see that covers its address */
async function scProperty(projectId: string, siteUrl: string): Promise<string> {
  const saved = loadSettings().studio?.sites?.[projectId]?.searchConsole
  if (saved) return saved
  const host = hostOf(siteUrl)
  if (!host) throw new Error('This site has no live address to look up in Search Console.')
  const j = await google<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>('https://www.googleapis.com/webmasters/v3/sites', SC)
  const all = (j.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
  const domain = all.find((s) => s.siteUrl.startsWith('sc-domain:') && (host === s.siteUrl.slice(10) || host.endsWith(`.${s.siteUrl.slice(10)}`)))
  const prefix = all.find((s) => !s.siteUrl.startsWith('sc-domain:') && hostOf(s.siteUrl) === host)
  const found = domain ?? prefix
  if (!found) throw new Error(`The service account can’t see ${host} in Search Console. In Search Console open Settings → Users and permissions and add ${loadSettings().studio?.google?.client_email} (Restricted is enough).`)
  saveStudioSettings({ site: { id: projectId, searchConsole: found.siteUrl } })
  return found.siteUrl
}

export async function searchConsole(projectId: string, siteUrl: string, page: string | null, days = 28): Promise<SearchReport> {
  const property = await scProperty(projectId, siteUrl)
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`
  // Search Console's figures run two or three days behind
  const end = daysAgo(3)
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  const prevEnd = new Date(start.getTime() - 86_400_000)
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000)
  const filter = page ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: pathRegex(page) }] }] } : {}
  type Rows = { rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }
  const totals = async (a: Date, b: Date): Promise<SearchTotals> => {
    const j = await google<Rows>(url, SC, { startDate: day(a), endDate: day(b), ...filter })
    const r = j.rows?.[0]
    return { clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, ctr: r?.ctr ?? 0, position: r?.position ?? 0 }
  }
  const [nowT, beforeT, q, pg] = await Promise.all([
    totals(start, end),
    totals(prevStart, prevEnd),
    google<Rows>(url, SC, { startDate: day(start), endDate: day(end), dimensions: ['query'], rowLimit: 10, ...filter }),
    page ? Promise.resolve({ rows: [] } as Rows) : google<Rows>(url, SC, { startDate: day(start), endDate: day(end), dimensions: ['page'], rowLimit: 10 }),
  ])
  return {
    property,
    from: day(start),
    to: day(end),
    now: nowT,
    before: beforeT,
    queries: (q.rows ?? []).map((r) => ({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, position: r.position })),
    pages: (pg.rows ?? []).map((r) => {
      const u = r.keys?.[0] ?? ''
      let p = u
      try {
        p = new URL(u).pathname
      } catch {
        /* keep it whole */
      }
      return { page: p, clicks: r.clicks, impressions: r.impressions }
    }),
  }
}

// --- Google Analytics 4 -----------------------------------------------------------------------

const GA = 'https://www.googleapis.com/auth/analytics.readonly'

export interface VisitorReport {
  property: string
  days: number
  now: { views: number; visitors: number; engagement: number }
  before: { views: number; visitors: number; engagement: number }
  sources: { name: string; sessions: number }[]
  pages: { page: string; views: number }[]
}

async function gaProperty(projectId: string, siteUrl: string): Promise<string> {
  const saved = loadSettings().studio?.sites?.[projectId]?.ga4
  if (saved) return saved.replace(/^properties\//, '')
  const host = hostOf(siteUrl)
  if (!host) throw new Error('This site has no live address to look up in Google Analytics.')
  const j = await google<{ accountSummaries?: { propertySummaries?: { property: string; displayName: string }[] }[] }>('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', GA)
  const props = (j.accountSummaries ?? []).flatMap((a) => a.propertySummaries ?? [])
  if (!props.length) throw new Error(`The service account can’t see any Google Analytics property. In Analytics open Admin → Property access management and add ${loadSettings().studio?.google?.client_email} as a Viewer.`)
  for (const p of props.slice(0, 40)) {
    const s = await google<{ dataStreams?: { webStreamData?: { defaultUri?: string } }[] }>(`https://analyticsadmin.googleapis.com/v1beta/${p.property}/dataStreams`, GA).catch(() => ({ dataStreams: [] }))
    if ((s.dataStreams ?? []).some((d) => hostOf(d.webStreamData?.defaultUri) === host)) {
      const id = p.property.replace(/^properties\//, '')
      saveStudioSettings({ site: { id: projectId, ga4: id } })
      return id
    }
  }
  throw new Error(`None of the Analytics properties the service account can see is for ${host}. Add the property’s number in Settings → Studio connections.`)
}

export async function analytics(projectId: string, siteUrl: string, page: string | null, days = 28): Promise<VisitorReport> {
  const id = await gaProperty(projectId, siteUrl)
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`
  const filter = page ? { dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: `^${pathRegex(page)}` } } } } : {}
  const ranges = [
    { startDate: `${days}daysAgo`, endDate: 'yesterday', name: 'now' },
    { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo`, name: 'before' },
  ]
  type Report = { rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[] }
  const [t, s, pg] = await Promise.all([
    google<Report>(url, GA, { dateRanges: ranges, metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'engagementRate' }], ...filter }),
    google<Report>(url, GA, { dateRanges: [ranges[0]], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 6, ...filter }),
    page ? Promise.resolve({ rows: [] } as Report) : google<Report>(url, GA, { dateRanges: [ranges[0]], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }),
  ])
  const pick = (name: string) => {
    const r = (t.rows ?? []).find((x) => x.dimensionValues?.some((d) => d.value === name))
    const v = (i: number) => Number(r?.metricValues?.[i]?.value ?? 0)
    return { views: v(0), visitors: v(1), engagement: v(2) }
  }
  return {
    property: id,
    days,
    now: pick('now'),
    before: pick('before'),
    sources: (s.rows ?? []).map((r) => ({ name: r.dimensionValues?.[0]?.value ?? '', sessions: Number(r.metricValues?.[0]?.value ?? 0) })),
    pages: (pg.rows ?? []).map((r) => ({ page: r.dimensionValues?.[0]?.value ?? '', views: Number(r.metricValues?.[0]?.value ?? 0) })),
  }
}

// --- PageSpeed, in detail ---------------------------------------------------------------------

export interface SpeedReport {
  url: string
  strategy: 'mobile' | 'desktop'
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number }
  metrics: { id: string; label: string; value: string; score: number }[]
  fixes: { title: string; saving: string; detail: string }[]
  shot: string | null
  at: string
}

const METRICS: [string, string][] = [
  ['largest-contentful-paint', 'Largest photo or text shows'],
  ['first-contentful-paint', 'First thing shows'],
  ['total-blocking-time', 'Time the page is stuck'],
  ['cumulative-layout-shift', 'Things jumping about'],
  ['speed-index', 'Speed index'],
]

export async function psiDetail(url: string, strategy: 'mobile' | 'desktop'): Promise<SpeedReport> {
  const q = new URLSearchParams({ url, strategy })
  const key = psiKey()
  if (key) q.set('key', key)
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', c)
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(120_000) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg: string = j?.error?.message ?? `HTTP ${res.status}`
    if (res.status === 429) throw new Error('Google’s free PageSpeed allowance is used up for now. Add a free PageSpeed key in Settings, or try again in a few minutes.')
    throw new Error(`PageSpeed couldn’t test ${url}: ${msg.split('\n')[0]}`)
  }
  const cat = j.lighthouseResult?.categories ?? {}
  const au = j.lighthouseResult?.audits ?? {}
  const sc = (k: string) => Math.round((cat[k]?.score ?? 0) * 100)
  const fixes = Object.values(au as Record<string, { title: string; description: string; score: number | null; details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number }; displayValue?: string }>)
    .filter((a) => a.details?.type === 'opportunity' && (a.score ?? 1) < 0.9 && ((a.details.overallSavingsMs ?? 0) > 50 || (a.details.overallSavingsBytes ?? 0) > 20_000))
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, 8)
    .map((a) => ({
      title: a.title,
      saving: a.displayValue ?? (a.details?.overallSavingsMs ? `about ${(a.details.overallSavingsMs / 1000).toFixed(1)} s` : ''),
      // Lighthouse's descriptions end with a "[Learn more](…)" link
      detail: String(a.description ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s*Learn (more|how)[^.]*\.?$/i, '').trim(),
    }))
  return {
    url,
    strategy,
    scores: { performance: sc('performance'), accessibility: sc('accessibility'), bestPractices: sc('best-practices'), seo: sc('seo') },
    metrics: METRICS.filter(([id]) => au[id]).map(([id, label]) => ({ id, label, value: String(au[id].displayValue ?? ''), score: Math.round((au[id].score ?? 0) * 100) })),
    fixes,
    shot: typeof au['final-screenshot']?.details?.data === 'string' ? au['final-screenshot'].details.data : null,
    at: now(),
  }
}

// --- Name, address and phone across the whole site ------------------------------------------

export interface NapReport {
  pages: number
  phones: { value: string; digits: string; pages: string[] }[]
  emails: { value: string; pages: string[] }[]
  names: { value: string; pages: string[] }[]
  addresses: { value: string; pages: string[] }[]
  schema: { pages: string[]; phone: string | null; name: string | null; address: string | null }
  problems: string[]
}

/** UK numbers in one form: +44 1732 … and 01732 … are the same number */
const digitsOf = (s: string) => {
  const d = s.replace(/[^\d+]/g, '').replace(/^\+44\(?0?\)?/, '0').replace(/^0044/, '0').replace(/\D/g, '')
  return d
}

export async function napAcrossSite(port: number, pages: string[]): Promise<NapReport> {
  /** each number (by its digits): the ways the pages write it, and the pages that link it for tap-to-call */
  const phones = new Map<string, { forms: Map<string, Set<string>>; linked: Set<string> }>()
  const emails = new Map<string, Set<string>>()
  const names = new Map<string, Set<string>>()
  const addresses = new Map<string, Set<string>>()
  const schema = { pages: [] as string[], phone: null as string | null, name: null as string | null, address: null as string | null }
  const schemaPhones = new Set<string>()
  const add = (m: Map<string, Set<string>>, k: string, page: string) => {
    if (!m.has(k)) m.set(k, new Set())
    m.get(k)!.add(page)
  }
  const list = pages.slice(0, 80)
  let done = 0
  const queue = [...list]
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
        let html = ''
        try {
          const res = await fetch(`http://127.0.0.1:${port}${page}`, { signal: AbortSignal.timeout(20_000) })
          if (!res.ok || !String(res.headers.get('content-type')).includes('html')) continue
          html = await res.text()
        } catch {
          continue
        }
        done++
        for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
          const v = decodeURIComponent(m[1]).trim()
          const d = digitsOf(v)
          if (d.length < 9) continue
          if (!phones.has(d)) phones.set(d, { forms: new Map(), linked: new Set() })
          phones.get(d)!.linked.add(page)
        }
        const text = visibleText(html)
        for (const m of text.matchAll(/(?:\+44\s?\(?0?\)?\s?|\b0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g)) {
          const v = m[0].trim()
          const d = digitsOf(v)
          if (d.length < 10 || d.length > 11) continue
          if (!phones.has(d)) phones.set(d, { forms: new Map(), linked: new Set() })
          add(phones.get(d)!.forms, v.replace(/\s+/g, ' '), page)
        }
        for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) add(emails, decodeEntities(m[1]).trim().toLowerCase(), page)
        for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
          let data: unknown
          try {
            data = JSON.parse(m[1])
          } catch {
            continue
          }
          const objs: Record<string, unknown>[] = []
          const walk = (v: unknown): void => {
            if (Array.isArray(v)) return v.forEach(walk)
            if (!v || typeof v !== 'object') return
            const o = v as Record<string, unknown>
            objs.push(o)
            if (o['@graph']) walk(o['@graph'])
          }
          walk(data)
          const biz = objs.find((o) => /LocalBusiness|Dentist|Organization|Store|Restaurant|MedicalBusiness|ProfessionalService|Corporation/.test(String(o['@type'])))
          if (!biz) continue
          schema.pages.push(page)
          if (typeof biz.name === 'string') {
            schema.name ??= biz.name
            add(names, biz.name.trim(), page)
          }
          if (typeof biz.telephone === 'string') {
            schema.phone ??= biz.telephone
            schemaPhones.add(digitsOf(biz.telephone))
          }
          const a = biz.address as Record<string, string> | string | undefined
          const addr = typeof a === 'string' ? a : a ? [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ') : ''
          if (addr) {
            schema.address ??= addr
            add(addresses, addr.replace(/\s+/g, ' ').trim(), page)
          }
        }
        const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1]
        if (siteName) add(names, decodeEntities(siteName).trim(), page)
        const address = html.match(/<address\b[^>]*>([\s\S]*?)<\/address>/i)?.[1]
        if (address) add(addresses, visibleText(address).replace(/\s+/g, ' ').trim().slice(0, 160), page)
      }
    }),
  )
  const phoneList = [...phones.entries()]
    .map(([digits, v]) => {
      const pagesOf = new Set<string>(v.linked)
      for (const s of v.forms.values()) s.forEach((p) => pagesOf.add(p))
      // the way it's written most is the one shown
      const top = [...v.forms.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0] ?? digits
      return { value: top, digits, pages: [...pagesOf], forms: [...v.forms.keys()] }
    })
    .sort((a, b) => b.pages.length - a.pages.length)
  const problems: string[] = []
  if (!schema.pages.length) problems.push('No page tells Google the business’s details in structured data (LocalBusiness). Adding it helps you show up on Google Maps and local searches.')
  else if (!schema.pages.includes('/')) problems.push(`Only ${schema.pages.length === 1 ? schema.pages[0] : `${schema.pages.length} pages`} give${schema.pages.length === 1 ? 's' : ''} Google the business’s details in structured data. Put it on the home page too, where Google looks first.`)
  for (const d of schemaPhones) if (!phones.has(d)) problems.push(`The structured data gives the phone number as ${schema.phone}, which isn’t shown anywhere on the site.`)
  if (schemaPhones.size > 1) problems.push('The structured data gives different phone numbers on different pages.')
  const main = phoneList[0]
  if (main && main.pages.length < Math.ceil(done * 0.6) && done > 3) problems.push(`The main phone number (${main.value}) is only on ${main.pages.length} of ${done} pages. Most sites put it in the header or footer of every page.`)
  for (const p of phoneList) {
    if (p.forms.length > 1) problems.push(`${p.value} is written ${p.forms.length} different ways (${p.forms.slice(0, 3).join(', ')}). Pick one.`)
    const v = phones.get(p.digits)!
    // a number only one page mentions (a regulator's, say) isn't the business's own
    if (v.forms.size && !v.linked.size && (p.pages.length > 1 || schemaPhones.has(p.digits))) problems.push(`${p.value} isn’t a tap-to-call link anywhere, so phones can’t ring it with one tap.`)
  }
  if (names.size > 1) problems.push(`The business name is given ${names.size} ways: ${[...names.keys()].slice(0, 3).map((n) => `“${n}”`).join(', ')}.`)
  if (addresses.size > 1) problems.push(`The address is written ${addresses.size} different ways. Google trusts a business more when it’s the same everywhere.`)
  const out = (m: Map<string, Set<string>>) => [...m.entries()].map(([value, s]) => ({ value, pages: [...s] })).sort((a, b) => b.pages.length - a.pages.length)
  return { pages: done, phones: phoneList.map(({ value, digits, pages }) => ({ value, digits, pages })), emails: out(emails), names: out(names), addresses: out(addresses), schema, problems }
}

// --- The weekly health check of the live sites -----------------------------------------------

export interface WeeklyRun {
  at: string
  url: string
  pages: { path: string; code: number | null; ms: number | null; fails: string[] }[]
  broken: { href: string; status: number; from: string[] }[]
  slow: string[]
  problems: string[]
}
export interface WeeklyReport {
  runs: WeeklyRun[]
  /** problems the latest run found that the one before didn't, and ones it fixed */
  slipped: string[]
  fixed: string[]
  running: boolean
}

const WEEKLY_DIR = path.join(DATA_DIR, 'studio-health')
const fileOf = (id: string) => path.join(WEEKLY_DIR, `${id.replace(/[^\w-]/g, '_')}.json`)
const running = new Set<string>()

export function weeklyOf(id: string): WeeklyReport {
  const runs = readJson<WeeklyRun[]>(fileOf(id), [])
  const [a, b] = runs
  const set = (r: WeeklyRun | undefined) => new Set(r?.problems ?? [])
  const now = set(a)
  const before = set(b)
  return {
    runs,
    slipped: b ? [...now].filter((p) => !before.has(p)) : [],
    fixed: b ? [...before].filter((p) => !now.has(p)) : [],
    running: running.has(id),
  }
}

export const weeklyDue = (id: string) => {
  const last = readJson<WeeklyRun[]>(fileOf(id), [])[0]
  return !last || Date.now() - Date.parse(last.at) > 7 * 86_400_000 - 3_600_000
}

const LABEL: Record<string, string> = {
  title: 'its page title is missing or the wrong length',
  description: 'its Google description is missing or the wrong length',
  h1: 'it needs exactly one main heading',
  canonical: 'it has no canonical link',
  indexable: 'it’s hidden from Google (noindex)',
  og: 'it has no social share title or image',
  lang: 'its language isn’t set',
  alt: 'some photos have no alt text',
  viewport: 'it has no phone layout tag',
}
const placeOf = (p: string) => (p === '/' ? 'Home page' : p)

/** Crawl the live site: every page's status, speed and SEO basics, and every internal link. */
export async function weeklyCheck(id: string, url: string): Promise<WeeklyReport> {
  if (running.has(id)) return weeklyOf(id)
  running.add(id)
  try {
    const origin = new URL(url).origin
    const found = await discoverPages(url)
    const paths = [...new Set(['/', ...found.map((p) => p.path)])].slice(0, 40)
    const pages: WeeklyRun['pages'] = []
    const links = new Map<string, Set<string>>()
    const queue = [...paths]
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          const r = await fetchPage(origin + p, 20_000)
          const fails = r.html ? inspectHtml(r.html, r.finalUrl).checks.filter((c) => !c.pass && c.id in LABEL && c.id !== 'schema').map((c) => c.id) : []
          pages.push({ path: p, code: r.code, ms: r.ms, fails })
          for (const m of r.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
            let u: URL
            try {
              u = new URL(decodeEntities(m[1]), r.finalUrl)
            } catch {
              continue
            }
            if (u.origin !== origin || /\.(pdf|jpe?g|png|webp|zip)$/i.test(u.pathname)) continue
            if (!links.has(u.pathname)) links.set(u.pathname, new Set())
            links.get(u.pathname)!.add(p)
          }
        }
      }),
    )
    const crawled = new Map(pages.map((p) => [p.path.replace(/\/$/, '') || '/', p.code]))
    const broken: WeeklyRun['broken'] = []
    const todo = [...links.keys()].filter((h) => !crawled.has(h.replace(/\/$/, '') || '/')).slice(0, 150)
    for (const [href, from] of links) {
      const code = crawled.get(href.replace(/\/$/, '') || '/')
      if (code !== undefined && code !== null && code >= 400) broken.push({ href, status: code, from: [...from].slice(0, 6) })
    }
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let h = todo.shift(); h !== undefined; h = todo.shift()) {
          let status = 0
          try {
            let r = await fetch(origin + h, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) })
            if (r.status >= 400) r = await fetch(origin + h, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
            status = r.status
          } catch {
            status = 0
          }
          if (status >= 400 || status === 0) broken.push({ href: h, status, from: [...(links.get(h) ?? [])].slice(0, 6) })
        }
      }),
    )
    pages.sort((a, b) => a.path.localeCompare(b.path))
    const slow = pages.filter((p) => (p.ms ?? 0) > 2500).map((p) => p.path)
    const problems = [
      ...pages.filter((p) => !p.code || p.code >= 400).map((p) => `${placeOf(p.path)} doesn’t open (${p.code ?? 'no answer'})`),
      ...pages.flatMap((p) => p.fails.map((f) => `${placeOf(p.path)}: ${LABEL[f]}`)),
      ...broken.map((b) => `Broken link to ${b.href}`),
      ...slow.map((s) => `${placeOf(s)} is slow to answer (over 2.5 s)`),
    ]
    const run: WeeklyRun = { at: now(), url: origin, pages, broken, slow, problems }
    fs.mkdirSync(WEEKLY_DIR, { recursive: true })
    writeJsonNow(fileOf(id), [run, ...readJson<WeeklyRun[]>(fileOf(id), [])].slice(0, 6))
    return weeklyOf(id)
  } catch (e) {
    log('weekly check', id, (e as Error).message)
    throw e
  } finally {
    running.delete(id)
  }
}
