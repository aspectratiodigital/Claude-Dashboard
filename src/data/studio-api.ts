import type { Deployment, Run } from './types'

// The shapes Studio's local API answers with (server/studio-routes.ts and the
// modules behind it), for the side panel. Kept here because the browser code
// can't import the server's own files.

export interface SearchHit {
  path: string
  title: string
  count: number
  snippets: string[]
}

export interface WordCount {
  /** places in the source with these words */
  source: number
  files: string[]
  /** pages showing them */
  pages: string[]
}

export interface ContentFile {
  path: string
  group: string
  label: string
  type: 'json' | 'md' | 'yaml'
  size: number
}

export type FrontValue = string | number | boolean | string[] | null

export interface ContentData {
  type: 'json' | 'md' | 'yaml'
  data?: unknown
  front?: Record<string, FrontValue>
  complex?: Record<string, string>
  body?: string
  text?: string
}

export interface LibraryPhoto {
  path: string
  url: string
  group: string
  bytes: number
  width: number | null
  height: number | null
  /** files that mention it; -1 when code builds names like it, so it may be used */
  uses: number
}

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
  page: string
  license: string
  ping?: string
}

export interface StockResults {
  photos: StockPhoto[]
  errors: string[]
  sources: string[]
}

export interface HistoryCommit {
  sha: string
  title: string
  author: string
  date: string
  studio: boolean
  merge: boolean
}

export interface KrystalState {
  branch: string | null
  checkedOut: string | null
  deployed: string | null
  deployedAt: string | null
  running: boolean
  failed: boolean
}

export interface DeployStatus {
  sha: string | null
  branch: string
  runs: Run[]
  deployments: Deployment[]
  krystal: (KrystalState & { error?: string }) | { error: string } | null
  connected: boolean
  url: string | null
  previewUrl: string | null
  pushedAt: number | null
}

export interface PreCheck {
  level: 'good' | 'improve' | 'fix'
  label: string
  detail: string
  page?: string
}

export interface Connections {
  unsplash: boolean
  pexels: boolean
  /** the service account's email when one is set */
  google: string | null
  site: { searchConsole: string; ga4: string; krystal: { host: string; user: string; repoRoot: string; branch: string; token: boolean } | null } | null
  psi: boolean
  claude?: boolean
}

export interface SpeedReport {
  url: string
  strategy: 'mobile' | 'desktop'
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number }
  metrics: { id: string; label: string; value: string; score: number }[]
  fixes: { title: string; saving: string; detail: string }[]
  shot: string | null
  at: string
}

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

export interface VisitorReport {
  property: string
  days: number
  now: { views: number; visitors: number; engagement: number }
  before: { views: number; visitors: number; engagement: number }
  sources: { name: string; sessions: number }[]
  pages: { page: string; views: number }[]
}

export interface NapReport {
  pages: number
  phones: { value: string; digits: string; pages: string[] }[]
  emails: { value: string; pages: string[] }[]
  names: { value: string; pages: string[] }[]
  addresses: { value: string; pages: string[] }[]
  schema: { pages: string[]; phone: string | null; name: string | null; address: string | null }
  problems: string[]
}

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
  slipped: string[]
  fixed: string[]
  running: boolean
  url?: string | null
}

export interface PhoneState {
  on: boolean
  url: string | null
  projectId: string | null
  page: string | null
  address: string | null
}

export interface OverviewSite {
  id: string
  name: string
  accent: string
  url: string | null
  previewUrl: string | null
  kind: string
  status: string
  open: boolean
  waiting: number
  schedule: { at: string; by: string } | null
  up: boolean | null
  ms: number | null
  seo: number | null
  performance: number | null
  pushed: string | null
  lastCommit: { title: string; date: string; author: string } | null
  deploy: { state: string; created: string; url: string | null } | null
  weekly: { at: string; problems: number; slipped: number; fixed: number } | null
}

/** an accessibility problem axe found on the page */
export interface A11yIssue {
  id: string
  impact: 'minor' | 'moderate' | 'serious' | 'critical'
  help: string
  description: string
  helpUrl: string
  nodes: { selector: string; summary: string; html: string; label: string; text: string }[]
  count: number
}
