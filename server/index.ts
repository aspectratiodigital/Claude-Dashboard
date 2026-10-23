import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { AppMap, Change, Health, Note, NoteKind, Page, Project, Quality, Snapshot, Status, Store, Thread } from '../src/data/types.ts'
import { ghInstalled, ghToken, githubAuth, loadConfig, loadSettings, projectSettings, psiKey, saveSettings, type Config } from './config.ts'
import { GitHub, listRepos, loadChange, loadRepo, whoami, type RepoData, type RepoInfo } from './github.ts'
import { checkHealth, discoverPages, inspectPage, runPsi } from './health.ts'
import { scanLocalSessions, type LocalSession } from './claude.ts'
import { ask, findClaude, permissionMode, runClaude, stopAll, titleFor } from './assistant.ts'
import { changePrompt } from '../src/data/describe.ts'
import { deleteConversation, host, listConversations, loadShared, oneDriveSuggestion, saveConversation, savePrefs, saveSharedProjects, seedSyncFolder, syncDir, type StoredConversation } from './sync.ts'
import { blankStore, cleanDomain, loadCatalog, loadProduct, loadStore, type ShopifyCred } from './shopify.ts'
import { MAX_UPLOAD, UPLOADS, WORKSPACE, openOnDesktop, opensSafely, readRaw, saveUpload, sendFile, uploadPath, within } from './files.ts'
import { addKnowledgeFile, knowledgeDir, knowledgeFor, readKnowledge, removeKnowledgeFile, saveInstructions } from './knowledge.ts'
import { addSuggested, listExtras, removeSkill, saveSkill, skillsDir, writtenSkill } from './extras.ts'
import { unzip } from './zip.ts'
import { appRootOf, assetBytes, imagesOf, loadAppMap } from './appmap.ts'
import { appShot } from './shots.ts'
import { diffProject, seedNotes, testNote, type Draft } from './notes.ts'
import { DATA_DIR, ago, ensureDirs, hashColor, log, normaliseUrl, now, prettyName, readJson, slug, writeJson } from './util.ts'

// The local API behind the dashboard. It runs inside the Vite dev server,
// `vite preview` and the desktop app (server/app.ts), polls GitHub, checks
// your live sites, reads your local Claude Code sessions, turns changes into
// notifications and streams one snapshot to the browser over Server-Sent Events.

const STATE_FILE = path.join(DATA_DIR, 'state.json')
const NOTES_FILE = path.join(DATA_DIR, 'notes.json')
const CHANGES_FILE = path.join(DATA_DIR, 'changes.json')
const APPS_FILE = path.join(DATA_DIR, 'apps.json')
const MIN = 60_000

interface Persisted {
  projects: Project[]
  health: Record<string, Health>
  pages: Record<string, { at: number; pages: Page[] }>
}

class Engine {
  cfg: Config = loadConfig()
  gh: GitHub | null = null
  auth: 'token' | 'gh' | 'none' = 'none'
  login: string | null = null
  repos: RepoInfo[] = []
  reposAt = 0
  data = new Map<string, RepoData>()
  pushed = new Map<string, string>()
  lastFull = new Map<string, number>()
  lastLight = new Map<string, number>()
  health = new Map<string, Health>()
  sitePages = new Map<string, { at: number; pages: Page[] }>()
  inspected = new Map<string, Page>()
  /** what each thread's push changed, keyed on project, thread and push time; kept on disk so Claude describes each push once */
  changes = new Map<string, Change>(Object.entries(readJson<Record<string, Change>>(CHANGES_FILE, {})))
  changing = new Map<string, Promise<Change>>()

  async change(p: Project, t: Thread, repo: RepoInfo): Promise<Change> {
    const key = `${p.id}|${t.id}|${t.pushed ?? t.updated}`
    const hit = this.changes.get(key)
    if (hit) return hit
    const busy = this.changing.get(key)
    if (busy) return busy
    const job = (async () => {
      const c = await loadChange(this.gh!, repo, t, this.data.get(repo.full.toLowerCase()))
      const exe = c.commits.length || c.files.length ? await findClaude(loadSettings().claudePath) : null
      const words = exe ? await ask(exe, changePrompt(p.name, t.title, c)) : null
      const done: Change = words ? { ...c, summary: words.replace(/\s*\n\s*/g, ' '), by: 'claude' } : c
      this.changes.set(key, done)
      writeJson(CHANGES_FILE, Object.fromEntries([...this.changes].slice(-200)))
      return done
    })().finally(() => this.changing.delete(key))
    this.changing.set(key, job)
    return job
  }
  psiAt = new Map<string, number>()
  sessions: LocalSession[] = []
  /** each app's floors, by project id; read again when its default branch moves */
  appMaps = new Map<string, AppMap>(Object.entries(readJson<Record<string, AppMap>>(APPS_FILE, {})))
  appBusy = new Set<string>()

  /** An app's floors: the saved map, re-read in the background when the branch has moved on. */
  appFor(id: string, repo: RepoInfo, d: RepoData): AppMap | null {
    const have = this.appMaps.get(id) ?? null
    if (!d.treeSha || have?.sha === d.treeSha || this.appBusy.has(id) || !this.gh) return have
    this.appBusy.add(id)
    loadAppMap(this.gh, repo, d.paths, d.treeSha, appRootOf(d.paths))
      .then((m) => {
        this.appMaps.set(id, m)
        writeJson(APPS_FILE, Object.fromEntries(this.appMaps))
        this.rebuild()
      })
      .catch((e) => log('app map', repo.full, (e as Error).message))
      .finally(() => this.appBusy.delete(id))
    return have
  }

