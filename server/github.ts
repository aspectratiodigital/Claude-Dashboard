import type { Change, Commit, Deployment, DeployState, Issue, Page, Pull, Run, RunState, Thread } from '../src/data/types.ts'
import { cleanBody, fallbackDescription } from '../src/data/describe.ts'
import { log } from './util.ts'

// Minimal GitHub REST client. Every GET is conditional (ETag), and GitHub does
// not count 304 Not Modified answers against the rate limit, so polling every
// repo once a minute costs almost nothing once the cache is warm.

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

export class GitHub {
  private cache = new Map<string, { etag: string; data: Json }>()
  rate: { remaining: number; limit: number; reset: number } | null = null
  constructor(public token: string | null) {}

  async get<T = Json>(path: string, accept = 'application/vnd.github+json'): Promise<{ data: T | null; status: number; fresh: boolean }> {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`
    const key = `${accept} ${url}`
    const hit = this.cache.get(key)
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jarvis-dashboard',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    if (hit) headers['If-None-Match'] = hit.etag
    let res: Response
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      throw new Error(`GitHub unreachable (${(e as Error).message})`)
    }
    const rem = res.headers.get('x-ratelimit-remaining')
    if (rem !== null) {
      this.rate = {
        remaining: Number(rem),
        limit: Number(res.headers.get('x-ratelimit-limit') ?? 0),
        reset: Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000,
      }
    }
    if (res.status === 304 && hit) return { data: hit.data as T, status: 200, fresh: false }
    if (res.status === 401) throw new Error('GitHub rejected the token (401). Paste a new one in Settings.')
    if (res.status === 403 && this.rate?.remaining === 0) throw new Error('GitHub rate limit reached, waiting for it to reset.')
    if (!res.ok) return { data: null, status: res.status, fresh: true }
    const data = accept.includes('raw') ? await res.text() : await res.json()
    const etag = res.headers.get('etag')
    if (etag) this.cache.set(key, { etag, data })
    return { data: data as T, status: res.status, fresh: true }
  }
}

export interface RepoInfo {
  name: string
  full: string
  owner: string
  description: string
  private: boolean
  language: string | null
  homepage: string | null
  defaultBranch: string
  pushedAt: string
  hasPages: boolean
  archived: boolean
  fork: boolean
}

export async function whoami(gh: GitHub): Promise<string | null> {
  if (!gh.token) return null
  const r = await gh.get('/user')
  return r.data?.login ?? null
}

export async function listRepos(gh: GitHub, owner: string, login: string | null, include: string[] = []): Promise<RepoInfo[]> {
  const out: Json[] = []
  if (include.length) {
    // an explicit list: fetch just those repos
    for (const name of include) {
      const r = await gh.get<Json>(`/repos/${name.includes('/') ? name : `${owner}/${name}`}`)
      if (r.data) out.push(r.data)
    }
    return out.map(toInfo)
  }
  if (gh.token) {
    // /user/repos includes private repos you own or collaborate on, across orgs
    for (let page = 1; page <= 5; page++) {
      const r = await gh.get<Json[]>(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`)
      if (!r.data?.length) break
      out.push(...r.data)
      if (r.data.length < 100) break
    }
  }
  const mine = out.filter((r) => r.owner?.login?.toLowerCase() === owner.toLowerCase())
  if (!mine.length) {
    // public fallback, or an org the token can only see through /orgs
    const isUser = login?.toLowerCase() === owner.toLowerCase()
    const r = await gh.get<Json[]>(isUser ? `/users/${owner}/repos?per_page=100&sort=pushed` : `/orgs/${owner}/repos?per_page=100&sort=pushed&type=all`)
    const r2 = r.data ? r : await gh.get<Json[]>(`/users/${owner}/repos?per_page=100&sort=pushed`)
    mine.push(...(r2.data ?? []))
  }
  return mine.map(toInfo)
}

function toInfo(r: Json): RepoInfo {
  return {
    name: r.name,
    full: r.full_name,
    owner: r.owner.login,
    description: r.description ?? '',
    private: !!r.private,
    language: r.language ?? null,
    homepage: r.homepage || null,
    defaultBranch: r.default_branch ?? 'main',
    pushedAt: r.pushed_at ?? r.updated_at,
    hasPages: !!r.has_pages,
    archived: !!r.archived,
    fork: !!r.fork,
  }
}

// --- Claude fingerprints -------------------------------------------------------

const SESSION_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/
const THREAD_RE = /https:\/\/claude\.ai\/code\/project\/chan_[A-Za-z0-9]+\?thread=cmsg_[A-Za-z0-9]+/
const PROJECT_RE = /https:\/\/claude\.ai\/code\/project\/chan_[A-Za-z0-9]+/

