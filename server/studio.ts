import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Project, StudioElement, StudioKind, StudioMetaField, StudioOp, StudioPage, StudioResult, StudioSeoSite, StudioSite } from '../src/data/types.ts'
import { commitTitle, mediaLabel, mediaQuery, opNote, propName } from '../src/data/studio.ts'
import { ask, quoteForCmd } from './assistant.ts'
import { DATA_DIR, log } from './util.ts'
import { typeOf, uploadPath } from './files.ts'
import { OVERLAY_JS } from './studio-overlay.ts'
import { encodeFor, findInText, findPattern, modeAt, replaceHits, sourceFiles, textPattern, type Hit } from './studio-source.ts'
import { sanitiseSvg } from './studio-media.ts'

// Studio: the visual site builder. Each website gets its own clean clone under
// .jarvis/studio/<repo> (never your working folder, so Studio can't trip over
// half-done work), synced to the latest commit on its default branch. A small
// preview server per site serves it on 127.0.0.1 with Studio's overlay script
// injected into every HTML page, so the canvas can select elements. Astro
// sites run their own dev server behind that preview server.

export const STUDIO_DIR = path.join(DATA_DIR, 'studio')

export interface Runtime {
  site: StudioSite
  folder: string
  server?: http.Server
  dev?: ChildProcess
  devPort?: number
  busy?: Promise<void>
  lastUsed: number
}

const sites = new Map<string, Runtime>()

/** a site Studio has open, for the other Studio modules */
export const runtimeOf = (id: string) => sites.get(id) ?? null
/** the preview ports Studio is serving, so other code can tell a preview address from anything else */
export const previewPorts = () => [...sites.values()].map((r) => r.site.port).filter((p): p is number => !!p)

/** Which kind of site a folder holds, from the files in it. */
export function detectKind(folder: string): { kind: StudioKind; root: string; build: string[] | null } {
  const has = (f: string) => fs.existsSync(path.join(folder, f))
  if (has('layout/theme.liquid')) return { kind: 'shopify', root: folder, build: null }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (deps.astro) return { kind: 'astro', root: path.join(folder, 'dist'), build: null }
      if (deps.expo || deps['react-native'] || deps['@capacitor/core'] || deps.electron) return { kind: 'app', root: folder, build: null }
    } catch {
      /* unreadable package.json: fall through to the static checks */
    }
  }
  // generator scripts that write HTML from data files (all plain Node, no install needed)
  if (has('build.mjs') && has('data')) return { kind: 'generated', root: path.join(folder, 'dist'), build: ['build.mjs'] }
  if (has('src/build.mjs')) return { kind: 'generated', root: folder, build: ['src/build.mjs'] }
  if (has('build-v2/build.js')) return { kind: 'generated', root: folder, build: ['build-v2/build.js'] }
  if (has('index.html')) return { kind: 'static', root: folder, build: null }
  if (has('site/index.html')) return { kind: 'static', root: path.join(folder, 'site'), build: null }
  return { kind: 'unknown', root: folder, build: null }
}

/** In the desktop app process.execPath is Electron itself: this makes it behave as plain Node. */
const AS_NODE = { ELECTRON_RUN_AS_NODE: '1' }

/** Run a command, resolving with its output; never throws. */
/** Run a command; `keep` is how much of the end of its output to hold on to. */
export function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeout = 10 * 60_000, keep = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32' && /^(npm|npx)$/.test(cmd)
    const child = spawn(win ? `${cmd}.cmd` : cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: win })
    let out = ''
    const add = (b: Buffer) => {
      out = (out + b.toString()).slice(-keep)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, out: out + e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out })
    })
  })
}

/**
 * git with your GitHub token passed as an HTTP header through the environment:
 * it never lands in .git/config, the remote URL or the process list.
 */
export function git(args: string[], cwd: string, token: string | null, timeout = 5 * 60_000) {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return run('git', args, cwd, env, timeout)
}

function folderOf(p: Project) {
  return path.join(STUDIO_DIR, p.repo.split('/').pop()!.replace(/[^\w.-]/g, '_'))
}

function blank(p: Project): StudioSite {
  return { projectId: p.id, repo: p.repo, branch: p.defaultBranch, kind: 'unknown', status: 'idle', message: '', port: null, sha: null, commit: null, committed: null, changed: [], notes: [], pages: [], seo: null, last: null, touched: [], pipeline: 'files', schedule: null, openedMs: null }
}