  /** Shopify stores read with the Admin API, by domain */
  stores = new Map<string, Store>()
  storeAt = new Map<string, number>()
  projects: Project[] = []
  prev = new Map<string, Project>()
  notes: Note[] = []
  clients = new Set<ServerResponse>()
  errors: string[] = []
  busy = false
  booted = false
  lastSent = ''
  timers: NodeJS.Timeout[] = []

  start() {
    if (this.booted) return
    this.booted = true
    ensureDirs()
    const saved = readJson<Persisted | null>(STATE_FILE, null)
    if (saved) {
      for (const p of saved.projects ?? []) this.prev.set(p.id, p)
      for (const [k, v] of Object.entries(saved.health ?? {})) this.health.set(k, v)
      for (const [k, v] of Object.entries(saved.pages ?? {})) this.sitePages.set(k, v)
      this.projects = saved.projects ?? []
      // last-read stores, so a store saved on this computer shows as connected straight away after a restart
      const tokens = loadSettings().shopifyTokens ?? {}
      for (const p of this.projects) if (p.store?.connected && tokens[p.store.domain]) this.stores.set(p.store.domain, p.store)
    }
    this.notes = readJson<Note[]>(NOTES_FILE, [])
    this.sessions = safe(() => scanLocalSessions(), [])
    const loop = () => this.tick().catch((e) => log('tick failed', e))
    loop()
    this.timers.push(setInterval(loop, 15_000))
    this.timers.push(setInterval(() => this.sites().catch((e) => log('site checks failed', e)), MIN))
    this.timers.push(setInterval(() => this.scanSessions(), 20_000))
    this.timers.push(setInterval(() => this.ping(), 25_000))
    this.timers.push(setInterval(() => this.shops().catch((e) => log('shop checks failed', e)), 30_000))
    setTimeout(() => this.sites().catch(() => {}), 4000)
    setTimeout(() => this.shops(true).catch(() => {}), 3000)
  }

  stop() {
    this.timers.forEach(clearInterval)
  }

  // --- GitHub polling ---------------------------------------------------------------

  async tick(force = false) {
    if (this.busy) return
    this.busy = true
    try {
      this.cfg = loadConfig()
      const auth = await githubAuth()
      if (!this.gh || auth.token !== this.gh.token) {
        this.gh = new GitHub(auth.token)
        this.auth = auth.source
        this.login = auth.token ? await whoami(this.gh).catch(() => null) : null
        this.reposAt = 0
        this.data.clear()
      }
      if (!auth.token && !process.env.JARVIS_PUBLIC) {
        this.errors = []
        this.broadcast()
        return
      }
      if (force || Date.now() - this.reposAt > this.cfg.pollSeconds * 1000) {
        const all = await listRepos(this.gh, this.cfg.owner, this.login, this.cfg.include)
        this.repos = all.filter((r) => this.wanted(r))
        this.reposAt = Date.now()
      }
      const jobs = this.repos.map((repo) => async () => {
        const key = repo.full.toLowerCase()
        const prev = this.data.get(key)
        const pushedChanged = this.pushed.get(key) !== repo.pushedAt
        const active = prev ? isActive(prev) : false
        const full = force || !prev || pushedChanged || Date.now() - (this.lastFull.get(key) ?? 0) > 2 * MIN
        const light = !full && active && Date.now() - (this.lastLight.get(key) ?? 0) > 12_000
        if (!full && !light) return
        const d = await loadRepo(this.gh!, repo, { light, prev })
        this.data.set(key, d)
        this.pushed.set(key, repo.pushedAt)
        if (full) this.lastFull.set(key, Date.now())
        this.lastLight.set(key, Date.now())
      })
      await pool(jobs, 4)
      this.errors = []
      this.rebuild()
    } catch (e) {
      const msg = (e as Error).message
      log(msg)
      this.errors = [msg]
      this.broadcast()
    } finally {
      this.busy = false
    }
  }

  wanted(r: RepoInfo) {
    const c = this.cfg
    const o = c.projects[r.name] ?? c.projects[slug(r.name)]
    if (o?.hidden) return false
    if (c.include.length) return true
    if (c.exclude.some((x) => x.toLowerCase() === r.name.toLowerCase())) return false
    return !r.archived && !r.fork
  }

  // --- Live sites: uptime, response time, tags, pages, optional PSI ------------------

  async sites() {
    const key = psiKey()
    const jobs = this.projects
      .filter((p) => p.url)
      .map((p) => async () => {
        const url = p.url!
        const h = this.health.get(p.id)
        const sameUrl = h?.url === url
        if (!sameUrl || ago(h?.checked) > this.cfg.uptimeMinutes * MIN - 5000) {
          this.health.set(p.id, await checkHealth(url, sameUrl ? h : undefined))
        }
        const sp = this.sitePages.get(p.id)
        if (!sp || Date.now() - sp.at > 6 * 60 * MIN) {
          this.sitePages.set(p.id, { at: Date.now(), pages: await discoverPages(url).catch(() => []) })
        }
        if (key && Date.now() - (this.psiAt.get(p.id) ?? 0) > 24 * 60 * MIN) {
          this.psiAt.set(p.id, Date.now())
          const psi = await runPsi(url, key)
          const cur = this.health.get(p.id)
          if (psi && cur) this.health.set(p.id, { ...cur, psi })
        }
      })
    await pool(jobs, 3)
    this.rebuild()
  }

