import type { Commit, Health, Note, NoteKind, Page, Project, Pull, Run, Status, Thread } from './types'
import { LEVEL_OF } from './derive'

// Demo data, used until GitHub is connected (or when the app runs without its
// local API). Same shape as the real thing, plus a simulator that fires a
// notification every few seconds so every visual can be seen working.

interface Seed {
  name: string
  repo: string
  framework: string
  host: string
  accent: string
  url: string
  status: Status
  reason: string
  commits: number
  pages: string[]
}

const SEEDS: Seed[] = [
  { name: 'Aspect Ratio Digital', repo: 'ard-site', framework: 'Astro', host: 'Netlify', accent: '#7c5cff', url: 'https://aspectratio.digital', status: 'live', reason: 'Deployed 2h ago', commits: 17, pages: ['/', '/work', '/services', '/about', '/contact', '/work/kiln-coffee'] },
  { name: 'Kiln Coffee Roasters', repo: 'kiln-coffee', framework: 'Next.js', host: 'Vercel', accent: '#e0873f', url: 'https://kilncoffee.co.uk', status: 'building', reason: 'CI running on feature/subscriptions', commits: 24, pages: ['/', '/shop', '/subscriptions', '/origins', '/cart', '/journal'] },
  { name: 'Northfield Dental', repo: 'northfield-dental', framework: 'Astro', host: 'Netlify', accent: '#1aa6b7', url: 'https://northfielddental.com', status: 'live', reason: 'Deployed yesterday', commits: 3, pages: ['/', '/treatments', '/treatments/invisalign', '/team', '/book'] },
  { name: 'Volt Gyms', repo: 'volt-gyms', framework: 'Next.js', host: 'Vercel', accent: '#c6f432', url: 'https://voltgyms.fit', status: 'broken', reason: 'CI is failing on main', commits: 31, pages: ['/', '/timetable', '/locations', '/locations/leeds', '/join', '/classes'] },
  { name: 'Marlow Estates', repo: 'marlow-estates', framework: 'Astro', host: 'Cloudflare', accent: '#3d6b4f', url: 'https://marlowestates.co.uk', status: 'attention', reason: '2 open issues', commits: 9, pages: ['/', '/buy', '/rent', '/valuation', '/contact'] },
  { name: 'Harbour Yoga', repo: 'harbour-yoga', framework: 'Static site', host: 'GitHub Pages', accent: '#e86f5a', url: 'https://harbouryoga.studio', status: 'deploying', reason: 'Deploying production', commits: 14, pages: ['/', '/classes', '/teachers', '/retreats'] },
  { name: 'Ferrous Works', repo: 'ferrous-works', framework: 'WordPress', host: 'Hosting', accent: '#ff5a1f', url: 'https://ferrousworks.co', status: 'quiet', reason: 'No changes in the last month', commits: 0, pages: ['/', '/projects', '/capabilities', '/contact'] },
  { name: 'Claude Dashboard', repo: 'Claude-Dashboard', framework: 'Vite', host: 'Local', accent: '#4fe3ff', url: '', status: 'live', reason: 'This very app', commits: 6, pages: ['/'] },
]

const MIN = 60_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

const MESSAGES = [
  'Tighten hero spacing on mobile',
  'Add structured data to the home page',
  'Lazy-load gallery images',
  'Fix footer links',
  'New case study page',
  'Swap hero video for poster on slow connections',
  'Contact form: better error states',
  'Update opening hours',
  'Refactor nav into a component',
  'Compress images in /public',
]