/** how new photos become web-ready on this site */
export function detectPipeline(dir: string, kind: StudioKind): StudioSite['pipeline'] {
  const script = path.join(dir, 'build-v2', 'images.js')
  if (fs.existsSync(script) && /const jobs\s*=\s*\[/.test(fs.readFileSync(script, 'utf8'))) return 'script'
  if (kind === 'astro' && fs.existsSync(path.join(dir, 'src', 'assets'))) return 'astro'
  return 'files'
}

export function studioState(p: Project): StudioSite {
  const r = sites.get(p.id)
  if (r) return r.site
  const folder = folderOf(p)
  const site = blank(p)
  if (fs.existsSync(path.join(folder, '.git'))) site.kind = detectKind(folder).kind
  return site
}

/** Open a site in Studio: clone or sync it, build it if needed, start its preview. Returns at once; poll studioState. */
export function openSite(p: Project, token: string | null, opts: { sync?: boolean } = {}): StudioSite {
  let r = sites.get(p.id)
  if (!r) {
    r = { site: blank(p), folder: folderOf(p), lastUsed: Date.now() }
    sites.set(p.id, r)
  }
  r.lastUsed = Date.now()
  r.site.branch = p.defaultBranch
  if (r.busy) return r.site
  if (r.site.status === 'ready' && !opts.sync) return r.site
  const rt = r
  rt.busy = prepare(rt, p, token)
    .catch((e) => {
      rt.site.status = 'error'
      rt.site.message = (e as Error).message
      log('studio', p.repo, (e as Error).message)
    })
    .finally(() => {
      rt.busy = undefined
    })
  return r.site
}

const set = (r: Runtime, status: StudioSite['status'], message: string) => {
  r.site.status = status
  r.site.message = message
}

async function prepare(r: Runtime, p: Project, token: string | null) {
  const t0 = Date.now()
  fs.mkdirSync(STUDIO_DIR, { recursive: true })
  const dir = r.folder
  const branch = p.defaultBranch
  if (!fs.existsSync(path.join(dir, '.git'))) {
    set(r, 'syncing', `Downloading ${p.name} from GitHub`)
    fs.rmSync(dir, { recursive: true, force: true })
    const c = await git(['clone', '--depth', '1', '--branch', branch, '--single-branch', `https://github.com/${p.repo}.git`, dir], STUDIO_DIR, token)
    if (!c.ok) throw new Error(`Couldn’t download ${p.repo} from GitHub. ${lastLine(c.out)}`)
  } else {
    set(r, 'syncing', 'Getting the latest from GitHub')
    const f = await git(['fetch', '--depth', '1', 'origin', branch], dir, token)
    if (!f.ok) throw new Error(`Couldn’t reach GitHub. ${lastLine(f.out)}`)
    if (studioEdits(dir).files.length) {
      // unpublished Studio edits: keep them rather than wipe them
    } else {
      const reset = await git(['reset', '--hard', 'FETCH_HEAD'], dir, null)
      await git(['clean', '-fdq', '-e', 'node_modules'], dir, null)
      if (!reset.ok) throw new Error(`Couldn’t update the local copy. ${lastLine(reset.out)}`)
    }
  }
  await readHead(r)
  const { kind, root, build } = detectKind(dir)
  r.site.kind = kind
  if (kind === 'shopify') return set(r, 'unsupported', 'Shopify themes are edited in Shopify’s own theme editor for now. Studio shows the live shop instead.')
  if (kind === 'app') return set(r, 'unsupported', 'This is an app, not a website, so it isn’t in Studio.')
  if (kind === 'unknown') return set(r, 'unsupported', 'Studio couldn’t find a website in this repo (no index.html, Astro project or build script).')

  r.site.pipeline = detectPipeline(dir, kind)
  // the pages are already built from exactly this source: no need to build again
  if (build && builtStamp(r) !== readStamp(dir)) {
    set(r, 'building', 'Building the pages')
    const b = await run(process.execPath, build, dir, AS_NODE)
    if (!b.ok) throw new Error(`The site’s build script failed. ${lastLine(b.out)}`)
    writeStamp(r)
  }
  if (kind === 'astro') await startAstro(r)
  await startPreview(r, root)
  r.site.pages = listPages(dir, kind, root, p)
  r.site.seo = siteSeo(dir, kind, root)
  r.site.openedMs = Date.now() - t0
  set(r, 'ready', '')
}

// --- Skipping a build that's already done ---------------------------------------------------

const STAMP = (dir: string) => path.join(dir, '.git', 'studio-built')
const readStamp = (dir: string) => {
  try {
    return fs.readFileSync(STAMP(dir), 'utf8')
  } catch {
    return ''
  }
}
/** the commit and Studio's saved edits (with their files' times) the pages were last built from */
function builtStamp(r: Runtime) {
  const e = studioEdits(r.folder)
  const times = e.files.map((f) => {
    try {
      return `${f}:${fs.statSync(path.join(r.folder, f)).mtimeMs}`
    } catch {
      return f
    }
  })
  return `${r.site.sha}|${times.join(',')}`
}
const writeStamp = (r: Runtime) => fs.writeFileSync(STAMP(r.folder), builtStamp(r))

export async function readHead(r: Runtime) {
  const h = await git(['log', '-1', '--format=%H%n%cI%n%s'], r.folder, null)
  const [sha, when, ...subject] = h.out.trim().split('\n')
  r.site.sha = sha || null
  r.site.committed = when || null
  r.site.commit = subject.join(' ') || null
  const e = studioEdits(r.folder)
  r.site.changed = e.files
  r.site.notes = e.notes
  r.site.touched = e.pages
}

/**
 * Files you've changed in Studio and not yet published, and what the changes
 * are, as Studio records them in .git/studio-edits.json. (Not `git status`: a
 * site's own build script rewrites its pages, and that isn't an edit worth
 * keeping over the latest from GitHub.)
 */
export interface Edits {
  files: string[]
  notes: string[]
  /** pages the edits were made on */
  pages: string[]
}
const EDITS = (dir: string) => path.join(dir, '.git', 'studio-edits.json')

export function studioEdits(dir: string): Edits {
  try {
    const e = JSON.parse(fs.readFileSync(EDITS(dir), 'utf8'))
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return { files: strs(e.files), notes: strs(e.notes), pages: strs(e.pages) }
  } catch {
    return { files: [], notes: [], pages: [] }
  }
}

export function saveEdits(dir: string, e: Edits | null) {
  if (!e || (!e.files.length && !e.notes.length)) fs.rmSync(EDITS(dir), { force: true })
  else fs.writeFileSync(EDITS(dir), JSON.stringify(e, null, 2))
}

export const lastLine = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .slice(-2)
    .join(' ')
    .slice(0, 300)

// --- Astro dev server -----------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function startAstro(r: Runtime) {
  if (r.dev && r.dev.exitCode === null) return
  const dir = r.folder
  const lock = path.join(dir, 'package-lock.json')
  const stamp = path.join(dir, 'node_modules', '.studio-lock')
  const want = fs.existsSync(lock) ? crypto.createHash('sha1').update(fs.readFileSync(lock)).digest('hex') : 'none'
  const have = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : ''
  if (want !== have) {
    set(r, 'installing', 'Installing the site’s packages (first time only, a minute or two)')
    const i = await run('npm', [fs.existsSync(lock) ? 'ci' : 'install', '--no-audit', '--no-fund'], dir)
    if (!i.ok) throw new Error(`npm install failed. ${lastLine(i.out)}`)
    fs.writeFileSync(stamp, want)
  }
  set(r, 'starting', 'Starting the site')
  const port = await freePort()
  const bin = astroBin(dir)
  if (!bin) throw new Error('Astro isn’t installed in this site’s packages')
  // --ignore-lock also keeps it in the foreground (Astro backgrounds itself when it thinks an AI agent started it)
  const child = spawn(process.execPath, [bin, 'dev', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], { cwd: dir, windowsHide: true, env: { ...process.env, ...AS_NODE, ASTRO_TELEMETRY_DISABLED: '1', BROWSER: 'none' } })
  let out = ''
  child.stdout?.on('data', (b) => (out = (out + b).slice(-8000)))
  child.stderr?.on('data', (b) => (out = (out + b).slice(-8000)))
  r.dev = child
  r.devPort = port
  child.on('exit', () => {
    if (r.dev === child) {
      r.dev = undefined
      if (r.site.status === 'ready') set(r, 'error', `The site’s dev server stopped. ${lastLine(out)}`)
    }
  })
  // wait until it answers
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`The site’s dev server didn’t start. ${lastLine(out)}`)
    const ok = await new Promise<boolean>((res) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (x) => {
        x.resume()
        res(true)
      })
      req.on('error', () => res(false))
      req.on('timeout', () => (req.destroy(), res(false)))
    })
    if (ok) return
    await new Promise((res) => setTimeout(res, 700))
  }
  throw new Error('The site’s dev server took too long to start')
}

/** Astro's command-line script, from its package.json (it moved between versions) */
function astroBin(dir: string) {
  const pkgDir = path.join(dir, 'node_modules', 'astro')
  try {
    const bin = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).bin
    const rel = typeof bin === 'string' ? bin : bin?.astro
    const file = rel ? path.join(pkgDir, rel) : null
    return file && fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}

// --- Preview server -------------------------------------------------------------------------

const INJECT = `<script src="/__studio/overlay.js" data-studio></script>`

/** Studio's overlay at the end of the page, after `extra` (the unsaved edits, for a phone preview or a screenshot) */
function inject(html: string, extra = '') {
  if (html.includes('data-studio')) return html
  const tag = extra + INJECT
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag
}

// Unsaved edits handed to a page that isn't in the canvas (a screenshot, or the phone preview):
// the page asks for them by key, and the overlay applies them without its editing tools.
const heldOps = new Map<string, { ops: unknown[]; until: number }>()

/** keep edits for a page load outside the canvas; returns the key to ask for them with */
export function holdOps(ops: unknown[], ms = 5 * 60_000, key = crypto.randomBytes(12).toString('hex')) {
  for (const [k, v] of heldOps) if (v.until < Date.now()) heldOps.delete(k)
  heldOps.set(key, { ops, until: Date.now() + ms })
  return key
}
export const dropOps = (key: string) => heldOps.delete(key)