  // --- Shopify stores: every 2 minutes for each one with a token on this computer ---------

  /** The store a site is built on: set by hand in Settings, else found in its code. */
  storeOf(repo: RepoInfo, d: RepoData): { domain: string; headless: string | null } | null {
    const o = this.cfg.projects[repo.name] ?? this.cfg.projects[slug(repo.name)] ?? {}
    // a storefront whose code doesn't name its store still gets a shopfront, waiting for the address
    const domain = (o.shopify && cleanDomain(o.shopify)) || d.shopify?.domain || (d.shopify ? '' : null)
    return domain === null ? null : { domain, headless: d.shopify?.headless ?? null }
  }

  async shops(force = false) {
    const tokens = loadSettings().shopifyTokens ?? {}
    const jobs = this.projects
      .filter((p) => p.store && tokens[p.store.domain])
      .map((p) => async () => {
        const { domain, headless } = p.store!
        if (!force && Date.now() - (this.storeAt.get(domain) ?? 0) < 2 * MIN) return
        this.storeAt.set(domain, Date.now())
        const next = await loadStore(domain, tokens[domain]!, headless)
        const last = this.stores.get(domain)
        // a dropped connection (the laptop just woke, say) keeps the last good read and tries again in 30 seconds
        if (!next.connected && last?.connected && /^Couldn't reach/.test(next.error ?? '')) {
          this.storeAt.set(domain, Date.now() - 2 * MIN + 30_000)
          return
        }
        this.stores.set(domain, next)
      })
    if (!jobs.length) return
    await pool(jobs, 3)
    this.rebuild()
  }

  scanSessions() {
    const next = safe(() => scanLocalSessions(), this.sessions)
    const sig = (s: LocalSession[]) => s.map((x) => x.id + x.updated).join()
    if (sig(next) !== sig(this.sessions)) {
      this.sessions = next
      this.rebuild()
    }
  }

  // --- Compose projects, diff, notify ------------------------------------------------------

  get live() {
    return !!this.gh?.token || !!process.env.JARVIS_PUBLIC
  }

