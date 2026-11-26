import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { quoteForCmd } from './assistant.ts'
import { saveUpload, uploadPath } from './files.ts'
import { DATA_DIR, log } from './util.ts'

// Photos for Studio from outside the site: stock photo search (Openverse's
// public-domain and CC0 photos with no key, plus Unsplash and Pexels when you
// add their free keys in Settings), alt text written by Claude from the photo
// itself, and SVG logos and icons made safe to put in a page.

export interface StockPhoto {
  id: string
  provider: 'openverse' | 'unsplash' | 'pexels'
  thumb: string
  full: string
  width: number | null
  height: number | null
  title: string
  author: string
  authorUrl: string | null
  /** the photo's own page on the provider's site */
  page: string
  license: string
  /** Unsplash asks to be told when a photo is used */
  ping?: string
}

const TIMEOUT = 15_000
const UA = 'BlueprintStudio/1.0 (website editor)'

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`)
  return r.json() as Promise<Record<string, unknown>>
}

type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function openverse(q: string, page: number): Promise<StockPhoto[]> {
  const u = new URL('https://api.openverse.org/v1/images/')
  u.searchParams.set('q', q)
  u.searchParams.set('license', 'cc0,pdm')
  u.searchParams.set('page_size', '20')
  u.searchParams.set('page', String(page))
  u.searchParams.set('mature', 'false')
  const d = (await getJson(u.href)) as Any
  return ((d.results ?? []) as Any[])
    .filter((x) => typeof x.url === 'string' && /^https:/.test(x.url))
    .map((x) => ({
      id: `ov-${x.id}`,
      provider: 'openverse' as const,
      thumb: x.thumbnail ?? x.url,
      full: x.url,
      width: x.width ?? null,
      height: x.height ?? null,
      title: x.title ?? '',
      author: x.creator ?? 'Unknown',
      authorUrl: x.creator_url ?? null,
      page: x.foreign_landing_url ?? x.url,
      license: x.license === 'pdm' ? 'Public domain' : 'CC0 (free to use)',
    }))
}

async function unsplash(q: string, page: number, key: string): Promise<StockPhoto[]> {
  const u = new URL('https://api.unsplash.com/search/photos')
  u.searchParams.set('query', q)
  u.searchParams.set('per_page', '20')
  u.searchParams.set('page', String(page))
  u.searchParams.set('content_filter', 'high')
  const d = (await getJson(u.href, { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' })) as Any
  return ((d.results ?? []) as Any[]).map((x) => ({
    id: `us-${x.id}`,
    provider: 'unsplash' as const,
    thumb: x.urls?.small,
    full: `${x.urls?.raw}&w=2400&fm=jpg&q=82`,
    width: x.width ?? null,
    height: x.height ?? null,
    title: x.alt_description ?? x.description ?? '',
    author: x.user?.name ?? 'Unsplash',
    authorUrl: x.user?.links?.html ? `${x.user.links.html}?utm_source=blueprint_studio&utm_medium=referral` : null,
    page: `${x.links?.html}?utm_source=blueprint_studio&utm_medium=referral`,
    license: 'Unsplash licence (free to use)',
    ping: x.links?.download_location,
  }))
}

async function pexels(q: string, page: number, key: string): Promise<StockPhoto[]> {
  const u = new URL('https://api.pexels.com/v1/search')
  u.searchParams.set('query', q)
  u.searchParams.set('per_page', '20')
  u.searchParams.set('page', String(page))
  const d = (await getJson(u.href, { Authorization: key })) as Any
  return ((d.photos ?? []) as Any[]).map((x) => ({
    id: `px-${x.id}`,
    provider: 'pexels' as const,
    thumb: x.src?.medium,
    full: x.src?.large2x ?? x.src?.original,
    width: x.width ?? null,
    height: x.height ?? null,
    title: x.alt ?? '',
    author: x.photographer ?? 'Pexels',
    authorUrl: x.photographer_url ?? null,
    page: x.url,
    license: 'Pexels licence (free to use)',
  }))
}

/** search every source you have, mixed so each one's best come first */
export async function stockSearch(q: string, page: number, keys: { unsplash?: string; pexels?: string }): Promise<{ photos: StockPhoto[]; errors: string[]; sources: string[] }> {
  const jobs: [string, Promise<StockPhoto[]>][] = [['Openverse', openverse(q, page)]]
  if (keys.unsplash) jobs.push(['Unsplash', unsplash(q, page, keys.unsplash)])
  if (keys.pexels) jobs.push(['Pexels', pexels(q, page, keys.pexels)])
  const results = await Promise.allSettled(jobs.map((j) => j[1]))
  const lists: StockPhoto[][] = []
  const errors: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') lists.push(r.value)
    else errors.push(`${jobs[i][0]}: ${(r.reason as Error).message}`)
  })
  // the paid-quality sources first, then interleave
  lists.reverse()
  const photos: StockPhoto[] = []
  for (let i = 0; photos.length < 60 && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) photos.push(l[i])
  return { photos, errors, sources: jobs.map((j) => j[0]) }
}

/** addresses Studio may download a photo from: public https hosts only, never this computer or the local network */
export function publicHttps(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null
  return u
}

/** download a stock photo into Studio's uploads, as if you'd chosen the file yourself */
export async function stockFetch(full: string, name: string, ping: string | null, keys: { unsplash?: string }): Promise<{ id: string; name: string } | { error: string }> {
  const u = publicHttps(full)
  if (!u) return { error: 'That photo’s address isn’t one Studio can download from' }
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(45_000) })
    const type = r.headers.get('content-type') ?? ''
    if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(type)) return { error: `The photo couldn’t be downloaded (${r.status})` }
    const len = Number(r.headers.get('content-length') ?? 0)
    if (len > 20_000_000) return { error: 'That photo is too large (over 20 MB)' }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 20_000_000) return { error: 'That photo is too large (over 20 MB)' }
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('gif') ? '.gif' : type.includes('avif') ? '.avif' : '.jpg'
    const up = saveUpload(`${name.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'photo'}${ext}`, buf)
    if (ping && keys.unsplash && publicHttps(ping)?.hostname === 'api.unsplash.com') {
      void fetch(ping, { headers: { Authorization: `Client-ID ${keys.unsplash}` }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => {})
    }
    return { id: up.id, name: up.name }
  } catch (e) {
    return { error: `The photo couldn’t be downloaded. ${(e as Error).message}` }
  }
}

// --- SVG logos and icons ---------------------------------------------------------------------

/** an SVG with nothing that can run: no scripts, event handlers, embedded HTML or outside links */
export function sanitiseSvg(text: string): string | null {
  const start = text.search(/<svg[\s>]/i)
  if (start < 0) return null
  let s = text.slice(start)
  const end = s.search(/<\/svg>\s*$/i)
  if (end < 0 && !/<\/svg>/i.test(s)) return null
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/>/gi, '')
    .replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s((?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _n, _v, a, b) => {
      const v = String(a ?? b ?? '').trim()
      return v.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? m : ''
    })
    .replace(/javascript:/gi, '')
  if (/<script/i.test(s)) return null
  return s.slice(0, s.toLowerCase().lastIndexOf('</svg>') + 6)
}

/** an uploaded SVG, made safe, for drawing inline in the page */
export function uploadedSvg(id: string): string | null {
  const file = uploadPath(id)
  if (!file || !/\.svg$/i.test(file)) return null
  try {
    return sanitiseSvg(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// --- Alt text from the photo itself ---------------------------------------------------------

const ALT_DIR = path.join(DATA_DIR, 'studio-alt')

/** fetch a photo from a Studio preview (127.0.0.1 only), into a file Claude can look at */
export async function photoToFile(src: string, ports: number[]): Promise<string | null> {
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return null
  }
  const up = u.pathname.match(/^\/__studio\/upload\/([a-z0-9]{6,24})$/)
  if (up) return uploadPath(up[1])
  if (u.hostname !== '127.0.0.1' || !ports.includes(Number(u.port))) return null
  // Claude reads JPEG, PNG, GIF and WebP: an AVIF usually has a WebP twin beside it
  const tries = /\.avif$/i.test(u.pathname) ? [u.href.replace(/\.avif(\?|$)/i, '.webp$1'), u.href.replace(/\.avif(\?|$)/i, '.jpg$1'), u.href] : [u.href]
  for (const t of tries) {
    try {
      const r = await fetch(t, { signal: AbortSignal.timeout(TIMEOUT) })
      const type = r.headers.get('content-type') ?? ''
      if (!r.ok || !/^image\/(jpeg|png|gif|webp)/.test(type)) continue
      fs.mkdirSync(ALT_DIR, { recursive: true })
      const file = path.join(ALT_DIR, `photo-${Date.now().toString(36)}${type.includes('png') ? '.png' : type.includes('gif') ? '.gif' : type.includes('webp') ? '.webp' : '.jpg'}`)
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
      return file
    } catch {
      /* try the next */
    }
  }
  return null
}

/** Claude looks at the photo and writes its alt text (UK English, one line) */
export function altFromPhoto(exe: string, file: string, context: string): Promise<{ alt: string } | { error: string }> {
  const dir = path.dirname(file)
  const prompt = [
    `Look at the image at ${file} (use the Read tool on it) and write its alt text for a website.`,
    context ? `It appears on this page: ${context.slice(0, 600)}` : '',
    'Rules: UK English, one plain sentence of at most 125 characters, describe what matters in the photo for this page, no “image of” or “photo of”, no quotes, no full stop needed. If it is purely decorative, answer DECORATIVE.',
    'Answer with the alt text only.',
  ]
    .filter(Boolean)
    .join('\n')
  const args = ['-p', '--output-format', 'text', '--model', 'sonnet', '--no-session-persistence', '--permission-mode', 'default', '--allowedTools', 'Read', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,WebFetch,WebSearch', '--add-dir', dir]
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = /\.(cmd|bat)$/i.test(exe) ? spawn([exe, ...args].map(quoteForCmd).join(' '), { cwd: dir, shell: true, windowsHide: true }) : spawn(exe, args, { cwd: dir, windowsHide: true })
    } catch (e) {
      return resolve({ error: (e as Error).message })
    }
    let out = ''
    let err = ''
    const limit = setTimeout(() => child.kill(), 120_000)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-2000)))
    child.on('error', (e) => {
      clearTimeout(limit)
      resolve({ error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(limit)
      if (file.startsWith(ALT_DIR)) fs.rmSync(file, { force: true })
      const line = out.trim().split('\n').filter(Boolean).pop()?.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim() ?? ''
      if (code !== 0 || !line) {
        log('studio alt', err || out)
        return resolve({ error: /log ?in|authenticat/i.test(err + out) ? 'Claude Code needs you to sign in once: open a terminal, run claude, and follow the steps.' : 'Claude couldn’t describe that photo.' })
      }
      resolve({ alt: /^DECORATIVE\.?$/i.test(line) ? '' : line.slice(0, 160) })
    })
    child.stdin?.end(prompt)
  })
}