export function claudeLinks(text: string | null | undefined) {
  const t = text ?? ''
  return {
    session: t.match(SESSION_RE)?.[0],
    thread: t.match(THREAD_RE)?.[0],
    project: t.match(PROJECT_RE)?.[0],
  }
}

const isClaudeText = (t: string) => /co-authored-by:\s*claude|claude-session:|claude\.ai\/code|generated with \[claude code\]/i.test(t)

// --- Per-repo data ----------------------------------------------------------------

export interface RepoData {
  commits: Commit[]
  activity: number[]
  commitsWeek: number
  pulls: Pull[]
  issues: Issue[]
  runs: Run[]
  deployments: Deployment[]
  branches: string[]
  framework: string
  host: string | null
  port: number | null
  cname: string | null
  pagesUrl: string | null
  repoPages: Page[]
  deployPending: boolean
  claudeProjectUrl: string | null
  /** last push time of each claude/ branch */
  branchPushed: Record<string, string>
}

// A commit never changes, so its date is fetched once per SHA and kept.
const commitDates = new Map<string, string>()

async function commitDate(gh: GitHub, base: string, sha: string): Promise<string | undefined> {
  if (!sha) return undefined
  const hit = commitDates.get(sha)
  if (hit) return hit
  const r = await gh.get<Json>(`${base}/commits/${sha}`)
  const date: string | undefined = r.data?.commit?.committer?.date ?? r.data?.commit?.author?.date
  if (date) commitDates.set(sha, date)
  return date
}

const deployFinal = new Map<number, { state: DeployState; url: string | null; logUrl: string | null }>()

