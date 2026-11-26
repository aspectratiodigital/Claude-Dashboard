import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Project, StudioResult, StudioSite } from '../src/data/types.ts'
import type { StudioKrystal } from './config.ts'
import { inspectHtml } from './health.ts'
import { DATA_DIR, log } from './util.ts'
import { detectKind, git, job, lastLine, rebuild, record, run, runtimeOf, setStatus, studioEdits, type Runtime } from './studio.ts'

// Publishing in Studio beyond the push itself: the site's history with roll
// back, where the last push has got to (GitHub's build and deploy, and the live
// Krystal host), deploying to Krystal through cPanel, pushing live at a set
// time, and the checks that run before anything goes live.

// --- History and roll back -------------------------------------------------------------------

export interface HistoryCommit {
  sha: string
  title: string
  author: string
  date: string
  /** made in Studio (its commits say so) */
  studio: boolean
  merge: boolean
}

const deepened = new Map<string, string>()

/** a commit title cut to a length at a word, marked with an ellipsis */
const short = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,.:;–-]+$/, '')}…`)

/** the branch's last commits (Studio's copy only holds the latest, so it fetches more history once per commit) */
export async function history(r: Runtime, token: string | null): Promise<HistoryCommit[]> {
  const head = r.site.sha ?? ''
  if (deepened.get(r.site.projectId) !== head) {
    const shallow = (await run('git', ['rev-parse', '--is-shallow-repository'], r.folder)).out.trim() === 'true'
    if (shallow) await git(['fetch', '--deepen=60', 'origin', r.site.branch], r.folder, token, 90_000)
    deepened.set(r.site.projectId, head)
  }
  const log = await run('git', ['log', '-60', '--format=%H%x1f%an%x1f%cI%x1f%s%x1f%P%x1f%b%x1e'], r.folder, undefined, 30_000, 2_000_000)
  return log.out
    .split('\x1e')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, title, parents, body] = l.split('\x1f')
      return { sha, author, date, title, studio: /Made in Blueprint Studio/.test(body ?? ''), merge: (parents ?? '').trim().split(/\s+/).length > 1 }
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha))
}

/**
 * Undo one past change (a new commit that reverses it), or put the whole site
 * back to how it was at a past commit. Either way the result waits in Studio
 * like a saved edit, for you to check and push live.
 */
export function rollBack(p: Project, sha: string, mode: 'one' | 'back-to') {
  return job(p, mode === 'one' ? 'Undoing that change' : 'Going back to that version', async (r): Promise<StudioResult> => {
    const at = new Date().toISOString()
    if (!/^[0-9a-f]{40}$/.test(sha)) return { kind: 'revert', ok: false, text: 'That isn’t a commit Studio knows.', at }
    if (studioEdits(r.folder).files.length) return { kind: 'revert', ok: false, text: 'Push live or discard your saved edits first, so the roll back is the only change waiting.', at }
    const info = (await run('git', ['log', '-1', '--format=%s%x1f%cI%x1f%P', sha], r.folder)).out.trim().split('\x1f')
    if (!info[0]) return { kind: 'revert', ok: false, text: 'That change isn’t in Studio’s copy. Open History again to load it.', at }
    const [title, date, parents] = info
    if (mode === 'one') {
      const merge = (parents ?? '').trim().split(/\s+/).length > 1
      const rv = await run('git', ['revert', '--no-commit', ...(merge ? ['-m', '1'] : []), sha], r.folder)
      if (!rv.ok) {
        await run('git', ['revert', '--abort'], r.folder)
        await run('git', ['reset', '--hard', 'HEAD'], r.folder)
        return { kind: 'revert', ok: false, text: `That change can’t be undone on its own because later changes build on it. Try “Go back to this version” on the commit before it. (${lastLine(rv.out)})`, at }
      }
    } else {
      const rs = await run('git', ['restore', `--source=${sha}`, '--staged', '--worktree', '--', '.'], r.folder)
      if (!rs.ok) return { kind: 'revert', ok: false, text: `Couldn’t go back to that version. ${lastLine(rs.out)}`, at }
    }
    await run('git', ['reset', '-q'], r.folder)
    await rebuild(r)
    const when = new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    const note = mode === 'one' ? `Undo “${short(title, 60)}” (${sha.slice(0, 7)})` : `Go back to the version from ${when} (“${short(title, 50)}”)`
    await record(r, [note], ['/'])
    if (!studioEdits(r.folder).files.length) return { kind: 'revert', ok: true, text: 'Nothing to change: the site already matches that version.', at }
    return { kind: 'revert', ok: true, text: `${note}. It’s saved, not live yet: check it on the canvas, then push live.`, at }
  })
}

// --- Krystal (cPanel) ------------------------------------------------------------------------

const clean = (k: StudioKrystal) => ({ ...k, host: k.host.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').trim() })

export function krystalProblem(k: StudioKrystal | undefined): string | null {
  if (!k) return 'Not connected'
  const c = clean(k)
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.host)) return 'The cPanel server name doesn’t look right (e.g. uk1.krystal.uk)'
  if (!/^[a-z0-9_.-]{1,32}$/i.test(c.user)) return 'The cPanel username doesn’t look right'
  if (!/^[A-Z0-9]{16,64}$/i.test(c.token)) return 'The API token doesn’t look right (create one in cPanel under Manage API Tokens)'
  if (!/^\/[\w./ -]+$/.test(c.repoRoot) || c.repoRoot.includes('..')) return 'The repository folder should be a full path, like /home/user/repositories/site'
  return null
}

type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function cpanel(k: StudioKrystal, fn: string, params: Record<string, string> = {}): Promise<Any> {
  const c = clean(k)
  const u = new URL(`https://${c.host}:2083/execute/${fn}`)
  for (const [key, v] of Object.entries(params)) u.searchParams.set(key, v)
  const r = await fetch(u.href, { headers: { Authorization: `cpanel ${c.user}:${c.token}` }, signal: AbortSignal.timeout(60_000) })
  if (r.status === 401 || r.status === 403) throw new Error('cPanel refused the username or API token')
  if (!r.ok) throw new Error(`cPanel answered ${r.status}`)
  const j = (await r.json()) as Any
  if (j.status !== 1) throw new Error((j.errors ?? []).join(' ') || 'cPanel said no')
  return j
}