function make(seed: Seed, i: number): Project {
  const r = rng(i * 17 + 3)
  const id = seed.repo.toLowerCase()
  const fullRepo = `aspectratiodigital/${seed.repo}`
  const activity = Array.from({ length: 14 }, (_, d) => Math.round(r() * (seed.commits / 4) * (d > 9 ? 1.4 : 0.8)))
  const commits: Commit[] = Array.from({ length: 8 }, (_, k) => ({
    sha: Math.floor(r() * 0xfffffff).toString(16).padStart(7, '0'),
    message: MESSAGES[(i + k) % MESSAGES.length],
    author: k % 2 ? 'aspectratiodigital' : 'claude',
    date: iso((k * 5 + 1) * 60 * MIN * (1 + r())),
    url: `https://github.com/${fullRepo}`,
    claude: k % 2 === 0,
    sessionUrl: k % 2 === 0 ? 'https://claude.ai/code' : undefined,
  }))
  const runStatus = seed.status === 'building' ? 'running' : seed.status === 'broken' ? 'failure' : 'success'
  const runs: Run[] = Array.from({ length: 6 }, (_, k) => ({
    id: i * 100 + k,
    name: k % 2 ? 'Lighthouse CI' : 'Build',
    branch: k === 0 && seed.status === 'building' ? 'feature/subscriptions' : 'main',
    event: 'push',
    status: k === 0 ? runStatus : r() > 0.15 ? 'success' : 'failure',
    started: iso((k * 3 + 0.3) * 60 * MIN),
    durationS: k === 0 && runStatus === 'running' ? null : Math.round(40 + r() * 90),
    url: `https://github.com/${fullRepo}/actions`,
    sha: commits[k % commits.length].sha,
  }))
  const pulls: Pull[] = [
    {
      number: 40 + i,
      title: MESSAGES[(i + 3) % MESSAGES.length],
      branch: `claude/${seed.repo.toLowerCase()}-polish`,
      author: 'aspectratiodigital',
      draft: false,
      state: 'open',
      updated: iso(35 * MIN * (i + 1)),
      url: `https://github.com/${fullRepo}/pulls`,
      claude: true,
      threadUrl: 'https://claude.ai/code',
      checks: seed.status === 'broken' ? 'fail' : 'pass',
      reviewRequested: i % 3 === 0,
    },
    {
      number: 30 + i,
      title: MESSAGES[(i + 5) % MESSAGES.length],
      branch: `claude/${seed.repo.toLowerCase()}-perf`,
      author: 'aspectratiodigital',
      draft: false,
      state: 'merged',
      updated: iso(26 * 60 * MIN),
      url: `https://github.com/${fullRepo}/pulls`,
      claude: true,
      checks: 'pass',
      reviewRequested: false,
    },
  ]
  const threads: Thread[] = [
    {
      id: `t-${id}-1`,
      title: pulls[0].title,
      source: 'claude-web',
      status: seed.status === 'building' ? 'working' : 'open',
      updated: pulls[0].updated,
      branch: pulls[0].branch,
      url: 'https://claude.ai/code',
      prUrl: pulls[0].url,
      prNumber: pulls[0].number,
      commits: 4,
    },
    { id: `t-${id}-2`, title: pulls[1].title, source: 'claude-web', status: 'merged', updated: pulls[1].updated, branch: pulls[1].branch, url: 'https://claude.ai/code', prUrl: pulls[1].url, prNumber: pulls[1].number, commits: 7 },
    { id: `t-${id}-3`, title: `Plan the ${seed.pages[1] ?? 'home'} page`, source: 'claude-local', status: 'idle', updated: iso(3 * 24 * 60 * MIN), commits: 0, summary: 'Claude Code on this computer', resume: 'claude --resume demo' },
  ]
  const ms = Math.round(180 + r() * 600)
  const health: Health = {
    url: seed.url || null,
    checked: seed.url ? iso(2 * MIN) : null,
    up: seed.url ? true : null,
    code: seed.url ? 200 : null,
    ms: seed.url ? ms : null,
    bytes: seed.url ? Math.round(30_000 + r() * 90_000) : null,
    history: seed.url ? Array.from({ length: 30 }, () => Math.round(ms * (0.7 + r() * 0.6))) : [],
    uptimePct: seed.url ? 100 : null,
    seoScore: seed.url ? Math.round(57 + r() * 43) : null,
    checks: seed.url
      ? [
          { id: 'title', category: 'seo', label: 'Page title', pass: true, detail: `${seed.name} | ${seed.framework}` },
          { id: 'description', category: 'seo', label: 'Meta description', pass: r() > 0.3, detail: '128 chars' },
          { id: 'h1', category: 'seo', label: 'One H1 heading', pass: true, detail: '1 found' },
          { id: 'canonical', category: 'seo', label: 'Canonical link', pass: r() > 0.4 },
          { id: 'og', category: 'seo', label: 'Social share tags', pass: r() > 0.5 },
          { id: 'schema', category: 'seo', label: 'Structured data', pass: r() > 0.5 },
          { id: 'alt', category: 'accessibility', label: 'Images have alt text', pass: r() > 0.4, detail: '11 of 12' },
          { id: 'viewport', category: 'bestPractices', label: 'Mobile viewport tag', pass: true },
          { id: 'https', category: 'bestPractices', label: 'Served over HTTPS', pass: true },
        ]
      : [],
    themeColor: seed.accent,
    psi: null,
  }
  const pages: Page[] = seed.pages.map((p, k) => ({
    path: p,
    source: k === 0 ? 'sitemap' : 'repo',
    file: `src/pages${p === '/' ? '/index' : p}.astro`,
    title: k === 0 ? `${seed.name}` : `${p.split('/').pop()!.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} | ${seed.name}`,
  }))
  return {
    id,
    name: seed.name,
    repo: fullRepo,
    description: '',
    private: true,
    language: 'TypeScript',
    framework: seed.framework,
    host: seed.host,
    defaultBranch: 'main',
    url: seed.url || null,
    previewUrl: seed.url || null,
    localPort: seed.framework === 'Astro' ? 4321 : seed.framework === 'Next.js' ? 3000 : 5173,
    claudeProjectUrl: 'https://claude.ai/code',
    status: seed.status,
    reason: seed.reason,
    pushedAt: commits[0].date,
    accent: seed.accent,
    activity,
    commitsWeek: seed.commits,
    branches: ['main', ...pulls.map((p) => p.branch)],
    commits,
    pulls,
    issues:
      seed.status === 'attention' || seed.status === 'broken'
        ? [
            { number: 12 + i, title: 'Contact form not sending on iOS Safari', labels: ['bug'], author: 'client', created: iso(5 * 60 * MIN), url: `https://github.com/${fullRepo}/issues`, bug: true },
            { number: 13 + i, title: 'Add Google Business reviews widget', labels: ['enhancement'], author: 'aspectratiodigital', created: iso(30 * 60 * MIN), url: `https://github.com/${fullRepo}/issues`, bug: false },
          ]
        : [],
    runs,
    deployments: [
      {
        id: i * 10,
        environment: 'Production',
        state: seed.status === 'deploying' ? 'in_progress' : 'success',
        url: seed.url || null,
        logUrl: null,
        created: iso(2 * 60 * MIN),
        ref: 'main',
        production: true,
      },
    ],
    threads,
    pages,
    health,
    quality: {
      ciPassRate: seed.status === 'broken' ? 0.62 : 0.9 + r() * 0.1,
      avgBuildS: Math.round(50 + r() * 60),
      openBugs: seed.status === 'attention' || seed.status === 'broken' ? 1 : 0,
      openPRs: 1,
      staleBranches: 1,
      grade: seed.status === 'broken' ? 'D' : seed.status === 'attention' ? 'B' : 'A',
    },
  }
}