  rebuild() {
    if (!this.live) return this.broadcast()
    const firstEver = this.prev.size === 0
    const list: Project[] = []
    for (const repo of this.repos) {
      const d = this.data.get(repo.full.toLowerCase())
      if (d) list.push(this.compose(repo, d))
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    const fresh: Draft[] = []
    for (const p of list) {
      const before = this.prev.get(p.id)
      if (firstEver) fresh.push(...seedNotes(p).map((n) => ({ ...n, seed: true })))
      else fresh.push(...diffProject(before, p))
      this.prev.set(p.id, p)
    }
    this.projects = list
    for (const d of fresh) this.addNote(d, (d as { seed?: boolean }).seed === true)
    writeJson(STATE_FILE, {
      projects: list,
      health: Object.fromEntries(this.health),
      pages: Object.fromEntries(this.sitePages),
    } satisfies Persisted, 2000)
    this.broadcast()
  }

  compose(repo: RepoInfo, d: RepoData): Project {
    const id = slug(repo.name)
    const o = this.cfg.projects[repo.name] ?? this.cfg.projects[id] ?? {}
    const prod = d.deployments.find((x) => x.production && x.state === 'success' && x.url)
    const anyOk = d.deployments.find((x) => x.state === 'success' && x.url)
    const url =
      normaliseUrl(o.url) ?? normaliseUrl(repo.homepage) ?? normaliseUrl(d.cname) ?? normaliseUrl(prod?.url) ?? normaliseUrl(d.pagesUrl) ?? null
    const previewUrl = normaliseUrl(o.previewUrl) ?? normaliseUrl(d.deployments.find((x) => !x.production && x.state === 'success' && x.url)?.url) ?? normaliseUrl(anyOk?.url) ?? url
    const health: Health = this.health.get(id) ?? {
      url,
      checked: null,
      up: null,
      code: null,
      ms: null,
      bytes: null,
      history: [],
      uptimePct: null,
      seoScore: null,
      checks: [],
      themeColor: null,
      psi: null,
    }
    const threads = this.threads(repo, d)
    const { status, reason } = statusOf(d, health, repo.defaultBranch, threads)
    const pages = this.pages(id, d)
    const shop = this.storeOf(repo, d)
    const linked = !!shop?.domain && !!loadSettings().shopifyTokens?.[shop.domain]
    const store = shop ? { ...(this.stores.get(shop.domain) ?? blankStore(shop.domain, shop.headless)), headless: shop.headless, linked } : null
    const kind = o.kind ?? (appRootOf(d.paths ?? []) !== null ? 'app' : 'site')
    const app = kind === 'app' ? this.appFor(id, repo, d) : null
    const theme = health.themeColor && /^#[0-9a-f]{6}$/i.test(health.themeColor) && !/^#(f{6}|0{6})$/i.test(health.themeColor) ? health.themeColor : null
    return {
      id,
      name: o.name || prettyName(repo.name),
      repo: repo.full,
      description: repo.description,
      private: repo.private,
      language: repo.language,
      framework: d.framework,
      host: d.host,
      defaultBranch: repo.defaultBranch,
      url,
      previewUrl,
      localPort: o.localPort ?? d.port,
      claudeProjectUrl: d.claudeProjectUrl,
      status,
      reason,
      pushedAt: repo.pushedAt,
      accent: theme ?? hashColor(repo.name),
      activity: d.activity,
      commitsWeek: d.commitsWeek,
      branches: d.branches,
      commits: d.commits.slice(0, 15),
      pulls: d.pulls.slice(0, 12),
      issues: d.issues.slice(0, 20),
      runs: d.runs.slice(0, 12),
      deployments: d.deployments,
      threads,
      pages,
      health,
      quality: qualityOf(d, health),
      store,
      kind,
      app,
    }
  }

  threads(repo: RepoInfo, d: RepoData): Thread[] {
    const out: Thread[] = []
    const used = new Set<string>()
    for (const p of d.pulls) {
      if (!p.claude) continue
      const commits = d.commits.filter((c) => c.sessionUrl && c.sessionUrl === p.sessionUrl).length
      if (p.sessionUrl) used.add(p.sessionUrl)
      used.add(p.branch)
      out.push({
        id: p.sessionUrl ?? `pr-${p.number}`,
        title: p.title,
        source: p.sessionUrl || p.threadUrl ? 'claude-web' : 'pr',
        status: p.state === 'open' ? (ago(p.updated) < 20 * MIN ? 'working' : 'open') : p.state,
        updated: p.updated,
        pushed: p.pushed,
        branch: p.branch,
        url: p.threadUrl ?? p.sessionUrl,
        prUrl: p.url,
        prNumber: p.number,
        commits,
      })
    }
    const bySession = new Map<string, typeof d.commits>()
    for (const c of d.commits) {
      if (!c.sessionUrl || used.has(c.sessionUrl)) continue
      bySession.set(c.sessionUrl, [...(bySession.get(c.sessionUrl) ?? []), c])
    }
    for (const [url, cs] of bySession) {
      out.push({
        id: url,
        title: cs[cs.length - 1].message,
        source: 'claude-web',
        status: ago(cs[0].date) < 20 * MIN ? 'working' : 'merged',
        updated: cs[0].date,
        pushed: cs[0].date,
        url,
        commits: cs.length,
        summary: `${cs.length} commit${cs.length === 1 ? '' : 's'} on ${repo.defaultBranch}`,
      })
    }
    for (const b of d.branches) {
      if (!b.startsWith('claude/') || used.has(b)) continue
      out.push({ id: `branch-${b}`, title: b.replace(/^claude\//, '').replace(/[-_]/g, ' '), source: 'claude-web', status: 'open', updated: d.branchPushed?.[b] ?? repo.pushedAt, pushed: d.branchPushed?.[b], branch: b, commits: 0, summary: 'Branch without a pull request' })
    }
    const key = repo.full.toLowerCase()
    for (const s of this.sessions) {
      const mine = s.repo ? s.repo === key : slug(s.folder) === slug(repo.name)
      if (!mine) continue
      out.push({
        id: `local-${s.id}`,
        title: s.title,
        source: 'claude-local',
        status: ago(s.updated) < 3 * MIN ? 'working' : 'idle',
        updated: s.updated,
        branch: s.branch ?? undefined,
        commits: 0,
        summary: `Claude Code on this computer, in ${s.folder}`,
        resume: `claude --resume ${s.id}`,
      })
    }
    // newest push first; threads with no push of their own (local sessions) go by last activity
    return out.sort((a, b) => (b.pushed ?? b.updated).localeCompare(a.pushed ?? a.updated)).slice(0, 24)
  }

  pages(id: string, d: RepoData): Page[] {
    const site = this.sitePages.get(id)?.pages ?? []
    const map = new Map<string, Page>()
    for (const p of site) map.set(p.path, p)
    for (const p of d.repoPages) if (!map.has(p.path)) map.set(p.path, p)
    else map.set(p.path, { ...map.get(p.path)!, file: p.file })
    if (!map.size) map.set('/', { path: '/', source: 'nav' })
    return [...map.values()].map((p) => ({ ...p, ...(this.inspected.get(`${id}${p.path}`) ?? {}) })).slice(0, 60)
  }

  /** The project's folder on this computer: a Settings override, else where Claude Code last worked on it. */
  folderFor(p: Project): string | null {
    const repoName = p.repo.split('/').pop() ?? p.name
    const o = this.cfg.projects[repoName] ?? this.cfg.projects[slug(repoName)]
    if (o?.folder && fs.existsSync(o.folder)) return o.folder
    const key = p.repo.toLowerCase()
    const name = slug(repoName)
    const hit = this.sessions.filter((s) => (s.repo ? s.repo === key : slug(s.folder) === name)).sort((a, b) => b.updated.localeCompare(a.updated))[0]
    if (hit?.cwd) return hit.cwd
    // a copy Claude cloned into its workspace
    const cloned = path.join(WORKSPACE, repoName)
    return fs.existsSync(path.join(cloned, '.git')) ? cloned : null
  }

  addNote(d: Draft, seeded = false) {
    if (this.notes.some((n) => n.id === d.id)) return
    const note: Note = { ...d, at: d.at ?? now(), read: seeded }
    delete (note as { seed?: boolean }).seed
    this.notes.unshift(note)
    this.notes.sort((a, b) => b.at.localeCompare(a.at))
    this.notes = this.notes.slice(0, 300)
    writeJson(NOTES_FILE, this.notes)
    if (!seeded) this.send('note', note)
  }

  // --- Output ----------------------------------------------------------------------------

  snapshot(): Snapshot {
    const live = this.live
    return {
      mode: live ? 'live' : 'demo',
      projects: live ? this.projects : [],
      notes: live ? this.notes.slice(0, 120) : [],
      setup: {
        github: this.auth,
        owner: this.cfg.owner,
        login: this.login,
        psi: !!psiKey(),
        claudeSessions: this.sessions.length,
      },
      updated: now(),
      rate: this.gh?.rate ?? null,
      errors: this.errors,
    }
  }

  broadcast() {
    const snap = this.snapshot()
    const sig = JSON.stringify({ ...snap, updated: '', rate: null })
    if (sig === this.lastSent) return
    this.lastSent = sig
    this.send('snapshot', snap)
  }

  send(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of this.clients) c.write(msg)
  }

  ping() {
    for (const c of this.clients) c.write(': ping\n\n')
  }
}

// --- helpers ---------------------------------------------------------------------------------

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

async function pool(jobs: (() => Promise<void>)[], n: number) {
  let i = 0
  const errs: Error[] = []
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) {
        const job = jobs[i++]
        try {
          await job()
        } catch (e) {
          errs.push(e as Error)
        }
      }
    }),
  )
  if (errs.length) throw errs[0]
}