export interface KrystalState {
  branch: string | null
  /** the commit cPanel's copy is on, and the last one it deployed */
  checkedOut: string | null
  deployed: string | null
  deployedAt: string | null
  /** the last deployment, if one is running or failed */
  running: boolean
  failed: boolean
}

const when = (t: unknown) => (typeof t === 'number' || (typeof t === 'string' && /^\d+$/.test(t)) ? new Date(Number(t) * 1000).toISOString() : typeof t === 'string' ? t : null)

export async function krystalStatus(k: StudioKrystal): Promise<KrystalState> {
  const repos = ((await cpanel(k, 'VersionControl/retrieve')).data ?? []) as Any[]
  const repo = repos.find((x) => x.repository_root === clean(k).repoRoot)
  if (!repo) throw new Error(`cPanel has no repository at ${clean(k).repoRoot}`)
  let deploys: Any[] = []
  try {
    deploys = ((await cpanel(k, 'VersionControlDeployment/retrieve')).data ?? []) as Any[]
  } catch {
    /* older cPanel: no deployment list */
  }
  const mine = deploys.filter((d) => d.repository_root === clean(k).repoRoot).sort((a, b) => Number(b.deploy_id ?? 0) - Number(a.deploy_id ?? 0))
  const last = mine[0]
  const ok = mine.find((d) => d.timestamps?.succeeded)
  return {
    branch: repo.branch ?? null,
    checkedOut: repo.last_update?.identifier ?? null,
    deployed: ok?.repository_state?.identifier ?? repo.last_deployment?.repository_state?.identifier ?? null,
    deployedAt: when(ok?.timestamps?.succeeded ?? repo.last_deployment?.timestamps?.succeeded),
    running: !!last && !last.timestamps?.succeeded && !last.timestamps?.failed && !last.timestamps?.canceled,
    failed: !!last?.timestamps?.failed,
  }
}

