import type { Note, NoteKind, NoteLevel, Project, Status } from './types'

// Small helpers every concept shares: labels, severity, the live "signals" a
// scene turns into visuals, and formatting.

export const STATUS_LABEL: Record<Status, string> = {
  live: 'Live',
  building: 'Building',
  deploying: 'Deploying',
  attention: 'Needs attention',
  broken: 'Broken',
  quiet: 'Quiet',
}

export const SEVERITY: Record<Status, number> = { broken: 5, attention: 4, building: 3, deploying: 2, live: 1, quiet: 0 }

export const KIND_LABEL: Record<NoteKind, string> = {
  build: 'Build started',
  'build-ok': 'Build passed',
  'build-fail': 'Build failed',
  deploying: 'Deploying',
  deployed: 'Deployed',
  'deploy-fail': 'Deploy failed',
  issue: 'New issue',
  pr: 'Pull request',
  merged: 'Merged',
  review: 'Review requested',
  push: 'Pushed',
  claude: 'Claude working',
  down: 'Site down',
  up: 'Back up',
  perf: 'Slower',
}

export const ALL_KINDS: NoteKind[] = ['build', 'build-ok', 'build-fail', 'deploying', 'deployed', 'deploy-fail', 'issue', 'pr', 'review', 'merged', 'push', 'claude', 'down', 'up', 'perf']

export const LEVEL_OF: Record<NoteKind, NoteLevel> = {
  build: 'progress',
  'build-ok': 'success',
  'build-fail': 'critical',
  deploying: 'progress',
  deployed: 'success',
  'deploy-fail': 'critical',
  issue: 'warning',
  pr: 'info',
  merged: 'success',
  review: 'warning',
  push: 'info',
  claude: 'progress',
  down: 'critical',
  up: 'success',
  perf: 'warning',
}

/** What a scene needs to draw a project's current state. */
export interface Signals {
  building: boolean
  deploying: boolean
  broken: boolean
  down: boolean
  attention: boolean
  claude: boolean
  issues: number
  bugs: number
  prs: number
  /** a deploy landed in the last 15 minutes */
  fresh: boolean
}

const MIN = 60_000

export function signals(p: Project): Signals {
  const lastDeploy = p.deployments.find((d) => d.state === 'success')
  return {
    building: p.runs.some((r) => r.status === 'running' || r.status === 'queued') || p.status === 'building',
    deploying: p.status === 'deploying' || p.deployments.some((d) => ['queued', 'pending', 'in_progress'].includes(d.state)),
    broken: p.status === 'broken',
    down: p.health.up === false,
    attention: p.status === 'attention',
    claude: p.threads.some((t) => t.status === 'working'),
    issues: p.issues.length,
    bugs: p.issues.filter((i) => i.bug).length,
    prs: p.pulls.filter((x) => x.state === 'open').length,
    fresh: !!lastDeploy && Date.now() - Date.parse(lastDeploy.created) < 15 * MIN,
  }
}

export function relTime(iso: string | null | undefined) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const fmtMs = (ms: number | null | undefined) => (ms === null || ms === undefined ? '–' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

export function fmtBytes(b: number | null | undefined) {
  if (b === null || b === undefined) return '–'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function fmtDur(s: number | null | undefined) {
  if (s === null || s === undefined) return '–'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export const hostOf = (url: string | null | undefined) => {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Short display domain for a project (live URL, else the repo). */
export const domainOf = (p: Project) => hostOf(p.url) || p.repo.split('/')[1]

export function unread(notes: Note[]) {
  return notes.filter((n) => !n.read).length
}

/** Latest note per project in the last few minutes; scenes use it for lingering effects. */
export function recentByProject(notes: Note[], withinMs = 10 * MIN) {
  const out = new Map<string, Note>()
  for (const n of notes) {
    if (Date.now() - Date.parse(n.at) > withinMs) continue
    if (!out.has(n.projectId)) out.set(n.projectId, n)
  }
  return out
}

/** Average of a 0..1 list, ignoring nulls */
export function mean(xs: (number | null | undefined)[]) {
  const v = xs.filter((x): x is number => typeof x === 'number')
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