function isActive(d: RepoData) {
  return d.deployPending || d.runs.some((r) => r.status === 'running' || r.status === 'queued') || d.deployments.some((x) => ['queued', 'pending', 'in_progress'].includes(x.state))
}

function statusOf(d: RepoData, h: Health, branch: string, threads: Thread[]): { status: Status; reason: string } {
  const lastMain = d.runs.find((r) => r.branch === branch && r.status !== 'skipped' && r.status !== 'cancelled')
  const lastProd = d.deployments.find((x) => x.production && x.state !== 'inactive')
  if (lastMain?.status === 'failure') return { status: 'broken', reason: `${lastMain.name} is failing on ${branch}` }
  if (lastProd && (lastProd.state === 'failure' || lastProd.state === 'error')) return { status: 'broken', reason: `The last ${lastProd.environment} deploy failed` }
  if (h.up === false) return { status: 'broken', reason: `The live site isn't responding (${h.code ?? 'no answer'})` }
  const running = d.runs.find((r) => r.status === 'running' || r.status === 'queued')
  if (running) return { status: 'building', reason: `${running.name} running on ${running.branch}` }
  const deploying = d.deployments.find((x) => ['queued', 'pending', 'in_progress'].includes(x.state))
  if (deploying || d.deployPending) return { status: 'deploying', reason: deploying ? `Deploying ${deploying.environment}` : 'A deploy is in progress' }
  const bugs = d.issues.filter((i) => i.bug).length
  const failingPr = d.pulls.find((p) => p.state === 'open' && p.checks === 'fail')
  const review = d.pulls.find((p) => p.state === 'open' && p.reviewRequested)
  if (failingPr) return { status: 'attention', reason: `PR #${failingPr.number} has failing checks` }
  if (bugs) return { status: 'attention', reason: `${bugs} open bug${bugs === 1 ? '' : 's'}` }
  if (review) return { status: 'attention', reason: `PR #${review.number} is waiting for your review` }
  if (d.issues.length) return { status: 'attention', reason: `${d.issues.length} open issue${d.issues.length === 1 ? '' : 's'}` }
  const working = threads.find((t) => t.status === 'working')
  if (working) return { status: 'building', reason: `Claude is working: ${working.title}` }
  const quiet = !d.commits[0] || ago(d.commits[0].date) > 30 * 24 * 60 * MIN
  if (quiet) return { status: 'quiet', reason: 'No changes in the last month' }
  return { status: 'live', reason: lastProd?.state === 'success' ? `Deployed ${relTime(lastProd.created)}` : `Last change ${relTime(d.commits[0].date)}` }
}

function qualityOf(d: RepoData, h: Health): Quality {
  const done = d.runs.filter((r) => r.status === 'success' || r.status === 'failure').slice(0, 20)
  const pass = done.length ? done.filter((r) => r.status === 'success').length / done.length : null
  const durs = done.map((r) => r.durationS).filter((x): x is number => x !== null)
  const merged = new Set(d.pulls.filter((p) => p.state !== 'open').map((p) => p.branch))
  const stale = d.branches.filter((b) => merged.has(b)).length
  const bugs = d.issues.filter((i) => i.bug).length
  const parts: [number, number][] = []
  if (pass !== null) parts.push([pass * 100, 0.45])
  if (h.seoScore !== null) parts.push([h.seoScore, 0.2])
  if (h.psi) parts.push([h.psi.scores.performance, 0.2])
  if (h.uptimePct !== null) parts.push([h.uptimePct, 0.15])
  parts.push([Math.max(0, 100 - bugs * 15 - Math.max(0, d.issues.length - bugs) * 4), 0.2])
  const w = parts.reduce((a, [, x]) => a + x, 0)
  const score = parts.reduce((a, [v, x]) => a + v * x, 0) / w
  const grade = pass === null && h.seoScore === null ? null : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F'
  return {
    ciPassRate: pass,
    avgBuildS: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    openBugs: bugs,
    openPRs: d.pulls.filter((p) => p.state === 'open').length,
    staleBranches: stale,
    grade,
  }
}