/** pull the latest from GitHub into cPanel's copy, then run its deployment (.cpanel.yml) */
export async function krystalDeploy(k: StudioKrystal, branch: string): Promise<{ ok: boolean; text: string; state?: KrystalState }> {
  const c = clean(k)
  await cpanel(k, 'VersionControl/update', { repository_root: c.repoRoot, branch: c.branch || branch })
  await cpanel(k, 'VersionControlDeployment/create', { repository_root: c.repoRoot })
  // wait a little for it to finish, so the answer says how it went
  const until = Date.now() + 45_000
  let state: KrystalState | undefined
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 3000))
    try {
      state = await krystalStatus(k)
      if (!state.running) break
    } catch {
      break
    }
  }
  if (state?.failed) return { ok: false, text: 'Krystal ran the deployment but it failed. Check the deployment log in cPanel’s Git Version Control.', state }
  if (state?.running) return { ok: true, text: 'Deploying on Krystal now: it usually takes under a minute.', state }
  return { ok: true, text: `Deployed to Krystal${state?.deployed ? ` (${state.deployed.slice(0, 7)})` : ''}.`, state }
}

// --- Scheduled publishing -------------------------------------------------------------------

export interface Scheduled {
  projectId: string
  at: string
  by: string
}
const SCHEDULE = path.join(DATA_DIR, 'studio-schedule.json')

export function schedules(): Scheduled[] {
  try {
    const v = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'))
    return Array.isArray(v) ? v.filter((x) => x && typeof x.projectId === 'string' && typeof x.at === 'string') : []
  } catch {
    return []
  }
}

function saveSchedules(list: Scheduled[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (list.length) fs.writeFileSync(SCHEDULE, JSON.stringify(list, null, 2))
  else fs.rmSync(SCHEDULE, { force: true })
}

export function scheduleOf(projectId: string): StudioSite['schedule'] {
  const s = schedules().find((x) => x.projectId === projectId)
  return s ? { at: s.at, by: s.by } : null
}

/** book a push live for later (null cancels it) */
export function setSchedule(projectId: string, at: string | null, by: string): { ok: true } | { error: string } {
  const list = schedules().filter((x) => x.projectId !== projectId)
  if (at) {
    const t = Date.parse(at)
    if (!Number.isFinite(t)) return { error: 'That isn’t a date and time' }
    if (t < Date.now() + 60_000) return { error: 'Pick a time at least a minute from now' }
    if (t > Date.now() + 90 * 86_400_000) return { error: 'Pick a time within the next three months' }
    list.push({ projectId, at: new Date(t).toISOString(), by })
  }
  saveSchedules(list)
  return { ok: true }
}

let ticker: NodeJS.Timeout | undefined
/** run each booked push when its time comes (or at once, if Blueprint was closed then) */
export function startScheduler(go: (s: Scheduled) => Promise<void>) {
  if (ticker) return
  let busy = false
  ticker = setInterval(async () => {
    if (busy) return
    const due = schedules().filter((s) => Date.parse(s.at) <= Date.now())
    if (!due.length) return
    busy = true
    saveSchedules(schedules().filter((s) => !due.includes(s) && !due.some((d) => d.projectId === s.projectId && d.at === s.at)))
    for (const s of due) await go(s).catch((e) => log('studio schedule', (e as Error).message))
    busy = false
  }, 20_000)
  ticker.unref?.()
}

// --- Checks before going live ---------------------------------------------------------------

export interface PreCheck {
  level: 'good' | 'improve' | 'fix'
  label: string
  detail: string
  page?: string
}

function fetchLocal(port: number, p: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => method === 'GET' && chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.on('timeout', () => (req.destroy(), resolve({ status: 0, body: '' })))
    req.end()
  })
}

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bsk_live_[0-9a-zA-Z]{20,}/, 'a Stripe secret key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bxox[abpr]-[0-9A-Za-z-]{10,}/, 'a Slack token'],
  [/\bshpat_[0-9a-fA-F]{32}\b/, 'a Shopify admin token'],
  [/(password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'a password or key'],
]