export function demoProjects(): Project[] {
  return SEEDS.map(make)
}

// --- Simulator -------------------------------------------------------------------------------

const SEQUENCES: NoteKind[][] = [
  ['build', 'build-ok', 'deploying', 'deployed'],
  ['claude', 'push', 'pr'],
  ['build', 'build-fail'],
  ['issue'],
  ['deploying', 'deploy-fail'],
  ['review', 'merged', 'deploying', 'deployed'],
  ['down', 'up'],
  ['perf'],
]

const TEXT: Record<NoteKind, (n: string) => [string, string]> = {
  build: (n) => [`Building ${n}`, 'Build started on main'],
  'build-ok': (n) => [`${n} build passed`, 'Build on main in 1m 04s'],
  'build-fail': (n) => [`${n} build failed`, 'Type error in src/components/Hero.tsx'],
  deploying: (n) => [`Deploying ${n}`, 'Production from main'],
  deployed: (n) => [`${n} is live`, 'Production deployed from main'],
  'deploy-fail': (n) => [`${n} deploy failed`, 'Netlify build exited with code 2'],
  issue: (n) => [`New issue on ${n}`, '#58 Booking button overlaps footer on iPhone SE'],
  pr: (n) => [`Claude opened a PR on ${n}`, '#59 Compress hero images and add width/height'],
  merged: (n) => [`Merged into ${n}`, '#57 New testimonials section'],
  review: (n) => [`Review requested on ${n}`, '#59 Compress hero images'],
  push: (n) => [`Claude pushed to ${n}`, 'Add alt text to gallery images'],
  claude: (n) => [`Claude is working on ${n}`, 'Rebuilding the services page'],
  down: (n) => [`${n} is down`, 'The site answered 503'],
  up: (n) => [`${n} is back up`, 'Answered in 240ms'],
  perf: (n) => [`${n} got slower`, 'Response time 220ms → 940ms'],
}