export async function loadRepo(gh: GitHub, repo: RepoInfo, opts: { light?: boolean; prev?: RepoData }): Promise<RepoData> {
  const base = `/repos/${repo.full}`
  const prev = opts.prev
  // light refresh: only the fast-changing things (CI + deploys) for active repos
  if (opts.light && prev) {
    const [runs, deploys] = await Promise.all([loadRuns(gh, base), loadDeployments(gh, base)])
    const pulls = withChecks(prev.pulls, runs)
    return { ...prev, runs, deployments: deploys, pulls }
  }

  const [commitsR, pullsR, issuesR, runs, deployments, branchesR, rootR, statusR] = await Promise.all([
    gh.get<Json[]>(`${base}/commits?sha=${encodeURIComponent(repo.defaultBranch)}&per_page=100`),
    gh.get<Json[]>(`${base}/pulls?state=all&sort=updated&direction=desc&per_page=20`),
    gh.get<Json[]>(`${base}/issues?state=open&per_page=40`),
    loadRuns(gh, base),
    loadDeployments(gh, base),
    gh.get<Json[]>(`${base}/branches?per_page=100`),
    gh.get<Json[]>(`${base}/contents?ref=${encodeURIComponent(repo.defaultBranch)}`),
    gh.get<Json>(`${base}/commits/${encodeURIComponent(repo.defaultBranch)}/status`),
  ])

  // commits + 14 day activity
  const rawCommits = commitsR.data ?? []
  const commits: Commit[] = rawCommits.slice(0, 30).map((c) => {
    const msg: string = c.commit?.message ?? ''
    const links = claudeLinks(msg)
    return {
      sha: c.sha.slice(0, 7),
      message: msg.split('\n')[0],
      author: c.author?.login ?? c.commit?.author?.name ?? 'unknown',
      date: c.commit?.committer?.date ?? c.commit?.author?.date,
      url: c.html_url,
      claude: isClaudeText(msg) || /claude/i.test(c.author?.login ?? ''),
      sessionUrl: links.session,
    }
  })
  const activity = new Array(14).fill(0)
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  let commitsWeek = 0
  for (const c of rawCommits) {
    const d = Date.parse(c.commit?.committer?.date ?? c.commit?.author?.date)
    const days = Math.floor((today.getTime() - d) / 86_400_000)
    if (days >= 0 && days < 14) activity[13 - days]++
    if (Date.now() - d < 7 * 86_400_000) commitsWeek++
  }

  let claudeProjectUrl: string | null = null
  const pulls: Pull[] = withChecks(
    (pullsR.data ?? []).map((p) => {
      const links = claudeLinks(p.body)
      if (!claudeProjectUrl && links.project) claudeProjectUrl = links.project
      return {
        number: p.number,
        title: p.title,
        branch: p.head?.ref ?? '',
        author: p.user?.login ?? '',
        draft: !!p.draft,
        state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
        updated: p.updated_at,
        url: p.html_url,
        claude: (p.head?.ref ?? '').startsWith('claude/') || isClaudeText(p.body ?? ''),
        threadUrl: links.thread,
        sessionUrl: links.session,
        checks: 'none',
        reviewRequested: (p.requested_reviewers?.length ?? 0) > 0 && p.state === 'open',
        headSha: p.head?.sha ?? '',
      } satisfies Pull
    }),
    runs,
  )

  const issues: Issue[] = (issuesR.data ?? [])
    .filter((i) => !i.pull_request)
    .map((i) => {
      const labels: string[] = (i.labels ?? []).map((l: Json) => (typeof l === 'string' ? l : l.name))
      return {
        number: i.number,
        title: i.title,
        labels,
        author: i.user?.login ?? '',
        created: i.created_at,
        url: i.html_url,
        bug: labels.some((l) => /bug|broken|error|crash|urgent/i.test(l)),
      }
    })

  const branches = (branchesR.data ?? []).map((b) => b.name as string)

  // when each Claude PR / branch was last pushed (one request per new commit, then cached)
  const branchPushed: Record<string, string> = {}
  await Promise.all([
    ...pulls
      .filter((p) => p.claude)
      .slice(0, 12)
      .map(async (p) => {
        p.pushed = await commitDate(gh, base, p.headSha ?? '').catch(() => undefined)
      }),
    ...(branchesR.data ?? [])
      .filter((b) => String(b.name).startsWith('claude/'))
      .slice(0, 12)
      .map(async (b) => {
        const d = await commitDate(gh, base, b.commit?.sha).catch(() => undefined)
        if (d) branchPushed[b.name] = d
      }),
  ])

  // framework / host from the root of the repo
  const names = (rootR.data ?? []).map((f) => String(f.name))
  const { framework, port } = detectFramework(names, repo.language)
  let host = detectHost(names)
  let cname: string | null = prev?.cname ?? null
  if (names.includes('CNAME')) {
    const r = await gh.get<string>(`${base}/contents/CNAME?ref=${encodeURIComponent(repo.defaultBranch)}`, 'application/vnd.github.raw')
    cname = typeof r.data === 'string' ? r.data.trim().split('\n')[0] || null : cname
  }
  let pagesUrl: string | null = prev?.pagesUrl ?? null
  if (repo.hasPages) {
    const r = await gh.get<Json>(`${base}/pages`)
    pagesUrl = r.data?.html_url ?? pagesUrl
    host = host ?? 'GitHub Pages'
  }
  const contexts: Json[] = statusR.data?.statuses ?? []
  for (const c of contexts) {
    if (/vercel/i.test(c.context)) host = host ?? 'Vercel'
    if (/netlify/i.test(c.context)) host = host ?? 'Netlify'
    if (/cloudflare/i.test(c.context)) host = host ?? 'Cloudflare Pages'
  }
  if (!host) {
    const d = deployments[0]
    if (d && /vercel/i.test(d.environment)) host = 'Vercel'
  }
  const deployPending = contexts.some((c) => c.state === 'pending' && /vercel|netlify|cloudflare|deploy|pages/i.test(c.context))

  // pages from the repo tree, refreshed only when the default branch moves
  let repoPages = prev?.repoPages ?? []
  const head = rawCommits[0]?.sha
  if (head && (!prev || prev.commits[0]?.sha !== head.slice(0, 7) || !repoPages.length)) {
    const t = await gh.get<Json>(`${base}/git/trees/${head}?recursive=1`)
    if (t.data?.tree) repoPages = pagesFromTree(t.data.tree.map((x: Json) => String(x.path)), framework)
  }

  return {
    commits,
    activity,
    commitsWeek,
    pulls,
    issues,
    runs,
    deployments,
    branches,
    framework,
    host,
    port,
    cname,
    pagesUrl,
    repoPages,
    deployPending,
    claudeProjectUrl,
    branchPushed,
  }
}

async function loadRuns(gh: GitHub, base: string): Promise<Run[]> {
  const r = await gh.get<Json>(`${base}/actions/runs?per_page=25`)
  return (r.data?.workflow_runs ?? []).map((w: Json) => {
    let status: RunState
    if (w.status !== 'completed') status = w.status === 'queued' || w.status === 'waiting' || w.status === 'pending' ? 'queued' : 'running'
    else if (w.conclusion === 'success') status = 'success'
    else if (w.conclusion === 'cancelled') status = 'cancelled'
    else if (w.conclusion === 'skipped' || w.conclusion === 'neutral') status = 'skipped'
    else status = 'failure'
    const start = Date.parse(w.run_started_at ?? w.created_at)
    const end = Date.parse(w.updated_at)
    return {
      id: w.id,
      name: w.name ?? w.display_title ?? 'Workflow',
      branch: w.head_branch ?? '',
      event: w.event,
      status,
      started: w.run_started_at ?? w.created_at,
      durationS: w.status === 'completed' ? Math.max(0, Math.round((end - start) / 1000)) : null,
      url: w.html_url,
      sha: String(w.head_sha ?? '').slice(0, 7),
    } satisfies Run
  })
}

