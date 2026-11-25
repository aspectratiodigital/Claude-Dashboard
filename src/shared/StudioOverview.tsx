import { useEffect, useMemo, useState } from 'react'
import type { OverviewSite } from '../data/studio-api'
import { relTime } from '../data/derive'
import { Icon } from './icons'
import { Modal, Seg, Spin, getJson } from './StudioUi'

// Every website at a glance: whether it's up and quick, its SEO and speed
// scores, edits waiting to go live or booked, the last change and deploy, and
// the weekly check's findings. Opening one switches Studio to it.

type Sort = 'attention' | 'name' | 'recent'

const STATE_WORD: Record<string, string> = { success: 'Deployed', failure: 'Deploy failed', error: 'Deploy failed', in_progress: 'Deploying', queued: 'Queued', pending: 'Waiting', inactive: 'Replaced' }

const score = (n: number | null) => (n === null ? null : n >= 90 ? 'good' : n >= 50 ? 'improve' : 'fix')

export function Overview({ current, onOpen, onClose }: { current: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [sites, setSites] = useState<OverviewSite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('attention')
  useEffect(() => {
    getJson<{ sites: OverviewSite[] }>('./api/studio/overview')
      .then((d) => setSites(d.sites))
      .catch((e) => setError((e as Error).message))
  }, [])
  const needs = (s: OverviewSite) => (s.up === false ? 100 : 0) + (s.deploy?.state === 'failure' || s.deploy?.state === 'error' ? 50 : 0) + (s.weekly?.slipped ?? 0) * 5 + (s.waiting ? 10 : 0) + (s.schedule ? 5 : 0) + (s.weekly?.problems ?? 0)
  const sorted = useMemo(() => {
    const list = [...(sites ?? [])]
    if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'recent') return list.sort((a, b) => (b.lastCommit?.date ?? '').localeCompare(a.lastCommit?.date ?? ''))
    return list.sort((a, b) => needs(b) - needs(a) || a.name.localeCompare(b.name))
  }, [sites, sort])
  const waiting = sites?.filter((s) => s.waiting).length ?? 0
  const down = sites?.filter((s) => s.up === false).length ?? 0
  return (
    <Modal title="All sites" onClose={onClose} wide tall>
      {error && <p className="st-error">{error}</p>}
      {!sites && !error && <Spin>Gathering every site…</Spin>}
      {sites && (
        <>
          <div className="st-row">
            <p className="st-muted">
              {sites.length} sites{waiting ? ` · ${waiting} with edits waiting to go live` : ''}
              {down ? ` · ${down} not answering` : ''}
            </p>
            <span className="st-gap" />
            <Seg
              small
              value={sort}
              label="Sort"
              onChange={setSort}
              options={[
                ['attention', 'Needs a look'],
                ['recent', 'Recently changed'],
                ['name', 'A to Z'],
              ]}
            />
          </div>
          <ul className="st-overview">
            {sorted.map((s) => (
              <li key={s.id} data-current={s.id === current || undefined} style={{ '--accent': s.accent } as React.CSSProperties}>
                <header>
                  <i className="st-dot" />
                  <b>{s.name}</b>
                  {s.up !== null && (
                    <span className="st-state" data-tone={s.up ? 'good' : 'bad'} title={s.ms ? `Answered in ${s.ms} ms` : undefined}>
                      <i className="st-dot" /> {s.up ? (s.ms ? `${s.ms} ms` : 'Up') : 'Down'}
                    </span>
                  )}
                </header>
                <div className="st-ov-scores">
                  {s.seo !== null && <span data-level={score(s.seo)}>SEO {s.seo}</span>}
                  {s.performance !== null && <span data-level={score(s.performance)}>Speed {s.performance}</span>}
                  {s.weekly && (
                    <span data-level={s.weekly.slipped ? 'fix' : s.weekly.problems ? 'improve' : 'good'} title={`Weekly check ${relTime(s.weekly.at)}`}>
                      {s.weekly.problems ? `${s.weekly.problems} problem${s.weekly.problems === 1 ? '' : 's'}` : 'Healthy'}
                      {s.weekly.slipped ? ` (${s.weekly.slipped} new)` : ''}
                    </span>
                  )}
                </div>
                {(s.waiting > 0 || s.schedule) && (
                  <p className="st-ov-waiting">
                    {s.waiting > 0 && (
                      <>
                        <Icon.rocket size={12} /> {s.waiting} edit{s.waiting === 1 ? '' : 's'} saved, not live{' '}
                      </>
                    )}
                    {s.schedule && (
                      <>
                        <Icon.clock size={12} /> goes live {new Date(s.schedule.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </>
                    )}
                  </p>
                )}
                {s.lastCommit && (
                  <p className="st-muted st-ov-commit" title={s.lastCommit.title}>
                    {s.lastCommit.title} · {relTime(s.lastCommit.date)}
                  </p>
                )}
                {s.deploy && <p className="st-muted">{STATE_WORD[s.deploy.state] ?? s.deploy.state} {relTime(s.deploy.created)}</p>}
                <footer>
                  {s.kind === 'shopify' ? (
                    <span className="st-muted">Shopify theme: edit in Shopify</span>
                  ) : (
                    <button className="st-pill" onClick={() => onOpen(s.id)} disabled={s.id === current}>
                      {s.id === current ? 'Open now' : s.open ? 'Switch to it' : 'Open in Studio'}
                    </button>
                  )}
                  {s.url && (
                    <a className="st-btn" href={s.url} target="_blank" rel="noreferrer" title="Visit the live site">
                      <Icon.external size={14} />
                    </a>
                  )}
                </footer>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}