function relTime(iso: string) {
  const m = Math.round(ago(iso) / MIN)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// --- HTTP -------------------------------------------------------------------------------------

const engine = new Engine()

/** Folders whose files the dashboard may open or hand out: projects, Claude's workspace, uploads, knowledge. */
function fileRoots() {
  const roots = [WORKSPACE, UPLOADS, path.dirname(knowledgeDir('_all')!)]
  for (const p of engine.projects) {
    const f = engine.folderFor(p)
    if (f) roots.push(f)
  }
  return roots
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > limit) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** Only the dashboard itself may change settings: no cross-site requests. */
function sameOrigin(req: IncomingMessage) {
  // Only answer to the dashboard's own address (guards against DNS rebinding).
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const NOTE_KINDS: NoteKind[] = ['build', 'build-ok', 'build-fail', 'deploying', 'deployed', 'deploy-fail', 'issue', 'pr', 'merged', 'review', 'push', 'claude', 'down', 'up', 'perf', 'order', 'stock']

export async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next()
  engine.start()
  const route = `${req.method} ${url.pathname}`
  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })

  switch (route) {
    case 'GET /api/snapshot':
      return json(res, 200, engine.snapshot())

    case 'GET /api/stream': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write('retry: 3000\n\n')
      res.write(`event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`)
      engine.clients.add(res)
      req.on('close', () => engine.clients.delete(res))
      return
    }

    case 'GET /api/claude': {
      const exe = await findClaude(loadSettings().claudePath)
      return json(res, 200, { available: !!exe, path: exe, host: host() })
    }

    case 'POST /api/claude/title': {
      // a short name for a new thread, written by Claude Code's quickest model
      const body = await readBody(req, 20_000)
      const exe = await findClaude(loadSettings().claudePath)
      if (!exe) return json(res, 503, { error: 'Claude Code is not installed on this computer' })
      const title = await titleFor(exe, String(body.prompt ?? ''), String(body.reply ?? ''))
      return title ? json(res, 200, { title }) : json(res, 502, { error: 'No title' })
    }

    case 'POST /api/claude': {
      const body = await readBody(req, 400_000)
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 8000) : ''
      if (!prompt) return json(res, 400, { error: 'empty prompt' })
      const exe = await findClaude(loadSettings().claudePath)
      if (!exe) return json(res, 503, { error: 'Claude Code is not installed on this computer' })
      const site = engine.projects.find((x) => x.id === body.projectId) ?? null
      return runClaude(
        {
          exe,
          mode: await permissionMode(exe, typeof body.permission === 'string' ? body.permission : undefined),
          prompt,
          projects: engine.projects,
          site,
          folder: site ? engine.folderFor(site) : null,
          resume: typeof body.resume === 'string' ? body.resume : undefined,
          allow: Array.isArray(body.allow) ? (body.allow as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          history: typeof body.history === 'string' ? body.history.slice(-60_000) : undefined,
          files: Array.isArray(body.files) ? (body.files as unknown[]).slice(0, 20).map((id) => (typeof id === 'string' ? uploadPath(id) : null)).filter((f): f is string => !!f) : undefined,
          knowledge: knowledgeFor(site?.id ?? null),
          // a signed-in GitHub CLI's own token can usually push, so it beats a read-only dashboard token
          github: { token: (await ghToken()) ?? (await githubAuth()).token, cli: await ghInstalled() },
        },
        res,
      )
    }

    case 'POST /api/upload': {
      // a file attached to a message: the raw bytes, named in the query string
      const name = url.searchParams.get('name') ?? 'file'
      const data = await readRaw(req, MAX_UPLOAD)
      if (!data) return json(res, 413, { error: 'Files can be up to 25 MB' })
      return json(res, 200, saveUpload(name, data))
    }

    case 'GET /api/file': {
      // a file Claude made (or you attached), for a preview or a download
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })
      const file = within(url.searchParams.get('path') ?? '', fileRoots())
      if (!file) return json(res, 404, { error: 'That file isn’t in one of your project folders' })
      return sendFile(res, file, url.searchParams.get('download') === '1')
    }

    case 'POST /api/open': {
      const body = await readBody(req)
      const file = within(typeof body.path === 'string' ? body.path : '', fileRoots())
      if (!file) return json(res, 404, { error: 'That file isn’t in one of your project folders' })
      const reveal = body.reveal === true || !opensSafely(file)
      return json(res, 200, { ok: openOnDesktop(file, reveal), revealed: reveal })
    }

    case 'GET /api/knowledge': {
      const key = url.searchParams.get('project') || '_all'
      return json(res, 200, { ...readKnowledge(key), dir: knowledgeDir(key) })
    }

    case 'POST /api/knowledge': {
      const body = await readBody(req, 200_000)
      const key = typeof body.project === 'string' && body.project ? body.project : '_all'
      if (typeof body.instructions === 'string' && !saveInstructions(key, body.instructions)) return json(res, 400, { error: 'bad project' })
      if (typeof body.remove === 'string') removeKnowledgeFile(key, body.remove)
      return json(res, 200, readKnowledge(key))
    }

    case 'POST /api/knowledge/file': {
      const key = url.searchParams.get('project') || '_all'
      const data = await readRaw(req, MAX_UPLOAD)
      if (!data) return json(res, 413, { error: 'Files can be up to 25 MB' })
      if (!addKnowledgeFile(key, url.searchParams.get('name') ?? 'file', data)) return json(res, 400, { error: 'bad project' })
      return json(res, 200, readKnowledge(key))
    }

    case 'GET /api/claude/extras': {
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      return json(res, 200, listExtras(p ? engine.folderFor(p) : null))
    }

    case 'POST /api/claude/skill': {
      // add a skill: a SKILL.md, a .zip / .skill (raw body, ?file=name), or one written here (JSON)
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const folder = url.searchParams.get('scope') === 'project' ? (p ? engine.folderFor(p) : null) : null
      if (url.searchParams.get('scope') === 'project' && !folder) return json(res, 400, { error: 'Set this project’s folder in Settings first' })
      const dir = skillsDir(folder)
      const file = url.searchParams.get('file')
      try {
        let saved: ReturnType<typeof saveSkill>
        if (file) {
          const data = await readRaw(req, MAX_UPLOAD)
          if (!data) return json(res, 413, { error: 'Skills can be up to 25 MB' })
          const zipped = /\.(zip|skill)$/i.test(file) || data.subarray(0, 2).toString() === 'PK'
          saved = saveSkill(dir, zipped ? unzip(data) : [{ name: 'SKILL.md', data }], file.replace(/\.[^.]+$/, '').replace(/^SKILL$/i, ''))
        } else {
          const body = await readBody(req, 400_000)
          const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
          if (!str(body.name) || !str(body.description) || !str(body.body)) return json(res, 400, { error: 'Give the skill a name, a description and instructions' })
          saved = saveSkill(dir, [{ name: 'SKILL.md', data: Buffer.from(writtenSkill(str(body.name), str(body.description), str(body.body))) }], str(body.name))
        }
        return saved.ok ? json(res, 200, { ok: true, name: saved.name, where: path.join(dir, saved.name) }) : json(res, 400, { error: saved.error })
      } catch (e) {
        return json(res, 400, { error: (e as Error).message })
      }
    }

    case 'POST /api/claude/skill/remove': {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })
      const body = await readBody(req)
      const p = engine.projects.find((x) => x.id === body.project)
      const folder = body.scope === 'project' ? (p ? engine.folderFor(p) : null) : null
      if (body.scope === 'project' && !folder) return json(res, 400, { error: 'No folder for this project' })
      return removeSkill(skillsDir(folder), String(body.name ?? '')) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No skill by that name' })
    }

    case 'POST /api/claude/mcp': {
      const body = await readBody(req)
      const exe = await findClaude(loadSettings().claudePath)
      if (!exe) return json(res, 503, { error: 'Claude Code is not installed on this computer' })
      return json(res, 200, await addSuggested(exe, String(body.id ?? '')))
    }

    case 'POST /api/refresh':
      engine.tick(true).catch(() => {})
      return json(res, 202, { ok: true })

    case 'GET /api/settings': {
      const s = loadSettings()
      return json(res, 200, { owner: engine.cfg.owner, github: engine.auth, login: engine.login, hasToken: !!s.githubToken, psi: !!psiKey(), projects: projectSettings(s), shopify: Object.keys(s.shopifyTokens ?? {}), syncDir: s.syncDir ?? '', syncing: !!syncDir(), oneDrive: oneDriveSuggestion() })
    }

    case 'POST /api/settings': {
      const body = await readBody(req)
      const patch: Parameters<typeof saveSettings>[0] = {}
      if (typeof body.githubToken === 'string') patch.githubToken = body.githubToken.trim()
      if (typeof body.psiKey === 'string') patch.psiKey = body.psiKey.trim()
      if (typeof body.owner === 'string') patch.owner = body.owner.trim()
      if (body.projects && typeof body.projects === 'object') patch.projects = body.projects as never
      if (typeof body.syncDir === 'string') patch.syncDir = body.syncDir.trim()
      saveSettings(patch)
      if (patch.syncDir) seedSyncFolder()
      if (patch.projects) saveSharedProjects(patch.projects)
      engine.cfg = loadConfig()
      engine.rebuild()
      setTimeout(() => engine.tick(true).catch(() => {}), 50)
      return json(res, 200, { ok: true })
    }

    case 'GET /api/shopify/products':
    case 'GET /api/shopify/product': {
      // a store's products (or one product, opened up), read when you open the products view
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const domain = p?.store?.domain
      const cred = domain ? loadSettings().shopifyTokens?.[domain] : null
      if (!domain || !cred) return json(res, 404, { error: 'This site’s store isn’t connected on this computer' })
      const id = url.searchParams.get('id')
      const out = route === 'GET /api/shopify/product' ? (id && /^\d+$/.test(id) ? await loadProduct(domain, cred, id) : { error: 'bad product id' }) : await loadCatalog(domain, cred, url.searchParams.get('fresh') === '1')
      return 'error' in out ? json(res, 502, out) : json(res, 200, out)
    }

    case 'POST /api/shopify': {
      // Connect (or disconnect, with an empty token) a site's Shopify store.
      const body = await readBody(req)
      const p = engine.projects.find((x) => x.id === body.projectId)
      const domain = typeof body.domain === 'string' ? cleanDomain(body.domain) : (p?.store?.domain ?? null)
      if (!domain) return json(res, 400, { error: 'That doesn\'t look like a Shopify store. Use the xxx.myshopify.com address.' })
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
      const token: ShopifyCred | null = str(body.clientId) && str(body.secret) ? { id: str(body.clientId), secret: str(body.secret) } : str(body.token) || null
      if (token) {
        const test = await loadStore(domain, token, p?.store?.headless ?? null)
        if (!test.connected) return json(res, 400, { error: test.error ?? 'Shopify didn\'t accept that token' })
        engine.stores.set(domain, test)
        engine.storeAt.set(domain, Date.now())
      } else {
        engine.stores.delete(domain)
      }
      saveSettings({ shopifyTokens: { [domain]: token }, ...(p ? { projects: { [p.repo.split('/').pop()!]: { shopify: domain } } } : {}) })
      if (p) saveSharedProjects({ [p.repo.split('/').pop()!]: { shopify: domain } })
      engine.cfg = loadConfig()
      engine.rebuild()
      return json(res, 200, { ok: true, domain })
    }

    case 'GET /api/app/asset': {
      // an image from an app's repo, as the floors show it
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const file = url.searchParams.get('path') ?? ''
      if (!p?.app || !imagesOf(p.app).has(file)) return json(res, 404, { error: 'not an image this app shows' })
      const buf = await assetBytes(engine.gh?.token ?? null, p.repo, p.app.sha, file)
      if (!buf) return json(res, 502, { error: 'Couldn’t fetch that image from GitHub' })
      res.statusCode = 200
      res.setHeader('Content-Type', /\.svg$/i.test(file) ? 'image/svg+xml' : /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : /\.gif$/i.test(file) ? 'image/gif' : 'image/jpeg')
      res.setHeader('Cache-Control', 'max-age=86400')
      if (/\.svg$/i.test(file)) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      return res.end(buf)
    }

    case 'GET /api/app/shot': {
      // a screenshot of the app's live web build, opened on one skin or game mode
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const q = url.searchParams.get('q') ?? ''
      if (!p?.app || !p.app.floors.some((f) => f.galleries.some((g) => g.items.some((i) => i.shot === q)))) return json(res, 404, { error: 'not a screen this app shows' })
      if (!p.url) return json(res, 404, { error: 'Add the app’s web address in Settings to see screenshots' })
      const shot = await appShot(`${p.url.replace(/\/?$/, '/')}?${q}`, `${p.app.sha}${url.searchParams.get('fresh') ? Date.now() : ''}`)
      if ('error' in shot) return json(res, 502, shot)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'no-cache')
      return res.end(shot.jpg)
    }

    case 'POST /api/notes/read': {
      const body = await readBody(req)
      const ids = Array.isArray(body.ids) ? new Set(body.ids as string[]) : null
      for (const n of engine.notes) if (!ids || ids.has(n.id)) n.read = true
      writeJson(NOTES_FILE, engine.notes)
      engine.broadcast()
      return json(res, 200, { ok: true })
    }

    case 'GET /api/sync':
      return json(res, 200, { conversations: listConversations(), prefs: loadShared().prefs ?? null, host: host(), syncing: !!syncDir() })

    case 'POST /api/conversation': {
      const body = await readBody(req, 4_000_000)
      const c = body.conversation as StoredConversation | undefined
      if (!c || typeof c.id !== 'string' || !/^[\w-]{1,64}$/.test(c.id)) return json(res, 400, { error: 'bad conversation' })
      if (body.delete === true) deleteConversation(c.id)
      else saveConversation({ ...c, updated: Number(c.updated) || Date.now() })
      return json(res, 200, { ok: true })
    }

    case 'POST /api/prefs': {
      const body = await readBody(req)
      const pick = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
      savePrefs({ theme: pick('theme'), font: pick('font'), cars: typeof body.cars === 'boolean' ? body.cars : undefined, model: pick('model'), effort: pick('effort'), permission: pick('permission'), at: Number(body.at) || Date.now() })
      return json(res, 200, { ok: true })
    }

    case 'POST /api/notes/clear':
      engine.notes = []
      writeJson(NOTES_FILE, [])
      engine.broadcast()
      return json(res, 200, { ok: true })

    case 'POST /api/notes/test': {
      const body = await readBody(req)
      const p = engine.projects.find((x) => x.id === body.projectId) ?? engine.projects[0]
      const kind = NOTE_KINDS.includes(body.kind as NoteKind) ? (body.kind as NoteKind) : 'deployed'
      if (!p) return json(res, 404, { error: 'no projects yet' })
      engine.addNote(testNote(p, kind))
      engine.broadcast()
      return json(res, 200, { ok: true })
    }

    case 'GET /api/inspect': {
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const pagePath = url.searchParams.get('path') ?? '/'
      if (!p?.url) return json(res, 404, { error: 'this project has no live URL' })
      const key = `${p.id}${pagePath}`
      const hit = engine.inspected.get(key)
      if (hit?.checked && ago(hit.checked) < 30 * MIN) return json(res, 200, hit)
      const info = { path: pagePath, source: 'nav' as const, ...(await inspectPage(new URL(pagePath, p.url + '/').href)) }
      engine.inspected.set(key, info)
      engine.rebuild()
      return json(res, 200, info)
    }

    case 'GET /api/change': {
      const p = engine.projects.find((x) => x.id === url.searchParams.get('project'))
      const t = p?.threads.find((x) => x.id === url.searchParams.get('thread'))
      const repo = engine.repos.find((r) => r.full === p?.repo)
      if (!p || !t || !repo) return json(res, 404, { error: 'thread not found' })
      if (!engine.gh) return json(res, 503, { error: 'GitHub is not connected' })
      try {
        return json(res, 200, await engine.change(p, t, repo))
      } catch (e) {
        return json(res, 502, { error: (e as Error).message })
      }
    }

    case 'POST /api/health': {
      const body = await readBody(req)
      const p = engine.projects.find((x) => x.id === body.projectId)
      if (!p?.url) return json(res, 404, { error: 'this project has no live URL' })
      engine.health.set(p.id, await checkHealth(p.url, engine.health.get(p.id)))
      engine.rebuild()
      return json(res, 200, engine.health.get(p.id))
    }
  }
  return json(res, 404, { error: `no route ${route}` })
}

export function startEngine() {
  engine.start()
}

export function stopEngine() {
  engine.stop()
  stopAll()
}

export function jarvisApi(): Plugin {
  return {
    name: 'jarvis-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next))
      server.httpServer?.once('listening', () => engine.start())
      server.httpServer?.once('close', () => engine.stop())
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next))
      server.httpServer?.once('listening', () => engine.start())
    },
  }
}