async function loadDeployments(gh: GitHub, base: string): Promise<Deployment[]> {
  const r = await gh.get<Json[]>(`${base}/deployments?per_page=8`)
  const list = r.data ?? []
  return Promise.all(
    list.map(async (d, i): Promise<Deployment> => {
      let st = deployFinal.get(d.id)
      if (!st && i < 5) {
        const s = await gh.get<Json[]>(`${base}/deployments/${d.id}/statuses?per_page=1`)
        const top = s.data?.[0]
        const state: DeployState = (top?.state as DeployState) ?? 'pending'
        st = { state, url: top?.environment_url || null, logUrl: top?.log_url || top?.target_url || null }
        if (['success', 'failure', 'error', 'inactive'].includes(state)) deployFinal.set(d.id, st)
      }
      const env: string = d.environment ?? ''
      return {
        id: d.id,
        environment: env,
        state: st?.state ?? 'inactive',
        url: st?.url ?? null,
        logUrl: st?.logUrl ?? null,
        created: d.created_at,
        ref: d.ref,
        production: !!d.production_environment || /^(production|github-pages|prod)/i.test(env),
      }
    }),
  )
}

function withChecks(pulls: Pull[], runs: Run[]): Pull[] {
  return pulls.map((p) => {
    const mine = runs.filter((r) => r.branch === p.branch)
    if (!mine.length) return { ...p, checks: 'none' }
    const latestSha = mine[0].sha
    const latest = mine.filter((r) => r.sha === latestSha)
    const checks = latest.some((r) => r.status === 'running' || r.status === 'queued')
      ? 'running'
      : latest.some((r) => r.status === 'failure')
        ? 'fail'
        : 'pass'
    return { ...p, checks }
  })
}

function detectFramework(names: string[], language: string | null): { framework: string; port: number | null } {
  const has = (re: RegExp) => names.some((n) => re.test(n))
  if (has(/^astro\.config\./)) return { framework: 'Astro', port: 4321 }
  if (has(/^next\.config\./)) return { framework: 'Next.js', port: 3000 }
  if (has(/^nuxt\.config\./)) return { framework: 'Nuxt', port: 3000 }
  if (has(/^svelte\.config\./)) return { framework: 'SvelteKit', port: 5173 }
  if (has(/^remix\.config\./)) return { framework: 'Remix', port: 3000 }
  if (has(/^gatsby-config\./)) return { framework: 'Gatsby', port: 8000 }
  if (has(/^angular\.json$/)) return { framework: 'Angular', port: 4200 }
  if (has(/^vite\.config\./)) return { framework: 'Vite', port: 5173 }
  if (has(/^(wp-content|wp-config\.php)$/)) return { framework: 'WordPress', port: 8080 }
  if (has(/^_config\.ya?ml$/)) return { framework: 'Jekyll', port: 4000 }
  if (has(/^(hugo\.(toml|ya?ml|json))$/)) return { framework: 'Hugo', port: 1313 }
  if (has(/^app\.json$/) && has(/^(expo|App\.(tsx|js))/)) return { framework: 'Expo app', port: 8081 }
  if (has(/^package\.json$/) && has(/^(server|index)\.(js|ts|mjs)$/)) return { framework: 'Node service', port: 3000 }
  if (has(/^index\.html?$/)) return { framework: 'Static site', port: null }
  if (has(/^package\.json$/)) return { framework: language ?? 'Node', port: 3000 }
  return { framework: language ?? 'Repository', port: null }
}

function detectHost(names: string[]): string | null {
  if (names.includes('netlify.toml')) return 'Netlify'
  if (names.includes('vercel.json') || names.includes('.vercel')) return 'Vercel'
  if (names.includes('wrangler.toml') || names.includes('wrangler.json')) return 'Cloudflare'
  if (names.includes('firebase.json')) return 'Firebase'
  if (names.includes('CNAME')) return 'GitHub Pages'
  return null
}