let nid = 0
export function demoNote(p: Project, kind: NoteKind, test = false): Note {
  const [title, body] = TEXT[kind](p.name)
  return { id: `demo-${nid++}`, projectId: p.id, kind, level: LEVEL_OF[kind], title, body, at: new Date().toISOString(), read: false, url: p.url ?? undefined, test }
}

/** What a notification does to a project's status in the demo. */
export function applyDemo(p: Project, kind: NoteKind): Project {
  const set = (status: Status, reason: string): Project => ({ ...p, status, reason })
  switch (kind) {
    case 'build':
      return { ...set('building', 'Build running on main'), runs: [{ ...p.runs[0], id: Date.now(), status: 'running', started: new Date().toISOString(), durationS: null }, ...p.runs] }
    case 'build-ok':
      return { ...set('live', 'Build passed'), runs: p.runs.map((r, i) => (i === 0 ? { ...r, status: 'success', durationS: 64 } : r)) }
    case 'build-fail':
      return { ...set('broken', 'Build is failing on main'), runs: p.runs.map((r, i) => (i === 0 ? { ...r, status: 'failure', durationS: 31 } : r)) }
    case 'deploying':
      return { ...set('deploying', 'Deploying production'), deployments: [{ ...p.deployments[0], id: Date.now(), state: 'in_progress', created: new Date().toISOString() }, ...p.deployments.slice(0, 4)] }
    case 'deployed':
      return { ...set('live', 'Deployed just now'), deployments: p.deployments.map((d, i) => (i === 0 ? { ...d, state: 'success' } : d)) }
    case 'deploy-fail':
      return { ...set('broken', 'The last production deploy failed'), deployments: p.deployments.map((d, i) => (i === 0 ? { ...d, state: 'failure' } : d)) }
    case 'issue':
      return {
        ...set('attention', `${p.issues.length + 1} open issues`),
        issues: [{ number: 58, title: 'Booking button overlaps footer on iPhone SE', labels: ['bug'], author: 'client', created: new Date().toISOString(), url: p.repo, bug: true }, ...p.issues],
      }
    case 'claude':
      return {
        ...set('building', 'Claude is working: Rebuilding the services page'),
        threads: [{ id: `t-live-${p.id}`, title: 'Rebuilding the services page', source: 'claude-web', status: 'working', updated: new Date().toISOString(), commits: 1, url: 'https://claude.ai/code' }, ...p.threads.filter((t) => t.id !== `t-live-${p.id}`)],
      }
    case 'pr':
    case 'push':
      return { ...p, threads: p.threads.map((t) => (t.id === `t-live-${p.id}` ? { ...t, status: 'open' } : t)), status: p.status === 'building' ? 'live' : p.status, reason: p.status === 'building' ? 'Claude opened a PR' : p.reason }
    case 'down':
      return { ...set('broken', "The live site isn't responding (503)"), health: { ...p.health, up: false, code: 503 } }
    case 'up':
      return { ...set('live', 'Back up'), health: { ...p.health, up: true, code: 200 } }
    default:
      return p
  }
}

export function startSimulator(get: () => Project[], emit: (p: Project, kind: NoteKind) => void) {
  let timer = 0
  let seq: NoteKind[] = []
  let target: Project | null = null
  const step = () => {
    const list = get()
    if (!seq.length || !target) {
      seq = [...SEQUENCES[Math.floor(Math.random() * SEQUENCES.length)]]
      target = list[Math.floor(Math.random() * Math.max(1, list.length - 1))]
    }
    const kind = seq.shift()!
    if (target) emit(target, kind)
    timer = window.setTimeout(step, seq.length ? 5000 + Math.random() * 3000 : 11000 + Math.random() * 6000)
  }
  timer = window.setTimeout(step, 6000)
  return () => window.clearTimeout(timer)
}
