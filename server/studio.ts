import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Project, StudioKind, StudioPage, StudioSite } from '../src/data/types.ts'
import { DATA_DIR, log } from './util.ts'
import { typeOf } from './files.ts'
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
  return { projectId: p.id, repo: p.repo, branch: p.defaultBranch, kind: 'unknown', status: 'idle', message: '', port: null, sha: null, commit: null, committed: null, changed: [], pages: [] }
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
    const edits = studioEdits(dir)
    if (edits.length) {
      // unpublished Studio edits: keep them rather than wipe them
      r.site.changed = edits
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
  r.site.changed = studioEdits(r.folder)
}

/**
 * Files you've changed in Studio and not yet published, as Studio records them.
 * (Not `git status`: a site's own build script rewrites its pages, and that
 * isn't an edit worth keeping over the latest from GitHub.)
 */
function studioEdits(dir: string): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, '.git', 'studio-edits.json'), 'utf8'))
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
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