/** Turns a repo file list into the site's routes, for the common frameworks. */
export function pagesFromTree(paths: string[], framework: string): Page[] {
  const out = new Map<string, Page>()
  const add = (p: string, file: string) => {
    let route = '/' + p.replace(/\/index$/, '').replace(/^index$/, '')
    route = route.replace(/\/+/g, '/')
    if (route.length > 1) route = route.replace(/\/$/, '')
    if (!out.has(route)) out.set(route, { path: route, source: 'repo', file })
  }
  for (const f of paths) {
    if (/(^|\/)(node_modules|dist|build|\.next|\.astro|vendor|coverage)\//.test(f)) continue
    let m: RegExpMatchArray | null
    if ((m = f.match(/^(?:src\/)?pages\/(.+)\.(astro|md|mdx|html|jsx?|tsx?|vue|svelte)$/))) {
      if (/(^|\/)(_|api\/)/.test(m[1])) continue
      add(m[1], f)
    } else if ((m = f.match(/^(?:src\/)?app\/(.*?)\/?page\.(jsx?|tsx?|mdx)$/))) {
      add(m[1].replace(/\([^)]*\)\/?/g, '').replace(/\/$/, '') || 'index', f)
    } else if ((m = f.match(/^src\/routes\/(.*?)\/?\+page\.svelte$/))) {
      add(m[1].replace(/\([^)]*\)\/?/g, '').replace(/\/$/, '') || 'index', f)
    } else if (/Static site|Jekyll|Hugo|HTML/.test(framework) && (m = f.match(/^(?:public\/|docs\/)?((?:[^/]+\/){0,2}[^/]+)\.html?$/))) {
      if (/^(404|500)$/.test(m[1])) continue
      add(m[1], f)
    }
  }
  return [...out.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, 60)
}

export function logRate(gh: GitHub) {
  if (gh.rate) log(`GitHub rate limit: ${gh.rate.remaining}/${gh.rate.limit}`)
}

// --- What one thread's push changed (fetched when you open it) ---------------------------

const toFiles = (list: Json[] | undefined): Change['files'] =>
  (list ?? []).map((f) => ({
    path: String(f.filename),
    status: f.status === 'added' || f.status === 'removed' || f.status === 'renamed' ? f.status : 'modified',
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
  }))

const toCommits = (list: Json[] | undefined): Change['commits'] =>
  (list ?? []).map((c) => ({
    sha: String(c.sha).slice(0, 7),
    message: String(c.commit?.message ?? '').split('\n')[0],
    date: c.commit?.committer?.date ?? c.commit?.author?.date ?? '',
    url: c.html_url ?? '',
  }))

function finish(files: Change['files'], commits: Change['commits'], body: string | null, url: string | null): Change {
  // newest commit first, like the rest of the dashboard
  const sorted = [...commits].sort((a, b) => b.date.localeCompare(a.date))
  const clean = cleanBody(body)
  return {
    summary: fallbackDescription(clean, sorted),
    by: 'pr',
    body: clean,
    commits: sorted,
    files: [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)),
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    url,
  }
}

export async function loadChange(gh: GitHub, repo: RepoInfo, t: Thread, d: RepoData | undefined): Promise<Change> {
  const base = `/repos/${repo.full}`
  if (t.prNumber) {
    const [pr, commits, files] = await Promise.all([
      gh.get<Json>(`${base}/pulls/${t.prNumber}`),
      gh.get<Json[]>(`${base}/pulls/${t.prNumber}/commits?per_page=100`),
      gh.get<Json[]>(`${base}/pulls/${t.prNumber}/files?per_page=100`),
    ])
    return finish(toFiles(files.data ?? []), toCommits(commits.data ?? []), pr.data?.body ?? null, t.prUrl ?? pr.data?.html_url ?? null)
  }
  if (t.branch && t.branch !== repo.defaultBranch) {
    const r = await gh.get<Json>(`${base}/compare/${encodeURIComponent(repo.defaultBranch)}...${encodeURIComponent(t.branch)}`)
    return finish(toFiles(r.data?.files), toCommits(r.data?.commits), null, r.data?.html_url ?? null)
  }
  // a session that committed straight to the default branch: add up its commits
  const own = (d?.commits ?? []).filter((c) => c.sessionUrl && c.sessionUrl === t.id).slice(0, 10)
  const full = await Promise.all(own.map((c) => gh.get<Json>(`${base}/commits/${c.sha}`)))
  const files = new Map<string, Change['files'][number]>()
  for (const r of full)
    for (const f of toFiles(r.data?.files)) {
      const was = files.get(f.path)
      files.set(f.path, was ? { ...f, status: was.status === 'added' ? 'added' : f.status, additions: was.additions + f.additions, deletions: was.deletions + f.deletions } : f)
    }
  return finish([...files.values()], toCommits(full.map((r) => r.data).filter(Boolean)), null, own[0]?.url ?? null)
}
