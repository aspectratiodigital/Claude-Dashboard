import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Project, StudioElement, StudioKind, StudioOp, StudioPage, StudioResult, StudioSite } from '../src/data/types.ts'
import { commitTitle, opNote } from '../src/data/studio.ts'
import { ask, quoteForCmd } from './assistant.ts'
import { DATA_DIR, log } from './util.ts'
import { typeOf, uploadPath } from './files.ts'
import { OVERLAY_JS } from './studio-overlay.ts'

// Studio: the visual site builder. Each website gets its own clean clone under
// .jarvis/studio/<repo> (never your working folder, so Studio can't trip over
// half-done work), synced to the latest commit on its default branch. A small
// preview server per site serves it on 127.0.0.1 with Studio's overlay script
// injected into every HTML page, so the canvas can select elements. Astro
// sites run their own dev server behind that preview server.

export const STUDIO_DIR = path.join(DATA_DIR, 'studio')

interface Runtime {
  site: StudioSite
  folder: string
  server?: http.Server
  dev?: ChildProcess
  devPort?: number
  busy?: Promise<void>
  lastUsed: number
}

const sites = new Map<string, Runtime>()

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
function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeout = 10 * 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32' && /^(npm|npx)$/.test(cmd)
    const child = spawn(win ? `${cmd}.cmd` : cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: win })
    let out = ''
    const add = (b: Buffer) => {
      out = (out + b.toString()).slice(-20_000)
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
function git(args: string[], cwd: string, token: string | null) {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return run('git', args, cwd, env, 5 * 60_000)
}

function folderOf(p: Project) {
  return path.join(STUDIO_DIR, p.repo.split('/').pop()!.replace(/[^\w.-]/g, '_'))
}

function blank(p: Project): StudioSite {
  return { projectId: p.id, repo: p.repo, branch: p.defaultBranch, kind: 'unknown', status: 'idle', message: '', port: null, sha: null, commit: null, committed: null, changed: [], notes: [], pages: [], last: null }
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

  if (build) {
    set(r, 'building', 'Building the pages')
    const b = await run(process.execPath, build, dir, AS_NODE)
    if (!b.ok) throw new Error(`The site’s build script failed. ${lastLine(b.out)}`)
  }
  if (kind === 'astro') await startAstro(r)
  await startPreview(r, root)
  r.site.pages = listPages(dir, kind, root, p)
  set(r, 'ready', '')
}

async function readHead(r: Runtime) {
  const h = await git(['log', '-1', '--format=%H%n%cI%n%s'], r.folder, null)
  const [sha, when, ...subject] = h.out.trim().split('\n')
  r.site.sha = sha || null
  r.site.committed = when || null
  r.site.commit = subject.join(' ') || null
  const e = studioEdits(r.folder)
  r.site.changed = e.files
  r.site.notes = e.notes
}

/**
 * Files you've changed in Studio and not yet published, and what the changes
 * are, as Studio records them in .git/studio-edits.json. (Not `git status`: a
 * site's own build script rewrites its pages, and that isn't an edit worth
 * keeping over the latest from GitHub.)
 */
interface Edits {
  files: string[]
  notes: string[]
}
const EDITS = (dir: string) => path.join(dir, '.git', 'studio-edits.json')

function studioEdits(dir: string): Edits {
  try {
    const e = JSON.parse(fs.readFileSync(EDITS(dir), 'utf8'))
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return { files: strs(e.files), notes: strs(e.notes) }
  } catch {
    return { files: [], notes: [] }
  }
}

function saveEdits(dir: string, e: Edits | null) {
  if (!e || (!e.files.length && !e.notes.length)) fs.rmSync(EDITS(dir), { force: true })
  else fs.writeFileSync(EDITS(dir), JSON.stringify(e, null, 2))
}

const lastLine = (s: string) =>
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

function inject(html: string) {
  if (html.includes('data-studio')) return html
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${INJECT}</body>`) : html + INJECT
}

/** Only answer to 127.0.0.1/localhost (guards against DNS rebinding). */
function localHost(req: http.IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return ['localhost', '127.0.0.1', '[::1]'].includes(host)
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
    const up = url.pathname.match(/^\/__studio\/upload\/([a-z0-9]{6,24})$/)
    if (up) {
      // a photo you've just swapped in, before it's saved into the site
      const file = uploadPath(up[1])
      if (!file || !/\.(jpe?g|png|webp|avif|gif|svg)$/i.test(file)) return notFound(root, res)
      res.setHeader('Cache-Control', 'no-store')
      if (/\.svg$/i.test(file)) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      return send(file, res, 200)
    }
    if (r.devPort && r.dev) return proxy(req, res, r.devPort)
    serveStatic(root, url.pathname, res)
  })
  if (r.devPort) server.on('upgrade', (req, socket, head) => tunnel(req, socket as net.Socket, head, r.devPort!))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  r.server = server
  r.site.port = (server.address() as net.AddressInfo).port
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse) {
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
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(file, res, 200)
  }
  notFound(root, res)
}

function notFound(root: string, res: http.ServerResponse) {
  const page = path.join(root, '404.html')
  if (fs.existsSync(page)) return send(page, res, 404)
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(inject('<!doctype html><title>Not found</title><p style="font:16px system-ui;padding:2rem">This page isn’t in the site.</p>'))
}

function send(file: string, res: http.ServerResponse, code: number) {
  const type = /\.html?$/i.test(file) ? 'text/html; charset=utf-8' : (EXTRA[path.extname(file).toLowerCase()] ?? typeOf(file))
  res.statusCode = code
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  if (type.startsWith('text/html')) return res.end(inject(fs.readFileSync(file, 'utf8')))
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

function proxy(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` }
  delete headers['accept-encoding']
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (x) => {
    const type = String(x.headers['content-type'] ?? '')
    if (!type.includes('text/html')) {
      res.writeHead(x.statusCode ?? 502, x.headers)
      return x.pipe(res)
    }
    const chunks: Buffer[] = []
    x.on('data', (c) => chunks.push(c))
    x.on('end', () => {
      const body = inject(Buffer.concat(chunks).toString('utf8'))
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

// --- Lifecycle ------------------------------------------------------------------------------

/** Stop a site's preview and dev server (they start again when it's next opened). */
export function closeSite(id: string) {
  const r = sites.get(id)
  if (!r) return
  r.server?.close()
  r.dev?.kill()
  sites.delete(id)
}

/** Astro dev servers cost memory: stop any not looked at for 20 minutes. */
export function reapIdle() {
  for (const [id, r] of sites) if (r.dev && !r.busy && Date.now() - r.lastUsed > 20 * 60_000) closeSite(id)
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

const SOURCE_EXT = /\.(html?|json|m?js|cjs|ts|tsx|jsx|astro|mdx?|ya?ml|njk|liquid|svelte|vue|txt)$/i
const SOURCE_SKIP = new Set(['node_modules', '.git', '.astro', 'dist', 'release', '.github', '.vscode', '.claude'])

function sourceFiles(dir: string, kind: StudioKind): string[] {
  const out: string[] = []
  const walkSrc = (d: string, depth: number) => {
    if (depth > 8) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SOURCE_SKIP.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walkSrc(full, depth + 1)
      else if (SOURCE_EXT.test(e.name) && !/\.min\.|package-lock|CLAUDE\.md|README/i.test(e.name)) {
        const rel = path.relative(dir, full).split(path.sep).join('/')
        // a generated site's HTML is build output: its build would overwrite an edit there
        if (kind === 'generated' && /\.html?$/i.test(e.name) && !rel.startsWith('src/')) continue
        try {
          if (fs.statSync(full).size < 1_500_000) out.push(full)
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  walkSrc(dir, 0)
  return out
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** a pattern for text as the browser shows it, matching how it's likely written in source */
function textPattern(text: string, flags = 'g') {
  const CHAR: Record<string, string> = {
    '&': '(?:&|&amp;)',
    "'": `(?:'|’|&#39;|&#039;|&rsquo;|&apos;|\\\\')`,
    '’': `(?:’|'|&#39;|&#8217;|&rsquo;|\\\\')`,
    '"': '(?:"|\\\\"|&quot;|“|”)',
    '“': '(?:“|"|&ldquo;|\\\\")',
    '”': '(?:”|"|&rdquo;|\\\\")',
    '–': '(?:–|&ndash;)',
    '—': '(?:—|&mdash;)',
    '<': '(?:<|&lt;)',
    '>': '(?:>|&gt;)',
  }
  const word = (w: string) => [...w].map((c) => CHAR[c] ?? reEscape(c)).join('')
  return new RegExp(text.trim().split(/\s+/).map(word).join('(?:\\s|&nbsp;|<br\\s*/?>)+'), flags)
}

interface Hit {
  file: string
  index: number
  length: number
}

function findOnce(files: string[], text: string): Hit | null {
  if (text.trim().length < 3) return null
  for (const flags of ['g', 'gi']) {
    const re = textPattern(text, flags)
    const hits: Hit[] = []
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8')
      for (const m of body.matchAll(re)) {
        hits.push({ file, index: m.index!, length: m[0].length })
        if (hits.length > 1) break
      }
      if (hits.length > 1) break
    }
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
  }
  return null
}

/** the new text, written the way the file it goes into expects */
function encodeFor(file: string, text: string) {
  if (/\.json$/i.test(file)) return JSON.stringify(text).slice(1, -1)
  if (/\.(m?js|cjs|tsx?|jsx|svelte|vue)$/i.test(file)) return text.replace(/\\/g, '\\\\').replace(/['"`]/g, '\\$&').replace(/\$\{/g, '\\${')
  if (/\.(html?|astro|njk|liquid|mdx?)$/i.test(file)) return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text
}

function replaceAt(hit: Hit, text: string) {
  const body = fs.readFileSync(hit.file, 'utf8')
  fs.writeFileSync(hit.file, body.slice(0, hit.index) + encodeFor(hit.file, text) + body.slice(hit.index + hit.length))
}

/** Try an edit without Claude. Returns the file it changed, or null. */
function direct(op: StudioOp, files: string[], dir: string): string | null {
  const swap = (before: string, after: string) => {
    if (!before.trim() || before === after) return null
    const hit = findOnce(files, before)
    if (!hit) return null
    replaceAt(hit, after)
    return path.relative(dir, hit.file)
  }
  if (op.kind === 'text') return swap(op.before, op.after)
  if (op.kind === 'alt') return swap(op.before, op.after)
  if (op.kind === 'link' && op.before.length > 1 && !/^#?$/.test(op.before)) return swap(op.before, op.after)
  return null
}

/** Copy a swapped-in photo into the repo, next to the photo it replaces where Studio can tell. Returns its repo path. */
function placeUpload(r: Runtime, op: Extract<StudioOp, { upload: string }>): string | null {
  const from = uploadPath(op.upload)
  if (!from) return null
  const dir = r.folder
  const { root, kind } = detectKind(dir)
  let target: string | null = null
  if (op.kind === 'image' && op.before) {
    try {
      const u = new URL(op.before)
      const served = path.resolve(root, '.' + decodeURIComponent(u.pathname))
      const pub = path.resolve(dir, 'public', '.' + decodeURIComponent(u.pathname))
      for (const f of [served, pub]) if (f.startsWith(dir) && fs.existsSync(f)) target = path.dirname(f)
    } catch {
      /* not a URL */
    }
  }
  if (!target) {
    const options = kind === 'astro' ? ['src/assets/photos', 'src/assets/images', 'src/assets', 'public/images', 'public'] : ['img', 'images', 'assets/img', 'assets/images', 'assets', 'src/img']
    const found = options.map((o) => path.join(dir, o)).find((o) => fs.existsSync(o))
    target = found ?? path.join(dir, kind === 'astro' ? 'public/images' : 'images')
  }
  fs.mkdirSync(target, { recursive: true })
  const ext = path.extname(from).toLowerCase() || '.jpg'
  const base = path.basename(op.name || 'photo', path.extname(op.name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo'
  let name = `${base}${ext}`
  for (let n = 2; fs.existsSync(path.join(target, name)); n++) name = `${base}-${n}${ext}`
  fs.copyFileSync(from, path.join(target, name))
  return path.relative(dir, path.join(target, name)).split(path.sep).join('/')
}

const KIND_NOTE: Record<StudioKind, string> = {
  static: 'It is a hand-written static site: edit its HTML, CSS and JS (or the data files its JS reads) directly.',
  generated: 'Its pages are generated by a Node build script from templates and data: edit those sources, never the generated HTML (Studio runs the build after you finish).',
  astro: 'It is an Astro site: edit src/ (pages, components, content collections, data files, styles). Astro’s dev server shows changes live.',
  shopify: 'It is a Shopify theme.',
  app: '',
  unknown: '',
}

function instruction(op: StudioOp, placed: Map<string, string>): string {
  const on = `On the page ${op.page}`
  const el = `the ${op.label} (CSS path \`${op.selector}\`${op.text ? `, text “${op.text.slice(0, 120)}”` : ''})`
  switch (op.kind) {
    case 'text':
      return `${on}, ${el} reads “${op.before}”. Change it to read “${op.after}”.`
    case 'alt':
      return `${on}, set the alt text of the image in ${el} to “${op.after}”.`
    case 'link':
      return `${on}, ${el} links to \`${op.before || '(nothing)'}\`. Make it link to \`${op.after}\`.`
    case 'image':
      return placed.get(op.id)
        ? `${on}, replace the photo in ${el} (currently ${op.before}) with the new photo Studio saved at \`${placed.get(op.id)}\`. Keep its alt text, size and crop styling. If the site serves it through <picture>/srcset or an image pipeline you can't run, point the image at the new file directly.`
        : `${on}, the photo in ${el} was swapped, but the new file couldn't be copied in. Skip this one and say so.`
    case 'add-image':
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
  }
}

function editPrompt(p: Project, kind: StudioKind, ops: StudioOp[], placed: Map<string, string>) {
  return [
    `You're working in a copy of the ${p.name} website repo (${p.repo}) for Studio, the visual editor in Dylan's Blueprint app. Dylan made these edits on Studio's preview of the site. Make each one in the site's real source so the site itself produces it.`,
    KIND_NOTE[kind],
    'Read CLAUDE.md and the README first if they exist, and follow their conventions. Keep each change as small as possible and scoped to that element and page. You can read and edit files but not run commands, so don’t build, test, commit or push: Studio does that. Don’t touch unrelated files.',
    '',
    'The edits, in the order they were made:',
    ...ops.map((op, i) => `${i + 1}. ${instruction(op, placed)}`),
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
function job(p: Project, message: string, fn: (r: Runtime) => Promise<StudioResult>): StudioSite | { error: string } {
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

async function rebuild(r: Runtime) {
  const { build } = detectKind(r.folder)
  if (build) {
    set(r, 'working', 'Building the pages')
    const b = await run(process.execPath, build, r.folder, AS_NODE)
    if (!b.ok) throw new Error(`The site’s build script failed after the edits. ${lastLine(b.out)}`)
  }
}

async function record(r: Runtime, notes: string[]) {
  const e = studioEdits(r.folder)
  const files = await gitChanged(r.folder)
  saveEdits(r.folder, { files, notes: files.length ? [...e.notes, ...notes] : [] })
}

/** Save canvas edits into the site's source. */
export function saveOps(p: Project, ops: StudioOp[], exe: string | null) {
  return job(p, `Saving ${ops.length} edit${ops.length === 1 ? '' : 's'} into the source`, async (r) => {
    const { kind } = detectKind(r.folder)
    const files = sourceFiles(r.folder, kind)
    const done: string[] = []
    const rest: StudioOp[] = []
    for (const op of ops) {
      const file = direct(op, files, r.folder)
      if (file) done.push(op.id)
      else rest.push(op)
    }
    const placed = new Map<string, string>()
    for (const op of rest) if (op.kind === 'image' || op.kind === 'add-image') {
      const at = placeUpload(r, op)
      if (at) placed.set(op.id, at)
    }
    let claudeText = ''
    const failed = new Map<string, string>()
    if (rest.length) {
      if (!exe) {
        for (const op of rest) failed.set(op.id, 'Claude Code isn’t set up on this computer')
      } else {
        set(r, 'working', `Claude is placing ${rest.length} edit${rest.length === 1 ? '' : 's'} in the source`)
        const c = await runClaudeIn(exe, r.folder, editPrompt(p, kind, rest, placed), (l) => l && set(r, 'working', `Claude: ${l.slice(0, 140)}`))
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
    await record(r, ok.map(opNote))
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
    await record(r, [`Claude: ${prompt.replace(/\s+/g, ' ').slice(0, 90)}`])
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
  const d = await run('git', ['diff', '--no-color', '--', '.', ':(exclude)*.min.*'], r.folder)
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