function opsScript(req: http.IncomingMessage, url: URL) {
  const key = url.searchParams.get('__studio_ops') ?? (req.headers['x-studio-ops'] as string | undefined)
  const held = key ? heldOps.get(key) : null
  if (!held) return ''
  // safe inside a <script>: no way to close the tag from the data
  const json = JSON.stringify(held.ops).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<script data-studio-ops>window.__studioOps=${json}</script>`
}

/** Only answer to 127.0.0.1/localhost (guards against DNS rebinding). */
function localHost(req: http.IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return ['localhost', '127.0.0.1', '[::1]'].includes(host)
}

let axeSource: string | null | undefined
/** the accessibility checker (axe-core), served to the overlay when the Checks tab asks for it */
function axe(): string | null {
  if (axeSource !== undefined) return axeSource
  axeSource = null
  // the desktop app has it next to its server bundle; `npm run dev` reads it from node_modules
  const next = path.join(path.dirname(fileURLToPath(import.meta.url)), 'axe.min.js')
  try {
    axeSource = fs.readFileSync(fs.existsSync(next) ? next : createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  } catch {
    /* not installed: the Checks tab says so */
  }
  return axeSource
}

async function startPreview(r: Runtime, root: string) {
  if (r.server?.listening) return
  const server = http.createServer((req, res) => {
    if (!localHost(req)) {
      res.statusCode = 403
      return res.end('Studio previews only answer on this computer')
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/__studio/overlay.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(OVERLAY_JS)
    }
    if (url.pathname === '/__studio/axe.js') {
      const src = axe()
      res.statusCode = src ? 200 : 404
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'max-age=3600')
      return res.end(src ?? '')
    }
    const up = url.pathname.match(/^\/__studio\/upload\/([a-z0-9]{6,24})$/)
    if (up) {
      // a photo or video you've just swapped in, before it's saved into the site
      const file = uploadPath(up[1])
      if (!file || !/\.(jpe?g|png|webp|avif|gif|svg|mp4|webm)$/i.test(file)) return notFound(root, res)
      res.setHeader('Cache-Control', 'no-store')
      if (/\.svg$/i.test(file)) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      return send(file, res, 200)
    }
    const extra = opsScript(req, url)
    if (r.devPort && r.dev) return proxy(req, res, r.devPort, extra)
    serveStatic(root, url.pathname, res, extra)
  })
  if (r.devPort) server.on('upgrade', (req, socket, head) => tunnel(req, socket as net.Socket, head, r.devPort!))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  r.server = server
  r.site.port = (server.address() as net.AddressInfo).port
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse, extra = '') {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    rel = pathname
  }
  // no dotfiles or dot-folders (.git, .env, .github): only the site itself
  if (rel.split('/').some((s) => s.startsWith('.'))) return notFound(root, res)
  const base = path.resolve(root)
  const candidates = [rel, path.posix.join(rel, 'index.html'), `${rel.replace(/\/$/, '')}.html`]
  for (const c of candidates) {
    const file = path.resolve(base, '.' + path.posix.normalize('/' + c))
    if (file !== base && !file.startsWith(base + path.sep)) continue
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(file, res, 200, extra)
  }
  notFound(root, res, extra)
}

function notFound(root: string, res: http.ServerResponse, extra = '') {
  const page = path.join(root, '404.html')
  if (fs.existsSync(page)) return send(page, res, 404, extra)
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(inject('<!doctype html><title>Not found</title><p style="font:16px system-ui;padding:2rem">This page isn’t in the site.</p>', extra))
}

function send(file: string, res: http.ServerResponse, code: number, extra = '') {
  const type = /\.html?$/i.test(file) ? 'text/html; charset=utf-8' : (EXTRA[path.extname(file).toLowerCase()] ?? typeOf(file))
  res.statusCode = code
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  // Studio's photo editor draws the site's photos onto a canvas
  if (type.startsWith('image/')) res.setHeader('Access-Control-Allow-Origin', '*')
  if (type.startsWith('text/html')) return res.end(inject(fs.readFileSync(file, 'utf8'), extra))
  fs.createReadStream(file).pipe(res)
}

const EXTRA: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, port: number, extra = '') {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` }
  delete headers['accept-encoding']
  delete headers['x-studio-ops']
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (x) => {
    const type = String(x.headers['content-type'] ?? '')
    if (!type.includes('text/html')) {
      const h = { ...x.headers }
      if (type.startsWith('image/')) h['access-control-allow-origin'] = '*'
      res.writeHead(x.statusCode ?? 502, h)
      return x.pipe(res)
    }
    const chunks: Buffer[] = []
    x.on('data', (c) => chunks.push(c))
    x.on('end', () => {
      const body = inject(Buffer.concat(chunks).toString('utf8'), extra)
      const h = { ...x.headers }
      delete h['content-length']
      delete h['content-encoding']
      res.writeHead(x.statusCode ?? 200, h)
      res.end(body)
    })
  })
  up.on('error', () => {
    res.statusCode = 502
    res.end('The site’s dev server isn’t answering')
  })
  req.pipe(up)
}

/** Pass websockets (Astro's live reload) through to the dev server. */
function tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer, port: number) {
  const up = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]
      lines.push(`${k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${port}` : req.rawHeaders[i + 1]}`)
    }
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  const end = () => (up.destroy(), socket.destroy())
  up.on('error', end)
  socket.on('error', end)
}

// --- Pages ----------------------------------------------------------------------------------

const SKIP = new Set(['node_modules', '.git', '.github', '_capture', '_archive', 'build-v2', 'build-wix', 'scripts', 'tools', 'docs', 'src', 'lib', 'concept', 'preview'])

function listPages(dir: string, kind: StudioKind, root: string, p: Project): StudioPage[] {
  const found = new Map<string, StudioPage>()
  const add = (route: string, title?: string) => {
    const r = route.replace(/\/index$/, '/').replace(/\/+/g, '/') || '/'
    // /about and /about/ are the same page: keep the first one found (the local copy's)
    const key = r.length > 1 ? r.replace(/\/$/, '') : r
    if (!found.has(key)) found.set(key, { path: r, title: title ?? null })
  }
  if (kind === 'astro') {
    const pagesDir = path.join(dir, 'src', 'pages')
    walk(pagesDir, (file) => {
      const rel = path.relative(pagesDir, file).split(path.sep).join('/')
      if (!/\.(astro|md|mdx|html)$/.test(rel) || rel.includes('[') || /(^|\/)_/.test(rel) || /^(404|500)\./.test(rel)) return
      add('/' + rel.replace(/\.(astro|md|mdx|html)$/, '').replace(/(^|\/)index$/, '$1'))
    }, new Set(['node_modules']))
  } else {
    walk(root, (file) => {
      if (!/\.html$/.test(file) || /(^|[\\/])404\.html$/.test(file)) return
      const rel = path.relative(root, file).split(path.sep).join('/')
      const html = fs.readFileSync(file, 'utf8').slice(0, 4000)
      // template files and redirect stubs aren't pages you'd edit
      if (/http-equiv=["']?refresh/i.test(html) || /(^|\/)template\.html$/.test(rel)) return
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
      add('/' + rel.replace(/(^|\/)index\.html$/, '$1'), title ? decodeHtml(title) : undefined)
    }, root === dir ? SKIP : new Set(['node_modules']))
  }
  // pages the dashboard found on the live site (e.g. Astro's dynamic routes)
  for (const pg of p.pages) if (pg.path.startsWith('/') && !/[[\]]|^\/(404|500)\/?$/.test(pg.path)) add(pg.path, pg.title ?? undefined)
  return [...found.values()].sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path))).slice(0, 400)
}

function walk(dir: string, fn: (file: string) => void, skip: Set<string>, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || skip.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, fn, skip, depth + 1)
    else fn(full)
  }
}

const decodeHtml = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

/**
 * Whether the site has a robots.txt and a sitemap. Read from the repo rather than
 * the preview, because Astro's sitemap integration only writes one on build.
 */
function siteSeo(dir: string, kind: StudioKind, root: string): StudioSeoSite {
  const has = (...files: string[]) => files.some((f) => fs.existsSync(path.join(f)))
  const where = [...new Set([root, dir, path.join(dir, 'public'), path.join(dir, 'src'), path.join(dir, 'static')])]
  let robots = has(...where.map((d) => path.join(d, 'robots.txt')))
  let sitemap = has(...where.flatMap((d) => ['sitemap.xml', 'sitemap-index.xml', 'sitemap_index.xml'].map((f) => path.join(d, f))))
  // an Astro endpoint (src/pages/robots.txt.ts) or integration, or a build script that writes them
  const pagesDir = path.join(dir, 'src', 'pages')
  if (fs.existsSync(pagesDir)) {
    const names = fs.readdirSync(pagesDir)
    robots ||= names.some((n) => n.startsWith('robots.txt'))
    sitemap ||= names.some((n) => n.startsWith('sitemap'))
  }
  const configs = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'package.json', 'build.mjs', 'src/build.mjs', 'build-v2/build.js']
  for (const c of configs) {
    const f = path.join(dir, c)
    if (!fs.existsSync(f)) continue
    const body = fs.readFileSync(f, 'utf8')
    if (kind === 'astro' || c.includes('build')) {
      sitemap ||= /@astrojs\/sitemap|sitemap(-index)?\.xml/.test(body)
      robots ||= /astro-robots-txt|robots\.txt/.test(body)
    }
  }
  return { robots, sitemap }
}

// --- Lifecycle ------------------------------------------------------------------------------

/** Stop a site's preview and dev server (they start again when it's next opened). */
export function closeSite(id: string) {
  const r = sites.get(id)
  if (!r) return
  r.server?.close()
  r.dev?.kill()
  sites.delete(id)
}

/**
 * Astro dev servers cost memory: stop any not looked at for 20 minutes. The
 * site you used last stays warm for three hours, so coming back to it is instant.
 */
export function reapIdle() {
  const latest = [...sites.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0]
  for (const [id, r] of sites) {
    if (!r.dev || r.busy) continue
    const idle = Date.now() - r.lastUsed
    if (idle > (r === latest ? 3 * 3_600_000 : 20 * 60_000)) closeSite(id)
  }
}

export function touch(id: string) {
  const r = sites.get(id)
  if (r) r.lastUsed = Date.now()
}

export function stopStudio() {
  for (const id of [...sites.keys()]) closeSite(id)
}

// never leave a site's dev server running after Blueprint closes
process.once('exit', stopStudio)

// --- Saving edits into the source ----------------------------------------------------------
//
// Edits made on the canvas arrive as a list of operations (StudioOp). Text, link
// and alt-text changes whose old value appears exactly once in the source are
// written straight in. Everything else (moves, reordering, new or swapped
// photos, text built up from several pieces) goes to Claude Code, run in
// Studio's copy of the repo with file tools only: it can read and edit files
// but not run commands, push or reach the web. Then the site's build runs and
// the canvas reloads from the real source.

/** a match anywhere in the files (attributes too: alt text and meta tags live there), only when there's exactly one */
function findOnce(files: string[], text: string): Hit | null {
  if (text.trim().length < 3) return null
  for (const flags of ['g', 'gi']) {
    const re = textPattern(text, flags)
    const hits: Hit[] = []
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8')
      for (const m of body.matchAll(re)) {
        hits.push({ file, index: m.index!, length: m[0].length, mode: 'html' })
        if (hits.length > 1) break
      }
      if (hits.length > 1) break
    }
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
  }
  return null
}

/** write `text` at a hit, encoded for exactly where it lands (markup, an attribute, a JS string, JSON) */
function writeAt(hit: Hit, text: string, html = false): boolean {
  const body = fs.readFileSync(hit.file, 'utf8')
  const mode = modeAt(hit.file, body, hit.index, hit.length)
  let out: string
  if (html) {
    // bold, italic, links and line breaks go in as markup: only where the source is markup
    if (mode === 'html') out = text
    else if (mode === 'template') out = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    else return false
  } else out = encodeFor(hit.file, text, mode ?? undefined)
  fs.writeFileSync(hit.file, body.slice(0, hit.index) + out + body.slice(hit.index + hit.length))
  return true
}

const rel = (dir: string, f: string) => path.relative(dir, f).split(path.sep).join('/')

/** a site-wide design token (a CSS custom property) set where it's defined, when it's defined in exactly one place */
function themeSwap(dir: string, kind: StudioKind, name: string, before: string, after: string): string | null {
  if (!/^--[\w-]+$/.test(name) || /[;{}<>]/.test(after)) return null
  const files = sourceFiles(dir, kind, { styles: true }).filter((f) => /\.(css|scss|sass|less|astro|html?|vue|svelte)$/i.test(f))
  const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase()
  const re = new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;}{\\n]+)`, 'g')
  const hits: { file: string; index: number; length: number }[] = []
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8')
    for (const m of body.matchAll(re)) {
      const value = m[2].replace(/\s*!important\s*$/, '').trimEnd()
      if (norm(value) === norm(before)) hits.push({ file: f, index: m.index! + m[1].length, length: value.length })
    }
  }
  if (hits.length !== 1) return null
  const h = hits[0]
  const body = fs.readFileSync(h.file, 'utf8')
  fs.writeFileSync(h.file, body.slice(0, h.index) + after.trim() + body.slice(h.index + h.length))
  return rel(dir, h.file)
}

