import type { Note, NoteKind, NoteLevel, Project } from '../src/data/types.ts'
import { ago } from './util.ts'

// Notifications are worked out by comparing each fresh project snapshot with
// the previous one: a run that flipped to failure, a deployment that went
// live, a new issue, Claude opening a PR, the site going down, and so on.

export type Draft = Omit<Note, 'read' | 'at'> & { at?: string }

export const LEVEL: Record<NoteKind, NoteLevel> = {
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

const H = 3_600_000

function draft(p: Project, kind: NoteKind, key: string, title: string, body: string, url?: string, at?: string): Draft {
  return { id: `${p.id}:${kind}:${key}`, projectId: p.id, kind, level: LEVEL[kind], title, body, url, at }
}

export function diffProject(prev: Project | undefined, next: Project): Draft[] {
  if (!prev) return []
  const out: Draft[] = []
  const n = next.name

  for (const r of next.runs) {
    if (ago(r.started) > 3 * H) continue
    const was = prev.runs.find((x) => x.id === r.id)
    if (was?.status === r.status) continue
    if (r.status === 'running' || r.status === 'queued') {
      if (!was) out.push(draft(next, 'build', `${r.id}`, `Building ${n}`, `${r.name} started on ${r.branch}`, r.url, r.started))
    } else if (r.status === 'success') {
      out.push(draft(next, 'build-ok', `${r.id}`, `${n} build passed`, `${r.name} on ${r.branch}${r.durationS ? ` in ${fmtDur(r.durationS)}` : ''}`, r.url))
    } else if (r.status === 'failure') {
      out.push(draft(next, 'build-fail', `${r.id}`, `${n} build failed`, `${r.name} failed on ${r.branch}`, r.url))
    }
  }

  for (const d of next.deployments) {
    if (ago(d.created) > 6 * H) continue
    const was = prev.deployments.find((x) => x.id === d.id)
    if (was?.state === d.state) continue
    const env = d.environment || 'deployment'
    if (['queued', 'pending', 'in_progress'].includes(d.state)) {
      if (!was) out.push(draft(next, 'deploying', `${d.id}`, `Deploying ${n}`, `${env} from ${d.ref}`, d.logUrl ?? undefined, d.created))
    } else if (d.state === 'success') {
      out.push(draft(next, 'deployed', `${d.id}`, `${n} is live`, `${env} deployed from ${d.ref}`, d.url ?? d.logUrl ?? undefined))
    } else if (d.state === 'failure' || d.state === 'error') {
      out.push(draft(next, 'deploy-fail', `${d.id}`, `${n} deploy failed`, `${env} from ${d.ref}`, d.logUrl ?? undefined))
    }
  }

  for (const i of next.issues) {
    if (prev.issues.some((x) => x.number === i.number) || ago(i.created) > 24 * H) continue
    out.push(draft(next, 'issue', `${i.number}`, `New issue on ${n}`, `#${i.number} ${i.title}`, i.url, i.created))
  }

  for (const p of next.pulls) {
    const was = prev.pulls.find((x) => x.number === p.number)
    if (!was && p.state === 'open' && ago(p.updated) < 24 * H) {
      out.push(
        draft(next, 'pr', `${p.number}`, p.claude ? `Claude opened a PR on ${n}` : `New PR on ${n}`, `#${p.number} ${p.title}`, p.url, p.updated),
      )
    }
    if (was && was.state === 'open' && p.state === 'merged') out.push(draft(next, 'merged', `${p.number}`, `Merged into ${n}`, `#${p.number} ${p.title}`, p.url))
    if (p.reviewRequested && !was?.reviewRequested) out.push(draft(next, 'review', `${p.number}`, `Review requested on ${n}`, `#${p.number} ${p.title}`, p.url))
  }

  const known = new Set(prev.commits.map((c) => c.sha))
  const fresh = next.commits.filter((c) => !known.has(c.sha) && ago(c.date) < 6 * H).slice(0, 3)
  for (const c of fresh) {
    out.push(draft(next, 'push', c.sha, c.claude ? `Claude pushed to ${n}` : `${c.author} pushed to ${n}`, c.message, c.url, c.date))
  }

  for (const t of next.threads) {
    if (t.status !== 'working') continue
    const was = prev.threads.find((x) => x.id === t.id)
    if (was?.status === 'working') continue
    out.push(draft(next, 'claude', `${t.id}:${t.updated.slice(0, 13)}`, `Claude is working on ${n}`, t.title, t.url ?? t.prUrl))
  }

  const h0 = prev.health
  const h1 = next.health
  if (h0.up === true && h1.up === false) out.push(draft(next, 'down', h1.checked ?? 'x', `${n} is down`, `${h1.url} answered ${h1.code ?? 'nothing'}`, h1.url ?? undefined))
  if (h0.up === false && h1.up === true) out.push(draft(next, 'up', h1.checked ?? 'x', `${n} is back up`, `${h1.url} answered in ${h1.ms}ms`, h1.url ?? undefined))
  if (h0.psi && h1.psi && h1.psi.at !== h0.psi.at && h0.psi.scores.performance - h1.psi.scores.performance >= 8) {
    out.push(draft(next, 'perf', h1.psi.at, `${n} got slower`, `Performance ${h0.psi.scores.performance} → ${h1.psi.scores.performance}`, h1.url ?? undefined))
  }
  return out
}

/** On the very first run there's nothing to compare with, so recent history becomes read notes. */
export function seedNotes(p: Project): Draft[] {
  const out: Draft[] = []
  const n = p.name
  for (const r of p.runs.slice(0, 6)) {
    if (ago(r.started) > 48 * H) continue
    if (r.status === 'failure') out.push(draft(p, 'build-fail', `${r.id}`, `${n} build failed`, `${r.name} failed on ${r.branch}`, r.url, r.started))
    if (r.status === 'success') out.push(draft(p, 'build-ok', `${r.id}`, `${n} build passed`, `${r.name} on ${r.branch}`, r.url, r.started))
  }
  for (const d of p.deployments.slice(0, 3)) {
    if (ago(d.created) > 48 * H) continue
    if (d.state === 'success') out.push(draft(p, 'deployed', `${d.id}`, `${n} deployed`, `${d.environment} from ${d.ref}`, d.url ?? undefined, d.created))
    if (d.state === 'failure' || d.state === 'error') out.push(draft(p, 'deploy-fail', `${d.id}`, `${n} deploy failed`, `${d.environment}`, d.logUrl ?? undefined, d.created))
  }
  for (const i of p.issues) if (ago(i.created) < 72 * H) out.push(draft(p, 'issue', `${i.number}`, `New issue on ${n}`, `#${i.number} ${i.title}`, i.url, i.created))
  for (const pr of p.pulls) {
    if (ago(pr.updated) > 48 * H) continue
    if (pr.state === 'merged') out.push(draft(p, 'merged', `${pr.number}`, `Merged into ${n}`, `#${pr.number} ${pr.title}`, pr.url, pr.updated))
    else if (pr.state === 'open') out.push(draft(p, 'pr', `${pr.number}`, pr.claude ? `Claude opened a PR on ${n}` : `PR open on ${n}`, `#${pr.number} ${pr.title}`, pr.url, pr.updated))
  }
  return out
}

/** Sample notifications so every visual can be previewed on demand. */
export function testNote(p: Project, kind: NoteKind): Draft {
  const t: Record<NoteKind, [string, string]> = {
    build: [`Building ${p.name}`, `CI started on ${p.defaultBranch}`],
    'build-ok': [`${p.name} build passed`, `CI on ${p.defaultBranch} in 1m 12s`],
    'build-fail': [`${p.name} build failed`, `CI failed on ${p.defaultBranch}: type error in src/pages/index`],
    deploying: [`Deploying ${p.name}`, `Production from ${p.defaultBranch}`],
    deployed: [`${p.name} is live`, `Production deployed from ${p.defaultBranch}`],
    'deploy-fail': [`${p.name} deploy failed`, 'Production build exited with code 1'],
    issue: [`New issue on ${p.name}`, '#42 Contact form not sending on mobile'],
    pr: [`Claude opened a PR on ${p.name}`, '#43 Tighten hero spacing on mobile'],
    merged: [`Merged into ${p.name}`, '#43 Tighten hero spacing on mobile'],
    review: [`Review requested on ${p.name}`, '#43 Tighten hero spacing on mobile'],
    push: [`Claude pushed to ${p.name}`, 'Fix footer links'],
    claude: [`Claude is working on ${p.name}`, 'Rebuilding the services page'],
    down: [`${p.name} is down`, `${p.url ?? 'site'} answered 503`],
    up: [`${p.name} is back up`, `${p.url ?? 'site'} answered in 212ms`],
    perf: [`${p.name} got slower`, 'Performance 92 → 78'],
  }
  return { ...draft(p, kind, `test-${Date.now()}`, t[kind][0], t[kind][1], p.url ?? undefined), test: true }
}

export function fmtDur(s: number) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