/** what to look at before pushing live: the pages you changed, broken links, big files, and anything secret */
export async function preChecks(r: Runtime, diff: string): Promise<PreCheck[]> {
  const out: PreCheck[] = []
  const port = r.site.port
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  for (const [re, what] of SECRETS) {
    if (re.test(added)) out.push({ level: 'fix', label: 'Nothing secret', detail: `The changes seem to include ${what}. Anything in the site’s files is public once pushed: take it out first.` })
  }
  if (!out.length) out.push({ level: 'good', label: 'Nothing secret', detail: 'No passwords, keys or tokens in the changes.' })
  if (/lorem ipsum/i.test(added)) out.push({ level: 'fix', label: 'Placeholder text', detail: 'The changes include “lorem ipsum” placeholder text.' })

  // big files
  const big: string[] = []
  for (const f of r.site.changed) {
    try {
      const st = fs.statSync(path.join(r.folder, f))
      if (/\.(jpe?g|png|webp|avif|gif)$/i.test(f) && st.size > 600_000) big.push(`${path.basename(f)} (${Math.round(st.size / 1024)} KB)`)
      if (/\.(mp4|webm|mov)$/i.test(f) && st.size > 12_000_000) big.push(`${path.basename(f)} (${(st.size / 1e6).toFixed(1)} MB)`)
    } catch {
      /* removed */
    }
  }
  out.push(big.length ? { level: 'improve', label: 'File sizes', detail: `Large files slow the page down: ${big.join(', ')}.` } : { level: 'good', label: 'File sizes', detail: 'No oversized photos or videos added.' })

  if (!port) return out
  const pages = (r.site.touched.length ? r.site.touched : ['/']).slice(0, 12)
  const links = new Set<string>()
  for (const p of pages) {
    const res = await fetchLocal(port, p)
    if (res.status >= 400 || !res.body) {
      out.push({ level: 'fix', label: 'Page opens', detail: `${p} answers with error ${res.status || 'no answer'}.`, page: p })
      continue
    }
    const t = inspectHtml(res.body, `https://example.com${p}`)
    const bad = t.checks.filter((c) => ['title', 'description', 'h1', 'alt'].includes(c.id) && !c.pass)
    out.push(
      bad.length
        ? { level: 'improve', label: `Search details on ${p === '/' ? 'the home page' : p}`, detail: bad.map((c) => `${c.label}: ${c.detail ?? 'needs attention'}`).join(' · '), page: p }
        : { level: 'good', label: `Search details on ${p === '/' ? 'the home page' : p}`, detail: 'Title, description, one main heading and alt text all present.', page: p },
    )
    for (const m of res.body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
      const h = m[1].trim()
      if (/^(https?:)?\/\//i.test(h) || /^(mailto|tel|sms|javascript|whatsapp):/i.test(h) || !h.startsWith('/') || h.startsWith('/__studio/')) continue
      links.add(h.split('?')[0])
    }
  }
  const list = [...links].slice(0, 120)
  const broken: string[] = []
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let h = list.shift(); h !== undefined; h = list.shift()) {
        let s = (await fetchLocal(port, h, 'HEAD')).status
        if (s >= 400 || s === 0) s = (await fetchLocal(port, h)).status
        if (s >= 400 || s === 0) broken.push(h)
      }
    }),
  )
  out.push(broken.length ? { level: 'fix', label: 'Links', detail: `Broken links on the changed pages: ${broken.slice(0, 8).join(', ')}${broken.length > 8 ? '…' : ''}` } : { level: 'good', label: 'Links', detail: `All ${links.size} links on the changed pages open.` })
  return out
}

/** the latest commit Studio's copy is on, refreshed from GitHub (after a push, that's what's deploying) */
export function siteOf(projectId: string) {
  const r = runtimeOf(projectId)
  return r ? { r, kind: detectKind(r.folder).kind } : null
}

export { setStatus }
