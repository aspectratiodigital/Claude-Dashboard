// Shared data contract between the local API (server/) and every concept.
// The server builds these from GitHub, your local Claude Code sessions and
// the site auditor; the demo generator (demo.ts) produces the same shape.

export type Status = 'live' | 'building' | 'deploying' | 'attention' | 'broken' | 'quiet'

export interface Commit {
  sha: string
  message: string
  author: string
  date: string
  url: string
  /** made by Claude (co-author trailer, session link or claude/ branch) */
  claude: boolean
  sessionUrl?: string
}

export interface Pull {
  number: number
  title: string
  branch: string
  author: string
  draft: boolean
  state: 'open' | 'merged' | 'closed'
  updated: string
  url: string
  claude: boolean
  threadUrl?: string
  sessionUrl?: string
  checks: 'pass' | 'fail' | 'running' | 'none'
  reviewRequested: boolean
  headSha?: string
  /** when the PR's latest commit was made (its last push) */
  pushed?: string
}

export interface Issue {
  number: number
  title: string
  labels: string[]
  author: string
  created: string
  url: string
  bug: boolean
}

export type RunState = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped'

export interface Run {
  id: number
  name: string
  branch: string
  event: string
  status: RunState
  started: string
  durationS: number | null
  url: string
  sha: string
}

export type DeployState = 'queued' | 'pending' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive'

export interface Deployment {
  id: number
  environment: string
  state: DeployState
  url: string | null
  logUrl: string | null
  created: string
  ref: string
  production: boolean
}

export interface Thread {
  id: string
  title: string
  /** where the thread lives: a claude.ai session, a local Claude Code session, or just a PR */
  source: 'claude-web' | 'claude-local' | 'pr'
  status: 'working' | 'open' | 'merged' | 'closed' | 'idle'
  updated: string
  /** when its latest commit was pushed; threads are sorted on this, newest first */
  pushed?: string
  branch?: string
  /** opens the thread in Claude */
  url?: string
  prUrl?: string
  prNumber?: number
  commits: number
  summary?: string
  /** for local sessions: `claude --resume <id>` */
  resume?: string
}

/** What one thread's push changed, fetched on demand when you open it. */
export interface Change {
  /** a short plain-English description of what the push does to the site */
  summary: string
  /** who wrote the summary: Claude Code on this computer, or taken from the PR / commits */
  by: 'claude' | 'pr'
  /** the PR description, with Claude's attribution lines taken out */
  body: string | null
  commits: { sha: string; message: string; date: string; url: string }[]
  files: { path: string; status: 'added' | 'modified' | 'removed' | 'renamed'; additions: number; deletions: number }[]
  additions: number
  deletions: number
  url: string | null
}

export type Category = 'performance' | 'accessibility' | 'bestPractices' | 'seo'

export interface Check {
  id: string
  category: Category
  label: string
  pass: boolean
  detail?: string
}

/** Optional Lighthouse scores from Google PageSpeed Insights (free API key). */
export interface Psi {
  strategy: 'mobile' | 'desktop'
  scores: Record<Category, number>
  lcp: number
  cls: number
  tbt: number
  fcp: number
  at: string
}

export interface Page {
  path: string
  /** where we learned about it */
  source: 'sitemap' | 'repo' | 'nav'
  file?: string
  title?: string
  description?: string
  /** tag checks, filled in when the page is inspected */
  checks?: Check[]
  code?: number
  ms?: number
  bytes?: number
  checked?: string
}

/** A free, lightweight health check: one request to the live site every few minutes. */
export interface Health {
  url: string | null
  checked: string | null
  up: boolean | null
  code: number | null
  /** time to download the page HTML, ms */
  ms: number | null
  bytes: number | null
  /** last ~48 checks, oldest first: response time in ms, or -1 for a failure */
  history: number[]
  uptimePct: number | null
  /** basic SEO tags on the home page, 0..100 */
  seoScore: number | null
  checks: Check[]
  themeColor: string | null
  psi: Psi | null
}

export interface Quality {
  /** share of the last 20 finished CI runs that passed, 0..1 */
  ciPassRate: number | null
  avgBuildS: number | null
  openBugs: number
  openPRs: number
  staleBranches: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null
}