/** Try an edit without Claude. Returns the files it changed, or null when Claude should place it. */
function direct(op: StudioOp, files: string[], dir: string, kind: StudioKind, root: string): string[] | null {
  // an edit to something another edit made (a duplicate, a paste) goes with it, to Claude
  if (op.made) return null
  const swap = (before: string, after: string, html = false) => {
    if (!before.trim() || before === after) return null
    const hit = findOnce(files, before)
    if (!hit || !writeAt(hit, after, html)) return null
    return [rel(dir, hit.file)]
  }
  if (op.kind === 'text' && op.everywhere) {
    const hits = findInText(files, textPattern(op.before, 'g', true))
    if (!hits.length) return null
    if (op.html && hits.some((h) => h.mode !== 'html' && h.mode !== 'template')) return null
    return replaceHits(hits, (h) => (op.html ? (h.mode === 'template' ? op.html!.replace(/`/g, '\\`').replace(/\$\{/g, '\\${') : op.html!) : encodeFor(h.file, op.after, h.mode))).map((f) => rel(dir, f))
  }
  if (op.kind === 'text') return op.html ? swap(op.before, op.html, true) : swap(op.before, op.after)
  if (op.kind === 'alt') return swap(op.before, op.after)
  if (op.kind === 'link' && op.before.length > 1 && !/^#?$/.test(op.before)) return swap(op.before, op.after)
  // a title or description written out in full in one place (a page's own <head>, its data entry)
  if (op.kind === 'meta' && op.field !== 'og:image' && op.before.trim().length >= 12) return swap(op.before, op.after)
  if (op.kind === 'replace') {
    let scope = files
    if (op.scope === 'page') {
      // only a hand-written page's own file is that page alone; templates are shared
      if (kind !== 'static') return null
      const page = path.join(root, op.page.replace(/\/$/, '/index.html').replace(/^\//, ''))
      scope = files.filter((f) => path.resolve(f) === path.resolve(page) || path.resolve(f) === path.resolve(page.replace(/\/index\.html$/, '.html')))
    }
    const hits = findInText(scope, findPattern(op.find, op.matchCase, op.wholeWord))
    if (!hits.length) return null
    return replaceHits(hits, (h) => encodeFor(h.file, op.replace, h.mode)).map((f) => rel(dir, f))
  }
  if (op.kind === 'theme') {
    const f = themeSwap(dir, kind, op.name, op.before, op.after)
    return f ? [f] : null
  }
  return null
}

/** where an Astro photo's original lives, from the address its dev server shows it at */
function astroSourceDir(dir: string, before: string): string | null {
  let u: URL
  try {
    u = new URL(before, 'http://x')
  } catch {
    return null
  }
  let p = u.pathname
  if (p === '/_image') p = decodeURIComponent(u.searchParams.get('href') ?? '')
  p = p.split('?')[0]
  let file: string | null = null
  if (p.startsWith('/@fs/')) file = p.slice(4).replace(/^\/([A-Za-z]:)/, '$1')
  else if (p.startsWith('/src/')) file = path.join(dir, p)
  else if (p.startsWith('/_astro/')) {
    // a built file: name.hash.ext, from somewhere in src/
    const name = path.basename(p).split('.')[0]
    let hit: string | null = null
    walk(path.join(dir, 'src'), (f) => {
      if (!hit && path.basename(f).split('.')[0] === name && /\.(jpe?g|png|webp|avif|gif|svg)$/i.test(f)) hit = f
    }, new Set(['node_modules']))
    file = hit
  }
  if (!file) return null
  const full = path.resolve(file)
  return full.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(full) ? path.dirname(full) : null
}

/** a library photo's served address as its place in the repo */
export function repoPathOf(r: Runtime, src: string): string | null {
  const { root, kind } = detectKind(r.folder)
  let p: string
  try {
    p = decodeURIComponent(new URL(src, 'http://x').pathname)
  } catch {
    return null
  }
  const full = p.startsWith('/@fs/') ? path.resolve(p.slice(4).replace(/^\/([A-Za-z]:)/, '$1')) : path.resolve(kind === 'astro' ? path.join(r.folder, 'public') : root, '.' + p)
  return full.startsWith(path.resolve(r.folder) + path.sep) && fs.existsSync(full) ? rel(r.folder, full) : null
}

type Placeable = { kind: StudioOp['kind']; upload?: string; name?: string; before?: string }

/** Copy a new photo, video or logo into the repo, next to the one it replaces where Studio can tell. Returns its repo path. */
function placeUpload(r: Runtime, op: Placeable): string | null {
  const from = op.upload ? uploadPath(op.upload) : null
  if (!from) return null
  const dir = r.folder
  const { root, kind } = detectKind(dir)
  let target: string | null = null
  if ((op.kind === 'image' || op.kind === 'bg' || op.kind === 'video' || op.kind === 'svg') && op.before) {
    if (kind === 'astro') target = astroSourceDir(dir, op.before)
    if (!target) {
      try {
        const u = new URL(op.before, 'http://x')
        const served = path.resolve(root, '.' + decodeURIComponent(u.pathname))
        const pub = path.resolve(dir, 'public', '.' + decodeURIComponent(u.pathname))
        for (const f of [served, pub]) if (f.startsWith(dir) && fs.existsSync(f)) target = path.dirname(f)
      } catch {
        /* not a URL */
      }
    }
  }
  if (!target) {
    const video = op.kind === 'video'
    // a share image or a video needs a plain public address, so on Astro it goes in public/ rather than through the image pipeline
    const options =
      kind === 'astro' && (op.kind === 'meta' || video || op.kind === 'bg')
        ? video ? ['public/videos', 'public/video', 'public/media', 'public'] : ['public/images', 'public/img', 'public']
        : kind === 'astro'
          ? ['src/assets/photos', 'src/assets/images', 'src/assets', 'public/images', 'public']
          : video ? ['video', 'videos', 'media', 'assets/video', 'img', 'images'] : ['img', 'images', 'assets/img', 'assets/images', 'assets', 'src/img']
    const found = options.map((o) => path.join(dir, o)).find((o) => fs.existsSync(o))
    target = found ?? path.join(dir, kind === 'astro' ? (video ? 'public/videos' : 'public/images') : video ? 'video' : 'images')
  }
  fs.mkdirSync(target, { recursive: true })
  const ext = path.extname(from).toLowerCase() || '.jpg'
  const base = path.basename(op.name || 'photo', path.extname(op.name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo'
  let name = `${base}${ext}`
  for (let n = 2; fs.existsSync(path.join(target, name)); n++) name = `${base}-${n}${ext}`
  if (ext === '.svg') {
    // a logo or icon goes in with anything that could run taken out
    const clean = sanitiseSvg(fs.readFileSync(from, 'utf8'))
    if (!clean) return null
    fs.writeFileSync(path.join(target, name), clean)
  } else fs.copyFileSync(from, path.join(target, name))
  return rel(dir, path.join(target, name))
}

// --- The site's own image script (Kings Hill Dental's build-v2/images.js) -----------------------
//
// Its pages use photos by name (img/hero-general.webp, plus AVIF twins and phone-sized copies for
// page headers), each made from an original in a source folder by a job in images.js. A swapped
// photo goes in as a new original and its job is pointed at it, then Studio runs that one job
// (and the header copies when it's a header photo): the pages already use that name, so nothing
// else has to change. Swapped on one page only, it gets its own job and name, and Claude points
// that page at it.

async function imageTools(r: Runtime) {
  const sharp = path.join(r.folder, '_capture', 'node_modules', 'sharp')
  if (fs.existsSync(sharp)) return true
  if (!fs.existsSync(path.join(r.folder, '_capture', 'package.json'))) return false
  set(r, 'working', 'Installing the site’s image tools (first time only)')
  const lock = fs.existsSync(path.join(r.folder, '_capture', 'package-lock.json'))
  const i = await run('npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund', '--prefix', '_capture'], r.folder, { PUPPETEER_SKIP_DOWNLOAD: '1' })
  return i.ok && fs.existsSync(sharp)
}

/** run one images.js job: the original at `src`, resized and saved as img/<name>.webp exactly as the script would */
async function runImageJob(r: Runtime, src: string, name: string, width: number, quality: number, hero: boolean) {
  const script = `const sharp=require(${JSON.stringify(path.join(r.folder, '_capture', 'node_modules', 'sharp'))});(async()=>{const img=sharp(${JSON.stringify(path.join(r.folder, src))}).rotate();const meta=await img.metadata();await img.resize({width:Math.min(meta.width,${width}),withoutEnlargement:true}).webp({quality:${quality},alphaQuality:92}).toFile(${JSON.stringify(path.join(r.folder, 'img', `${name}.webp`))})})().catch(e=>{console.error(e.message);process.exit(1)})`
  const out = await run(process.execPath, ['-e', script], r.folder, AS_NODE, 120_000)
  if (!out.ok) throw new Error(`The site’s image script couldn’t make the photo. ${lastLine(out.out)}`)
  if (hero) {
    set(r, 'working', 'Making the smaller header copies (about a minute)')
    const h = await run(process.execPath, ['build-v2/images.js', '--heroes', name], r.folder, AS_NODE, 10 * 60_000)
    if (!h.ok) throw new Error(`The site’s image script couldn’t make the header copies. ${lastLine(h.out)}`)
  }
}

/** a photo swap through the image script: done (nothing more needed), or the new name for Claude to point the page at */
async function scriptPipeline(r: Runtime, op: Extract<StudioOp, { kind: 'image' }>): Promise<{ done: boolean; note?: string } | null> {
  const from = op.upload ? uploadPath(op.upload) : null
  if (!from) return null
  const scriptFile = path.join(r.folder, 'build-v2', 'images.js')
  let script = fs.readFileSync(scriptFile, 'utf8')
  let file: string
  try {
    file = path.basename(decodeURIComponent(new URL(op.before, 'http://x').pathname))
  } catch {
    return null
  }
  const stem = file.replace(/\.[a-z0-9]+$/i, '')
  const jobRe = (n: string) => new RegExp(`\\[\\s*'([^']+)'\\s*,\\s*'${n.replace(/[-]/g, '\\-')}'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]`)
  let name = stem
  let job = script.match(jobRe(name))
  if (!job) {
    name = stem.replace(/-\d{3,4}$/, '')
    job = script.match(jobRe(name))
  }
  if (!job || !(await imageTools(r))) return null
  const [line, src, w, q] = job
  const heroes = script.match(/const HEROES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const hero = new RegExp(`'${name}'`).test(heroes)
  // the new original goes beside the old one
  const folder = path.posix.dirname(src)
  const ext = path.extname(from).toLowerCase() || '.jpg'
  const base = (op.name || 'photo').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'photo'
  let newSrc = `${folder}/${base}${ext}`
  for (let n = 2; fs.existsSync(path.join(r.folder, newSrc)); n++) newSrc = `${folder}/${base} ${n}${ext}`
  fs.mkdirSync(path.join(r.folder, folder), { recursive: true })
  fs.copyFileSync(from, path.join(r.folder, newSrc))
  set(r, 'working', 'Making the photo web-ready with the site’s image script')
  if (op.everywhere) {
    script = script.replace(line, line.replace(`'${src}'`, `'${newSrc.replace(/'/g, "\\'")}'`))
    fs.writeFileSync(scriptFile, script)
    await runImageJob(r, newSrc, name, Number(w), Number(q), hero)
    return { done: true }
  }
  // this page only: its own job and name
  let newName = `${name}-${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'new'}`
  for (let n = 2; script.includes(`'${newName}'`); n++) newName = `${name}-${n}`
  script = script.replace(line, `${line},\n  ['${newSrc.replace(/'/g, "\\'")}', '${newName}', ${w}, ${q}], // added in Studio for ${op.page}`)
  if (hero) script = script.replace(/const HEROES\s*=\s*\[/, (m) => `${m}'${newName}', `)
  fs.writeFileSync(scriptFile, script)
  await runImageJob(r, newSrc, newName, Number(w), Number(q), hero)
  return { done: false, note: `The site's image script has already made the new photo as img/${newName}.webp${hero ? ' (with its AVIF twin and smaller copies, like the other page headers)' : ''}, from a new job in build-v2/images.js. On the page ${op.page}, point ${op.label} at it in place of ${name} (the way the page's other photos are referenced), on this page only.` }
}

const KIND_NOTE: Record<StudioKind, string> = {
  static: 'It is a hand-written static site: edit its HTML, CSS and JS (or the data files its JS reads) directly.',
  generated: 'Its pages are generated by a Node build script from templates and data: edit those sources, never the generated HTML (Studio runs the build after you finish).',
  astro: 'It is an Astro site: edit src/ (pages, components, content collections, data files, styles). Astro’s dev server shows changes live.',
  shopify: 'It is a Shopify theme.',
  app: '',
  unknown: '',
}

const BUTTON_HINT = 'Use the site’s own classes and design tokens, and put CSS in the site’s stylesheets (not inline styles).'

function instruction(op: StudioOp, placed: Map<string, string>, nums: Map<string, number>): string {
  const on = `On the page ${op.page}`
  const madeBy = op.made && nums.get(op.made) ? ` (it's the new copy made by edit ${nums.get(op.made)}, so make this change on that copy)` : ''
  const el = `the ${op.label} (CSS path \`${op.selector}\`${op.text ? `, text “${op.text.slice(0, 120)}”` : ''})${madeBy}`
  switch (op.kind) {
    case 'text':
      if (op.everywhere) return `Everywhere on the site (every page, template and data file), the words “${op.before}” appear as visible text. Change every copy to read ${op.html ? `as this markup: \`${op.html}\`` : `“${op.after}”`}. Don't change code, class names, file names or addresses that happen to contain the words.`
      if (op.html) return `${on}, ${el} reads “${op.before}”. Change it to this, keeping the bold, italic, links and line breaks exactly as given, written in the site's own markup (or its data's rich-text format): \`${op.html}\``
      return `${on}, ${el} reads “${op.before}”. Change it to read “${op.after}”.`
    case 'alt':
      return `${on}, set the alt text of the image in ${el} to “${op.after}”.`
    case 'link':
      return `${on}, ${el} links to \`${op.before || '(nothing)'}\`. Make it link to \`${op.after}\`.`
    case 'image': {
      const where = op.everywhere ? 'everywhere this photo is used on the site' : 'on this page only (other pages using the same photo keep it)'
      if (op.src) return `${on}, replace the photo in ${el} (currently ${op.before}) with the site's existing photo at \`${op.src}\`, ${where}. Keep its alt text, size and crop styling, and use the site's usual way of referencing photos (its image pipeline or <picture> pattern).`
      return placed.get(op.id)
        ? `${on}, replace the photo in ${el} (currently ${op.before}) with the new photo Studio saved at \`${placed.get(op.id)}\`, ${where}. Keep its alt text, size and crop styling. If the site serves photos through <picture>/srcset or an image pipeline (Astro's <Image>, an image script), use that pipeline for the new photo the same way as the old one.`
        : `${on}, the photo in ${el} was swapped, but the new file couldn't be copied in. Skip this one and say so.`
    }
    case 'add-image':
      if (op.src) return `${on}, add the site's existing photo at \`${op.src}\` directly after ${el}, with alt text “${op.alt}”. Style it to sit naturally in that spot: the column's width, and the same corner radius and spacing as the site's other photos.`
      return placed.get(op.id)
        ? `${on}, add the new photo Studio saved at \`${placed.get(op.id)}\` directly after ${el}, with alt text “${op.alt}”. Style it to sit naturally in that spot: the column's width, and the same corner radius and spacing as the site's other photos.`
        : `${on}, a photo was added after ${el}, but the file couldn't be copied in. Skip this one and say so.`
    case 'move': {
      const dir = [op.dx ? `${Math.abs(op.dx)}px ${op.dx > 0 ? 'right' : 'left'}` : '', op.dy ? `${Math.abs(op.dy)}px ${op.dy > 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(' and ')
      return `${on}, viewed ${op.width}px wide, ${el} was dragged ${dir || 'back to where it was'} from where the layout puts it${op.snapped.length ? `, so that ${op.snapped.join(' and ')}` : ''}. Change the CSS so it sits there at that screen width. Use the site's own layout tools (margin, padding, gap, alignment, flex or grid placement) rather than transforms or absolute positioning, and scope the change to the site's existing breakpoint that contains ${op.width}px, so other screen sizes keep their layout unless the same move clearly belongs there too.`
    }
    case 'order':
      return `${on}, move ${el} so it comes ${op.direction === 'earlier' ? 'before' : 'after'} ${op.sibling} (its neighbour). If the items come from a data list, reorder the list.`
    case 'duplicate':
      return `${on}, duplicate ${el} so an identical copy sits straight after it. If it comes from a data list, add a copy of its entry.`
    case 'hide':
      return op.scope === 'everywhere'
        ? `${on}, remove ${el} from the page (or its data entry).`
        : `${on}, hide ${el} at screen widths like ${op.width}px (use the site's breakpoint that contains ${op.width}px) and keep it at other sizes.`
    case 'meta':
      return metaInstruction(op, placed)
    case 'style': {
      const set = Object.entries(op.props)
        .map(([k, v]) => `${k}: ${v}${op.before[k] ? ` (now ${op.before[k]})` : ''}`)
        .join('; ')
      const range = op.media ? `only at screen widths ${mediaLabel(op.media)} (\`${mediaQuery(op.media)}\`: use the site's own breakpoint for that range)` : 'at every screen size'
      return `${on}, change the look of ${el}: ${set}, ${range}. In plain words: ${Object.keys(op.props).map(propName).join(', ')}. ${BUTTON_HINT} Where a value is a token like var(--x), keep the token. If other elements share its class and shouldn't change, add a modifier class for this one.`
    }
    case 'attr':
      if (op.name === 'class') return `${on}, restyle ${el} using the site's own button style: change its classes from “${op.before ?? ''}” to “${op.after ?? ''}”. If the markup comes from a component or helper, use its option for that style.`
      if (op.name === 'target') return op.after === '_blank' ? `${on}, make the link in ${el} open in a new tab (target="_blank" rel="noopener").` : `${on}, make the link in ${el} open in the same tab (remove target="_blank").`
      if (op.name === 'required') return `${on}, make the form field in ${el} ${op.after === null ? 'optional (not required)' : 'required'}.${op.after === null ? '' : ' Mark it the way the site marks its other required fields.'}`
      if (op.name === 'placeholder') return `${on}, set the placeholder of the form field in ${el} to “${op.after ?? ''}”.`
      if (/^data-(reveal|split|aos|animate|anim|animation|sal|scroll|motion)$/.test(op.name))
        return op.after === null ? `${on}, turn off the entrance animation of ${el} (remove its ${op.name} attribute, or the site's equivalent).` : `${on}, give ${el} the site's entrance animation ${op.name}="${op.after}" (the same way other elements use it).`
      if (op.name === 'src') return `${on}, change the address of the embed in ${el} from \`${op.before ?? ''}\` to \`${op.after ?? ''}\`.`
      return op.after === null ? `${on}, remove the ${op.name} attribute from ${el}.` : `${on}, set the ${op.name} attribute of ${el} to “${op.after}”.`
    case 'paste':
      return `${on}, add a copy of the ${op.from.label} from the page ${op.from.page} (CSS path \`${op.from.selector}\`${op.from.text ? `, text “${op.from.text.slice(0, 100)}”` : ''}) directly after ${el}. Reuse the same component, partial or data entry the original is built from rather than pasting raw HTML, and make sure its styles also apply on this page. As it appeared on the page:\n\`\`\`html\n${op.html.slice(0, 6000)}\n\`\`\``
    case 'table': {
      const what = { 'add-row': `add a new blank row straight after row ${op.row + 1}`, 'remove-row': `remove row ${op.row + 1}`, 'add-col': `add a new blank column straight after column ${op.col + 1}`, 'remove-col': `remove column ${op.col + 1}` }[op.action]
      return `${on}, in the table at ${el}, ${what} (counting the header row as row 1). If the table is built from a data file, change the data.`
    }
    case 'bg':
      if (op.src) return `${on}, change the background photo of ${el} (now ${op.before}) to the site's existing photo at \`${op.src}\`. Keep its sizing and position.`
      return placed.get(op.id) ? `${on}, change the background photo of ${el} (now ${op.before}) to the new photo Studio saved at \`${placed.get(op.id)}\`. Keep its sizing and position, and set it where the current one is set.` : `${on}, a background photo was swapped but the file couldn't be copied in. Skip this one and say so.`
    case 'video':
      return placed.get(op.id) ? `${on}, replace the video in ${el} (now ${op.before}) with the new video Studio saved at \`${placed.get(op.id)}\`. Keep its attributes (autoplay, muted, loop, playsinline, poster, controls).` : `${on}, a video was swapped but the file couldn't be copied in. Skip this one and say so.`
    case 'embed':
      return `${on}, add an embedded ${op.provider === 'maps' ? 'Google map' : op.provider === 'other' ? 'frame' : `${op.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video`} directly after ${el}: an <iframe src="${op.src}" title="${op.title}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"> in a responsive wrapper (${op.provider === 'maps' ? '4:3' : '16:9'}), with the site's usual corner radius and spacing. Use exactly that address (it's the privacy-friendly version). Pasted link: ${op.url}`
    case 'svg': {
      const file = placed.get(op.id)
      if (!file) return `${on}, a logo or icon was swapped but the file couldn't be copied in. Skip this one and say so.`
      return op.inline
        ? `${on}, replace the inline SVG in ${el} with the SVG in \`${file}\` (put its markup inline in place of the old one). Keep the old SVG's class, width, height and aria attributes so it stays the same size${op.recolour ? ', and make its fills and strokes use currentColor so it takes the same colour as before' : ', and keep the new logo’s own colours'}.`
        : `${on}, point the logo image in ${el} (now ${op.before}) at the new SVG Studio saved at \`${file}\`, keeping its size.`
    }
    case 'replace':
      return `${op.scope === 'site' ? 'Across the whole site (every page, template and data file)' : on}, replace the visible words “${op.find}” with “${op.replace}”${op.matchCase ? ' (matching capitals exactly)' : ' (any capitals)'}${op.wholeWord ? ', whole words only' : ''}. Only words a visitor reads: not code, class names, file names or addresses.`
    case 'theme':
      return `Change the site-wide design token \`${op.name}\` from \`${op.before}\` to \`${op.after}\` where it's defined (usually :root in the main stylesheet), so it changes everywhere it's used.`
    case 'ask':
      return `${on}, about ${el}: ${op.prompt}`
  }
}
const META_TAG: Record<StudioMetaField, string> = {
  title: 'the <title> (what Google shows as the headline)',
  description: 'the <meta name="description"> (the text under the headline on Google)',
  'og:title': 'the og:title and twitter:title tags (the headline when the page is shared)',
  'og:description': 'the og:description and twitter:description tags (the text when the page is shared)',
  'og:image': 'the og:image and twitter:image tags (the picture when the page is shared)',
}

function metaInstruction(op: Extract<StudioOp, { kind: 'meta' }>, placed: Map<string, string>): string {
  const on = `On the page ${op.page}`
  const how = 'Set it where the site sets it for this page (its own <head>, front matter, page data or the props it passes to a shared layout), not in the shared template for every page, and add the tag if the page has none. Keep the site’s pattern, e.g. if titles end in “| Business name”.'
  if (op.field === 'og:image') {
    const file = placed.get(op.id)
    return file
      ? `${on}, set ${META_TAG['og:image']} to the new image Studio saved at \`${file}\`, as an absolute URL on the live site's address (where the site's other share tags use one), with twitter:card summary_large_image. ${how}`
      : `${on}, a new share image was chosen, but the file couldn't be copied in. Skip this one and say so.`
  }
  return `${on}, set ${META_TAG[op.field]} to “${op.after}”${op.before ? ` (it is now “${op.before}”)` : ''}. ${how}`
}

function editPrompt(p: Project, kind: StudioKind, ops: StudioOp[], placed: Map<string, string>, notes: Map<string, string>) {
  const nums = new Map(ops.map((op, i) => [op.id, i + 1]))
  return [
    `You're working in a copy of the ${p.name} website repo (${p.repo}) for Studio, the visual editor in Dylan's Blueprint app. Dylan made these edits on Studio's preview of the site. Make each one in the site's real source so the site itself produces it.`,
    KIND_NOTE[kind],
    'Read CLAUDE.md and the README first if they exist, and follow their conventions. Keep each change as small as possible and scoped to that element and page. You can read and edit files but not run commands, so don’t build, test, commit or push: Studio does that. Don’t touch unrelated files.',
    '',
    'The edits, in the order they were made:',
    ...ops.map((op, i) => `${i + 1}. ${notes.get(op.id) ?? instruction(op, placed, nums)}`),
    '',
    'Finish with one short line per edit, numbered the same, starting "done:" or "skipped:" with the reason.',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
}

/** Claude Code with file tools only, in Studio's copy of the repo. */
function runClaudeIn(exe: string, dir: string, prompt: string, onLine?: (s: string) => void): Promise<{ ok: boolean; text: string }> {
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,MultiEdit,Write,Glob,Grep,TodoWrite', '--disallowedTools', 'Bash,WebFetch,WebSearch,NotebookEdit,Task', '--no-session-persistence']
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = /\.(cmd|bat)$/i.test(exe) ? spawn([exe, ...args].map(quoteForCmd).join(' '), { cwd: dir, shell: true, windowsHide: true }) : spawn(exe, args, { cwd: dir, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, text: (e as Error).message })
    }
    let out = ''
    let err = ''
    const limit = setTimeout(() => child.kill(), 15 * 60_000)
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8')
      onLine?.(out.trim().split('\n').pop() ?? '')
    })
    child.stderr?.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)))
    child.on('error', (e) => {
      clearTimeout(limit)
      resolve({ ok: false, text: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(limit)
      if (code === 0) return resolve({ ok: true, text: out.trim() })
      const signIn = /log ?in|authenticat|not logged/i.test(err + out)
      resolve({ ok: false, text: signIn ? 'Claude Code needs you to sign in once: open a terminal, run claude, and follow the steps.' : lastLine(err || out) || `Claude Code stopped (exit ${code}).` })
    })
    child.stdin?.end(prompt)
  })
}

async function gitChanged(dir: string): Promise<string[]> {
  const s = await run('git', ['status', '--porcelain', '--untracked-files=all'], dir)
  return s.out
    .split('\n')
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/** Run one job on a site (saving, Claude, publishing), with the site marked busy meanwhile. */
export function job(p: Project, message: string, fn: (r: Runtime) => Promise<StudioResult>): StudioSite | { error: string } {
  const r = sites.get(p.id)
  if (!r || r.site.status !== 'ready') return { error: r?.busy ? 'Studio is still busy with this site' : 'Open the site in Studio first' }
  r.lastUsed = Date.now()
  set(r, 'working', message)
  r.busy = fn(r)
    .then((res) => {
      r.site.last = res
    })
    .catch((e) => {
      r.site.last = { kind: 'save', ok: false, text: (e as Error).message, at: new Date().toISOString() }
      log('studio', p.repo, (e as Error).message)
    })
    .finally(async () => {
      r.busy = undefined
      await readHead(r).catch(() => {})
      if (r.site.status === 'working') set(r, 'ready', '')
    })
  return r.site
}

export async function rebuild(r: Runtime) {
  const { build } = detectKind(r.folder)
  if (build) {
    set(r, 'working', 'Building the pages')
    const b = await run(process.execPath, build, r.folder, AS_NODE)
    if (!b.ok) throw new Error(`The site’s build script failed after the edits. ${lastLine(b.out)}`)
    await readHead(r)
    writeStamp(r)
  }
}

/** note what changed (and on which pages), for the change list, the checks before going live and the commit */
export async function record(r: Runtime, notes: string[], pages: string[] = []) {
  const e = studioEdits(r.folder)
  const files = await gitChanged(r.folder)
  saveEdits(r.folder, { files, notes: files.length ? [...e.notes, ...notes] : [], pages: files.length ? [...new Set([...e.pages, ...pages])] : [] })
  await readHead(r)
  writeStamp(r)
}

export const setStatus = set

/** Save canvas edits into the site's source. */
export function saveOps(p: Project, ops: StudioOp[], exe: string | null) {
  return job(p, `Saving ${ops.length} edit${ops.length === 1 ? '' : 's'} into the source`, async (r) => {
    const { kind, root } = detectKind(r.folder)
    const files = sourceFiles(r.folder, kind)
    const done: string[] = []
    const rest: StudioOp[] = []
    const notes = new Map<string, string>()
    const failed = new Map<string, string>()
    for (const op of ops) {
      // an edit to something an edit still waiting for Claude made goes with it
      if (op.made && !ops.some((o) => o.id === op.made)) {
        failed.set(op.id, 'It was made on something that’s no longer there')
        continue
      }
      let changed: string[] | null = null
      try {
        changed = direct(op, files, r.folder, kind, root)
      } catch (e) {
        log('studio direct', (e as Error).message)
      }
      if (changed) done.push(op.id)
      else rest.push(op)
    }
    // swapped photos through the site's own image script
    if (r.site.pipeline === 'script') {
      for (const op of [...rest]) {
        if (op.kind !== 'image' || !op.upload || op.made) continue
        try {
          const out = await scriptPipeline(r, op)
          if (!out) continue
          if (out.done) {
            rest.splice(rest.indexOf(op), 1)
            done.push(op.id)
          } else if (out.note) notes.set(op.id, out.note)
        } catch (e) {
          failed.set(op.id, (e as Error).message)
          rest.splice(rest.indexOf(op), 1)
        }
      }
    }
    const placed = new Map<string, string>()
    for (const op of rest) {
      if (notes.has(op.id)) continue
      if (op.kind === 'image' || op.kind === 'add-image' || op.kind === 'bg' || op.kind === 'video' || op.kind === 'svg' || (op.kind === 'meta' && op.upload)) {
        const at = placeUpload(r, op as Placeable)
        if (at) placed.set(op.id, at)
      }
    }
    let claudeText = ''
    if (rest.length) {
      if (!exe) {
        for (const op of rest) failed.set(op.id, 'Claude Code isn’t set up on this computer')
      } else {
        set(r, 'working', `Claude is placing ${rest.length} edit${rest.length === 1 ? '' : 's'} in the source`)
        const c = await runClaudeIn(exe, r.folder, editPrompt(p, kind, rest, placed, notes), (l) => l && set(r, 'working', `Claude: ${l.slice(0, 140)}`))
        claudeText = c.text
        if (!c.ok) for (const op of rest) failed.set(op.id, c.text)
        // Claude reports skipped edits on their own numbered lines
        else
          for (const m of c.text.matchAll(/^\s*(\d+)\.\s*skipped:?\s*(.*)$/gim)) {
            const op = rest[Number(m[1]) - 1]
            if (op) failed.set(op.id, m[2].trim())
          }
      }
    }
    await rebuild(r)
    const ok = ops.filter((o) => !failed.has(o.id))
    await record(r, ok.map(opNote), [...new Set(ok.map((o) => o.page))])
    const text = [
      `${ok.length} of ${ops.length} edit${ops.length === 1 ? '' : 's'} saved into the source.${done.length ? ` ${done.length} written in directly.` : ''}`,
      rest.length && claudeText ? `Claude: ${claudeText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    return { kind: 'save', ok: failed.size === 0, text, at: new Date().toISOString(), failed: ops.filter((o) => failed.has(o.id)).map((o) => `${opNote(o)}: ${failed.get(o.id)}`) }
  })
}

/** A change asked for in words, made by Claude in the site's source. */
export function askClaude(p: Project, prompt: string, ctx: { page: string; element: StudioElement | null; width: number }, exe: string | null) {
  if (!exe) return { error: 'Claude Code isn’t installed on this computer. Set it up for the Claude bar first.' }
  return job(p, 'Claude is working on it', async (r) => {
    const { kind } = detectKind(r.folder)
    const el = ctx.element
    const full = [
      `You're working in a copy of the ${p.name} website repo (${p.repo}) for Studio, the visual editor in Dylan's Blueprint app. Dylan is looking at the page ${ctx.page} at ${ctx.width}px wide${el ? `, with this element selected: the ${el.label} (CSS path \`${el.selector}\`${el.text ? `, text “${el.text.slice(0, 200)}”` : ''}${el.image ? `, image ${el.image.src}` : ''})` : ''}.`,
      KIND_NOTE[kind],
      'Read CLAUDE.md and the README first if they exist, and follow their conventions. You can read and edit files but not run commands, so don’t build, test, commit or push: Studio does that. Keep the change focused on what he asks.',
      '',
      `Dylan asks: ${prompt}`,
      '',
      'Finish with one or two plain sentences saying what you changed, for Studio’s change list.',
    ].join('\n')
    const c = await runClaudeIn(exe, r.folder, full, (l) => l && set(r, 'working', `Claude: ${l.slice(0, 140)}`))
    if (!c.ok) return { kind: 'claude', ok: false, text: c.text, at: new Date().toISOString() }
    await rebuild(r)
    const summary = c.text.trim().split('\n').filter(Boolean).pop() ?? prompt
    await record(r, [`Claude: ${prompt.replace(/\s+/g, ' ').slice(0, 90)}`], [ctx.page])
    return { kind: 'claude', ok: true, text: c.text || summary, at: new Date().toISOString() }
  })
}

/** Put everything back to the last commit from GitHub. */
export function discard(p: Project) {
  return job(p, 'Discarding the unpublished changes', async (r) => {
    await run('git', ['reset', '--hard', 'HEAD'], r.folder)
    await run('git', ['clean', '-fdq'], r.folder)
    saveEdits(r.folder, null)
    await rebuild(r)
    await run('git', ['checkout', '--', '.'], r.folder)
    return { kind: 'discard', ok: true, text: 'Discarded. Studio is back on the latest commit from GitHub.', at: new Date().toISOString() }
  })
}

/** The code changes waiting to be published, as a diff. */
export async function diffOf(p: Project): Promise<string> {
  const r = sites.get(p.id)
  if (!r) return ''
  await run('git', ['add', '-A', '--intent-to-add'], r.folder)
  // a generated site's pages are build output: the review shows the source edits that made them
  const skip = detectKind(r.folder).kind === 'generated' ? [':(exclude)*.html'] : []
  const d = await run('git', ['diff', '--no-color', '--', '.', ':(exclude)*.min.*', ...skip], r.folder, undefined, 60_000, 3_000_000)
  await run('git', ['reset', '-q'], r.folder)
  return d.out.length > 400_000 ? d.out.slice(0, 400_000) + '\n… (cut short)' : d.out
}

/** Commit the saved edits and push them: to the live branch, or to a new draft branch for a pull request. */
export function publish(p: Project, token: string | null, opts: { draft: boolean; login: string | null; exe: string | null }) {
  return job(p, opts.draft ? 'Saving a draft branch to GitHub' : 'Pushing live to GitHub', async (r) => {
    const dir = r.folder
    const e = studioEdits(dir)
    if (!e.files.length) return { kind: 'publish', ok: false, text: 'Nothing to publish yet: save some edits first.', at: new Date().toISOString() }
    // a descriptive commit title, written by Claude's quickest model when there's more than one edit
    let title = commitTitle(p.name, e.notes)
    if (e.notes.length > 1 && opts.exe) {
      set(r, 'working', 'Writing the commit message')
      const t = await ask(opts.exe, `Write a git commit title (imperative, sentence case, at most 72 characters, no full stop, no quotes) for these edits to the ${p.name} website:\n${e.notes.map((n) => `- ${n}`).join('\n')}\nAnswer with the title only.`)
      const line = t?.split('\n')[0].replace(/^["'`*\s]+|["'`*.\s]+$/g, '').trim()
      if (line && line.length <= 80) title = line
      set(r, 'working', opts.draft ? 'Saving a draft branch to GitHub' : 'Pushing live to GitHub')
    }
    const body = e.notes.length > 1 ? e.notes.map((n) => `- ${n}`).join('\n') : ''
    const who = (await run('git', ['config', 'user.email'], dir)).out.trim()
    const env: NodeJS.ProcessEnv = who
      ? {}
      : { GIT_AUTHOR_NAME: opts.login ?? 'Blueprint Studio', GIT_AUTHOR_EMAIL: `${opts.login ?? 'studio'}@users.noreply.github.com`, GIT_COMMITTER_NAME: opts.login ?? 'Blueprint Studio', GIT_COMMITTER_EMAIL: `${opts.login ?? 'studio'}@users.noreply.github.com` }
    await run('git', ['add', '-A'], dir)
    const c = await run('git', ['commit', '-q', '-m', title, ...(body ? ['-m', `${body}\n\nMade in Blueprint Studio.`] : ['-m', 'Made in Blueprint Studio.'])], dir, env)
    if (!c.ok) throw new Error(`Couldn’t commit. ${lastLine(c.out)}`)
    const sha = (await run('git', ['rev-parse', 'HEAD'], dir)).out.trim()
    const branch = r.site.branch
    if (opts.draft) {
      const name = `studio/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`
      const push = await git(['push', 'origin', `HEAD:refs/heads/${name}`], dir, token)
      if (!push.ok) {
        await run('git', ['reset', '--soft', 'HEAD~1'], dir)
        throw new Error(`GitHub refused the draft branch. ${lastLine(push.out)}`)
      }
      // the draft lives on GitHub now; Studio's copy goes back to the live branch
      await run('git', ['reset', '--hard', 'HEAD~1'], dir)
      await run('git', ['clean', '-fdq'], dir)
      saveEdits(dir, null)
      await rebuild(r)
      return { kind: 'publish', ok: true, text: `Saved as the draft branch ${name}. Open a pull request to review it before it goes live.`, at: new Date().toISOString(), url: `https://github.com/${p.repo}/compare/${branch}...${name}?expand=1` }
    }
    let push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir, token)
    if (!push.ok && /rejected|fetch first|non-fast-forward/i.test(push.out)) {
      // someone pushed meanwhile: put these edits on top of theirs
      set(r, 'working', 'GitHub has newer commits: putting your edits on top')
      await git(['fetch', '--deepen=200', 'origin', branch], dir, token)
      const rb = await run('git', ['rebase', 'FETCH_HEAD'], dir, env)
      if (!rb.ok) {
        await run('git', ['rebase', '--abort'], dir)
        await run('git', ['reset', '--soft', 'HEAD~1'], dir)
        throw new Error('GitHub has newer changes that clash with these edits. Save them as a draft instead, or discard and redo them on the latest version.')
      }
      push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir, token)
    }
    if (!push.ok) {
      await run('git', ['reset', '--soft', 'HEAD~1'], dir)
      throw new Error(`GitHub refused the push. ${lastLine(push.out)} If your token is read-only, create a read-and-write one in Settings.`)
    }
    const live = (await run('git', ['rev-parse', 'HEAD'], dir)).out.trim() || sha
    saveEdits(dir, null)
    return { kind: 'publish', ok: true, text: `Pushed live to ${branch}: “${title}”. The site’s own deploy takes it from here.`, at: new Date().toISOString(), url: `https://github.com/${p.repo}/commit/${live}` }
  })
}
