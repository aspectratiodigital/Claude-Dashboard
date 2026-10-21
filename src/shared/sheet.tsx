import { useState, type ReactNode } from 'react'
import type { Check, Page, Project, Thread } from '../data/types'
import { useData, useProject } from '../data/store'
import { STATUS_LABEL, fmtBytes, fmtDur, fmtMs, hostOf, relTime } from '../data/derive'
import { Icon } from './icons'
import { DevicePair, enterStage, sourcesFor } from './Preview'
import { Sparkline } from './bits'

// Building blocks for project detail panels. Every concept composes these and
// restyles them through the --ui-* tokens (class prefix .sh-).

export function StatusPill({ project }: { project: Project }) {
  return (
    <span className="sh-pill" data-status={project.status} title={project.reason}>
      <i />
      {STATUS_LABEL[project.status]}
    </span>
  )
}

export function Facts({ project, keys }: { project: Project; keys?: ('repo' | 'branch' | 'stack' | 'host' | 'push' | 'week' | 'prs' | 'issues')[] }) {
  const all = {
    repo: ['Repo', project.repo.split('/')[1]],
    branch: ['Branch', project.defaultBranch],
    stack: ['Stack', project.framework],
    host: ['Host', project.host ?? '–'],
    push: ['Last push', relTime(project.pushedAt)],
    week: ['Commits (7d)', String(project.commitsWeek)],
    prs: ['Open PRs', String(project.pulls.filter((p) => p.state === 'open').length)],
    issues: ['Issues', String(project.issues.length)],
  } as const
  const list = keys ?? (['repo', 'stack', 'host', 'push', 'week', 'prs'] as const)
  return (
    <dl className="sh-facts">
      {list.map((k) => (
        <div key={k}>
          <dt>{all[k][0]}</dt>
          <dd>{all[k][1]}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Links({ project }: { project: Project }) {
  return (
    <div className="sh-links">
      {project.url && (
        <a href={project.url} target="_blank" rel="noreferrer">
          <Icon.external size={13} /> {hostOf(project.url)}
        </a>
      )}
      <a href={`https://github.com/${project.repo}`} target="_blank" rel="noreferrer">
        <Icon.github size={13} /> Repo
      </a>
      {project.claudeProjectUrl && (
        <a href={project.claudeProjectUrl} target="_blank" rel="noreferrer">
          <Icon.claude size={13} /> Claude project
        </a>
      )}
    </div>
  )
}

const THREAD_STATUS: Record<Thread['status'], string> = { working: 'Working now', open: 'Open', merged: 'Merged', closed: 'Closed', idle: 'Idle' }

export function ThreadItem({ t, label, color, onPick }: { t: Thread; label?: string; color?: string; onPick?: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <li className="sh-thread" data-status={t.status} data-pick={!!onPick} onClick={onPick}>
      <span className="sh-thread-icon" data-source={t.source}>
        {t.source === 'claude-local' ? <Icon.terminal size={15} /> : t.source === 'pr' ? <Icon.branch size={15} /> : <Icon.claude size={15} />}
      </span>
      <span className="sh-thread-main">
        {label && (
          <small className="sh-thread-label" style={{ color }}>
            {label}
          </small>
        )}
        <b>{t.title}</b>
        <small>
          <em data-status={t.status}>{THREAD_STATUS[t.status]}</em>
          {t.prNumber ? ` · PR #${t.prNumber}` : ''}
          {t.branch && t.source !== 'claude-local' ? ` · ${t.branch}` : ''}
          {t.commits ? ` · ${t.commits} commit${t.commits === 1 ? '' : 's'}` : ''}
          {` · ${relTime(t.updated)}`}
        </small>
        {t.summary && <small className="sh-thread-sum">{t.summary}</small>}
      </span>
      <span className="sh-thread-actions" onClick={(e) => e.stopPropagation()}>
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" title="Open in Claude">
            <Icon.claude size={14} />
          </a>
        )}
        {t.prUrl && (
          <a href={t.prUrl} target="_blank" rel="noreferrer" title="Open pull request">
            <Icon.github size={14} />
          </a>
        )}
        {t.resume && (
          <button
            title={`Copy: ${t.resume}`}
            onClick={() => {
              navigator.clipboard?.writeText(t.resume!).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? '✓' : <Icon.terminal size={14} />}
          </button>
        )}
      </span>
    </li>
  )
}

export function ThreadList({ project, limit = 8 }: { project: Project; limit?: number }) {
  if (!project.threads.length) return <p className="sh-empty">No Claude threads found for this repo yet. They appear when Claude opens a branch or PR here, or you run Claude Code in its folder.</p>
  return (
    <ul className="sh-threads">
      {project.threads.slice(0, limit).map((t) => (
        <ThreadItem key={t.id} t={t} />
      ))}
    </ul>
  )
}

type Item = { at: string; kind: 'run' | 'deploy' | 'commit' | 'pr'; title: string; meta: string; state: string; url?: string }

export function activity(project: Project): Item[] {
  const items: Item[] = [
    ...project.runs.map((r) => ({ at: r.started, kind: 'run' as const, title: r.name, meta: `${r.branch}${r.durationS ? ` · ${fmtDur(r.durationS)}` : ''}`, state: r.status, url: r.url })),
    ...project.deployments.map((d) => ({ at: d.created, kind: 'deploy' as const, title: `Deploy ${d.environment}`, meta: d.ref, state: d.state, url: d.url ?? d.logUrl ?? undefined })),
    ...project.commits.map((c) => ({ at: c.date, kind: 'commit' as const, title: c.message, meta: `${c.claude ? 'Claude' : c.author} · ${c.sha}`, state: 'commit', url: c.url })),
  ]
  return items.sort((a, b) => b.at.localeCompare(a.at))
}

export function ActivityFeed({ project, limit = 10 }: { project: Project; limit?: number }) {
  const items = activity(project).slice(0, limit)
  if (!items.length) return <p className="sh-empty">No activity yet.</p>
  return (
    <ol className="sh-feed">
      {items.map((it, i) => (
        <li key={i} data-kind={it.kind} data-state={it.state}>
          <i />
          <span>
            {it.url ? (
              <a href={it.url} target="_blank" rel="noreferrer">
                {it.title}
              </a>
            ) : (
              it.title
            )}
            <small>
              {it.meta} · {relTime(it.at)}
            </small>
          </span>
        </li>
      ))}
    </ol>
  )
}

export function IssueList({ project }: { project: Project }) {
  if (!project.issues.length) return <p className="sh-empty">No open issues.</p>
  return (
    <ul className="sh-issues">
      {project.issues.slice(0, 8).map((i) => (
        <li key={i.number} data-bug={i.bug}>
          <a href={i.url} target="_blank" rel="noreferrer">
            <b>#{i.number}</b> {i.title}
          </a>
          <small>
            {i.labels.join(', ') || 'no labels'} · {relTime(i.created)}
          </small>
        </li>
      ))}
    </ul>
  )
}

export function Score({ value, label, size = 54 }: { value: number | null; label: string; size?: number }) {
  const v = value ?? 0
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  const tone = value === null ? 'none' : v >= 90 ? 'good' : v >= 50 ? 'ok' : 'bad'
  return (
    <figure className="sh-score" data-tone={tone}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <b>{value === null ? '–' : Math.round(v)}</b>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

export function HealthBlock({ project }: { project: Project }) {
  const h = project.health
  const q = project.quality
  const history = h.history.filter((x) => x >= 0)
  return (
    <div className="sh-health">
      <div className="sh-scores">
        <Score value={h.uptimePct} label="Uptime" />
        <Score value={h.seoScore} label="SEO tags" />
        <Score value={q.ciPassRate === null ? null : q.ciPassRate * 100} label="Builds passing" />
        {h.psi && <Score value={h.psi.scores.performance} label="Lighthouse" />}
      </div>
      <dl className="sh-facts">
        <div>
          <dt>Response</dt>
          <dd>
            {fmtMs(h.ms)} {history.length > 2 && <Sparkline data={history} width={64} height={16} />}
          </dd>
        </div>
        <div>
          <dt>Page weight</dt>
          <dd>{fmtBytes(h.bytes)}</dd>
        </div>
        <div>
          <dt>Avg build</dt>
          <dd>{fmtDur(q.avgBuildS)}</dd>
        </div>
        <div>
          <dt>Grade</dt>
          <dd className="sh-grade" data-grade={q.grade ?? 'none'}>
            {q.grade ?? '–'}
          </dd>
        </div>
      </dl>
      {!h.url && <p className="sh-empty">Add a live URL in Settings to track uptime, speed and SEO tags.</p>}
    </div>
  )
}

export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return null
  return (
    <ul className="sh-checks">
      {checks.map((c) => (
        <li key={c.id} data-pass={c.pass}>
          <i>{c.pass ? '✓' : '✕'}</i>
          <span>
            {c.label}
            {c.detail && <small>{c.detail}</small>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Fetches a page's title, tags and timing from the local API on demand. */
export function usePageInfo(project: Project, page: Page | null) {
  const mode = useData((s) => s.mode)
  const [info, setInfo] = useState<Record<string, Page>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const load = (p: Page) => {
    const key = `${project.id}${p.path}`
    if (info[key] || mode !== 'live' || !project.url) return
    setLoading(key)
    fetch(`./api/inspect?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(p.path)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x: Page | null) => x && setInfo((m) => ({ ...m, [key]: x })))
      .finally(() => setLoading(null))
  }
  const cur = page ? (info[`${project.id}${page.path}`] ?? page) : null
  return { info: cur, load, loading: page ? loading === `${project.id}${page.path}` : false }
}

export function PageDetail({ project, page }: { project: Project; page: Page }) {
  const { info, load, loading } = usePageInfo(project, page)
  const src = sourcesFor(project)[0]
  const p = info ?? page
  return (
    <div className="sh-page">
      <header>
        <b>{p.path}</b>
        {p.title && <span>{p.title}</span>}
      </header>
      <dl className="sh-facts">
        <div>
          <dt>Found in</dt>
          <dd>{p.source === 'sitemap' ? 'Sitemap' : p.source === 'repo' ? 'Repo' : 'Site nav'}</dd>
        </div>
        {p.file && (
          <div>
            <dt>File</dt>
            <dd title={p.file}>{p.file.split('/').slice(-2).join('/')}</dd>
          </div>
        )}
        {p.ms !== undefined && (
          <div>
            <dt>Response</dt>
            <dd>{fmtMs(p.ms)}</dd>
          </div>
        )}
        {p.bytes !== undefined && (
          <div>
            <dt>HTML</dt>
            <dd>{fmtBytes(p.bytes)}</dd>
          </div>
        )}
      </dl>
      {p.description && <p className="sh-desc">{p.description}</p>}
      {p.checks ? <ChecksList checks={p.checks} /> : project.url && <button className="sh-btn" onClick={() => load(page)} disabled={loading}>{loading ? 'Checking…' : 'Check this page'}</button>}
      {src && (
        <div className="sh-row">
          <button className="sh-btn" onClick={() => enterStage({ projectId: project.id, device: 'desktop', source: src, path: page.path })}>
            <Icon.desktop size={14} /> Desktop
          </button>
          <button className="sh-btn" onClick={() => enterStage({ projectId: project.id, device: 'mobile', source: src, path: page.path })}>
            <Icon.mobile size={14} /> Mobile
          </button>
        </div>
      )}
    </div>
  )
}

type SheetTab = 'threads' | 'activity' | 'health' | 'issues'

/**
 * A complete project panel: name, status, big desktop + phone previews, links,
 * facts and tabs. Concepts that don't need a bespoke panel use this and theme it
 * with their --ui-* tokens. `extra` renders between the facts and the tabs.
 */
export function ProjectSheet({ id, onClose, className = '', extra, labels }: { id: string; onClose: () => void; className?: string; extra?: ReactNode; labels?: Partial<Record<SheetTab, string>> }) {
  const p = useProject(id)
  const [tab, setTab] = useState<SheetTab>('threads')
  if (!p) return null
  const name: Record<SheetTab, string> = {
    threads: `${labels?.threads ?? 'Threads'} (${p.threads.length})`,
    activity: labels?.activity ?? 'Activity',
    health: labels?.health ?? 'Health',
    issues: `${labels?.issues ?? 'Issues'} (${p.issues.length})`,
  }
  return (
    <section className={`psheet ${className}`} aria-label={p.name}>
      <header className="psheet-head">
        <div>
          <h2>{p.name}</h2>
          <p>
            <StatusPill project={p} /> <span>{p.reason}</span>
          </p>
        </div>
        <button className="psheet-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <DevicePair project={p} className="psheet-preview" />
      <Links project={p} />
      <Facts project={p} />
      {extra}
      <div className="psheet-tabs" role="tablist">
        {(['threads', 'activity', 'health', 'issues'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {name[t]}
          </button>
        ))}
      </div>
      <div className="psheet-tab">
        {tab === 'threads' && <ThreadList project={p} />}
        {tab === 'activity' && <ActivityFeed project={p} limit={12} />}
        {tab === 'health' && <HealthBlock project={p} />}
        {tab === 'issues' && <IssueList project={p} />}
      </div>
    </section>
  )
}