/** A Shopify store behind a site (usually headless: Hydrogen or the Storefront API). */
export interface Store {
  /** the store's myshopify.com domain */
  domain: string
  /** how the site talks to Shopify, from its code: 'Hydrogen', 'Storefront API', or null if set by hand */
  headless: string | null
  /** an Admin API token is saved on this computer and works */
  connected: boolean
  error: string | null
  name: string | null
  currency: string | null
  adminUrl: string
  ordersToday: number
  salesToday: number
  /** sales per day over the last 7 days, oldest first */
  sales7: number[]
  orders: { id: string; name: string; total: number; at: string; status: string; url: string }[]
  lowStock: { title: string; qty: number; url: string }[]
  products: number | null
  checked: string | null
}

/** A product in a site's Shopify store, with its sales over the last 30 days. */
export interface StoreProduct {
  id: string
  title: string
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | string
  type: string
  image: string | null
  minPrice: number
  maxPrice: number
  /** total stock across variants, or null when Shopify doesn't track it */
  stock: number | null
  variants: number
  /** made with a bundles app (Shopify Bundles, or any app on Shopify's bundles API) */
  bundle: boolean
  /** units sold in the last 30 days, bundles included */
  sold: number
  /** of those, units that went out inside a bundle */
  inBundles: number
  revenue: number
  /** revenue per day over the last 30 days, oldest first */
  daily: number[]
  url: string
}

/** Every product in a store, for the products view. */
export interface StoreCatalog {
  currency: string
  products: StoreProduct[]
  /** orders read for the sales figures, and whether that stopped short of 30 days */
  orders: number
  partial: boolean
  checked: string
}

/** One product opened up: its options, each variant's stock and sales, and how it's bundled. */
export interface StoreProductDetail {
  id: string
  options: { name: string; values: string[] }[]
  variants: { id: string; title: string; options: Record<string, string>; sku: string | null; price: number; stock: number | null; sold: number }[]
  /** more variants than were read (bundles can have hundreds) */
  moreVariants: number
  /** what a bundle is made of */
  components: { id: string; title: string; qty: number; stock: number | null }[]
  /** bundles this product is part of */
  bundles: { id: string; title: string }[]
  description: string
  storeUrl: string | null
}

export interface Project {
  id: string
  name: string
  repo: string
  description: string
  private: boolean
  language: string | null
  framework: string
  host: string | null
  defaultBranch: string
  url: string | null
  previewUrl: string | null
  localPort: number | null
  claudeProjectUrl: string | null
  status: Status
  reason: string
  pushedAt: string
  accent: string
  /** commits per day over the last 14 days, oldest first */
  activity: number[]
  commitsWeek: number
  branches: string[]
  commits: Commit[]
  pulls: Pull[]
  issues: Issue[]
  runs: Run[]
  deployments: Deployment[]
  threads: Thread[]
  pages: Page[]
  health: Health
  quality: Quality
  /** the Shopify store this site sells through, if any */
  store: Store | null
}

export type NoteKind =
  | 'build'
  | 'build-ok'
  | 'build-fail'
  | 'deploying'
  | 'deployed'
  | 'deploy-fail'
  | 'issue'
  | 'pr'
  | 'merged'
  | 'review'
  | 'push'
  | 'claude'
  | 'down'
  | 'up'
  | 'perf'
  | 'order'
  | 'stock'

export type NoteLevel = 'info' | 'progress' | 'success' | 'warning' | 'critical'

export interface Note {
  id: string
  projectId: string
  kind: NoteKind
  level: NoteLevel
  title: string
  body: string
  url?: string
  at: string
  read: boolean
  /** test notifications fired from the notification centre */
  test?: boolean
}

export interface Setup {
  github: 'token' | 'gh' | 'none'
  owner: string
  login: string | null
  psi: boolean
  claudeSessions: number
}

export interface Snapshot {
  mode: 'live' | 'demo'
  projects: Project[]
  notes: Note[]
  setup: Setup
  updated: string
  rate: { remaining: number; limit: number; reset: number } | null
  errors: string[]
}
