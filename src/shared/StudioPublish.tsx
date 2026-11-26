import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StudioOp } from '../data/types'
import type { DeployStatus, HistoryCommit, PreCheck } from '../data/studio-api'
import { isGlobal, mediaLabel, opNote } from '../data/studio'
import { relTime } from '../data/derive'
import { Icon } from './icons'
import { LevelIcon } from './StudioSeo'
import { KrystalConnect, useConnections } from './StudioConnect'
import { Menu, MenuItem, Modal, Result, Section, Seg, Spin, copyText, getJson, post, postBlob, q, type StudioCtx } from './StudioUi'

// The Publish tab, in the order things happen: your edits (on the canvas, then
// saved), going live (now, as a draft for review, or booked for later), the
// deploy that follows, links to share, and the site's history to roll back.
// The Review dialog shows the changes, before-and-after screenshots and the
// checks before anything is pushed.

const newId = () => Math.random().toString(36).slice(2, 10)
const where = (page: string) => (page === '/' ? 'Home' : page)
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function PublishTab({ ctx, onSave, onReview, onPhone, onShot }: { ctx: StudioCtx; onSave: () => void; onReview: () => void; onPhone: () => void; onShot: () => void }) {
  const waiting = ctx.site.changed.length > 0
  return (
    <div className="st-panel">
      <Section id="pub-changes" title="Your edits" icon={<Icon.text size={14} />} badge={ctx.ops.length ? <em className="st-badge">{ctx.ops.length}</em> : undefined}>
        <Edits ctx={ctx} onSave={onSave} />
      </Section>
      <Section id="pub-live" title="Go live" icon={<Icon.rocket size={14} />} badge={waiting ? <em className="st-badge" data-tone="live">{ctx.site.notes.length || ctx.site.changed.length}</em> : undefined}>
        <GoLive ctx={ctx} onReview={onReview} />
      </Section>
      <Section id="pub-deploy" title="Deploy status" icon={<Icon.pulse size={14} />}>
        <Deploys ctx={ctx} />
      </Section>
      <Section id="pub-share" title="Share" icon={<Icon.link size={14} />}>
        <Share ctx={ctx} onPhone={onPhone} onShot={onShot} />
      </Section>
      <Section id="pub-history" title="History" icon={<Icon.history size={14} />} open={false}>
        <History ctx={ctx} />
      </Section>
    </div>
  )
}

// --- Edits -----------------------------------------------------------------------------------

function Edits({ ctx, onSave }: { ctx: StudioCtx; onSave: () => void }) {
  const everySize = (op: Extract<StudioOp, { kind: 'style' }>) => {
    ctx.removeOp(op.id)
    ctx.addOp({ ...op, id: newId(), media: null })
  }
  const show = (op: StudioOp) => {
    if (op.page !== ctx.path && !isGlobal(op)) ctx.go(op.page)
    else if (op.selector && !['head', 'body', ':root'].includes(op.selector)) ctx.tell({ type: 'reveal', selector: op.selector, keepTab: true })
  }
  const last = ctx.site.last && ['save', 'claude', 'discard'].includes(ctx.site.last.kind) ? ctx.site.last : null
  return (
    <>
      {ctx.ops.length > 0 && <h5>On the canvas, not saved yet</h5>}
      {ctx.ops.length ? (
        <ol className="st-oplist">
          {ctx.ops.map((op) => (
            <li key={op.id}>
              <button className="st-op-text" onClick={() => show(op)} title={op.page === ctx.path || isGlobal(op) ? 'Show it on the page' : `Go to ${where(op.page)}`}>
                {opNote(op)}
              </button>
              <span className="st-op-tags">
                {isGlobal(op) ? <em data-tone="site">every page</em> : op.page !== ctx.path && <em>{where(op.page)}</em>}
                {op.kind === 'style' && <em data-tone={op.media ? 'size' : undefined} title={op.media ? 'Only at these screen widths' : 'At every screen width'}>{mediaLabel(op.media)}</em>}
                {op.kind === 'hide' && op.scope === 'this-size' && <em data-tone="size">{op.width < 900 ? 'up to 899px' : '900px and wider'}</em>}
                {op.kind === 'move' && <em data-tone="size">at {op.width}px</em>}
                {op.kind === 'style' && op.media && (
                  <button className="st-link" onClick={() => everySize(op)} disabled={ctx.working} title="Make this change at every screen size">
                    Every size
                  </button>
                )}
              </span>
              <button className="st-btn" onClick={() => ctx.removeOp(op.id)} title="Take this edit back" disabled={ctx.working}>
                <Icon.close size={13} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="st-muted">Nothing yet. Edit something on the page.</p>
      )}
      {ctx.ops.length > 0 && (
        <div className="st-row">
          <button className="st-primary" onClick={onSave} disabled={ctx.working}>
            Save {ctx.ops.length} edit{ctx.ops.length === 1 ? '' : 's'} into the site
          </button>
        </div>
      )}
      {ctx.working && <Spin>{ctx.site.message}</Spin>}
      {last && <Result r={last} />}
    </>
  )
}

// --- Going live ------------------------------------------------------------------------------

function GoLive({ ctx, onReview }: { ctx: StudioCtx; onReview: () => void }) {
  const s = ctx.site
  const last = s.last?.kind === 'publish' ? s.last : null
  return (
    <>
      {s.changed.length ? (
        <>
          <h5>Saved, waiting to go live</h5>
          <ol className="st-notes">
            {(s.notes.length ? s.notes : s.changed).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>
          <div className="st-row">
            <button className="st-primary" data-live onClick={onReview} disabled={ctx.working}>
              Review &amp; push live
            </button>
          </div>
          <Schedule ctx={ctx} />
        </>
      ) : (
        <p className="st-muted">{ctx.ops.length ? 'Save your edits first: then they can go live.' : 'Nothing waiting to go live. Everything saved is live.'}</p>
      )}
      {last && <Result r={last} />}
    </>
  )
}

/** a push live booked for a time (it runs while Blueprint is open on this computer) */
export function Schedule({ ctx }: { ctx: StudioCtx }) {
  const [at, setAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const booked = ctx.site.schedule
  const min = useMemo(() => {
    const d = new Date(Date.now() + 5 * 60_000)
    d.setSeconds(0, 0)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }, [])
  const book = async (value: string | null) => {
    setError(null)
    try {
      await post('./api/studio/schedule', { projectId: ctx.projectId, at: value ? new Date(value).toISOString() : null })
      ctx.refresh()
      setAt('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="st-schedule">
      {booked ? (
        <p className="st-chip">
          <Icon.clock size={13} /> Goes live {when(booked.at)}.{' '}
          <button className="st-link" onClick={() => book(null)}>
            Cancel
          </button>
        </p>
      ) : (
        <form
          className="st-field"
          onSubmit={(e) => {
            e.preventDefault()
            if (at) void book(at)
          }}
        >
          <label>
            <Icon.calendar size={13} /> Or push live later
          </label>
          <div>
            <input type="datetime-local" value={at} min={min} onChange={(e) => setAt(e.target.value)} aria-label="When to push live" />
            <button className="st-pill" disabled={!at || ctx.working}>
              Book it
            </button>
          </div>
        </form>
      )}
      <p className="st-tip">A booked push runs while Blueprint is open on this computer. If it’s closed then, it runs as soon as it opens.</p>
      {error && <p className="st-error">{error}</p>}
    </div>
  )
}

// --- Deploys ---------------------------------------------------------------------------------

const RUN_ICON: Record<string, { tone: string; word: string }> = {
  success: { tone: 'good', word: 'Passed' },
  failure: { tone: 'bad', word: 'Failed' },
  cancelled: { tone: 'muted', word: 'Cancelled' },
  skipped: { tone: 'muted', word: 'Skipped' },
  running: { tone: 'busy', word: 'Running' },
  queued: { tone: 'busy', word: 'Queued' },
  in_progress: { tone: 'busy', word: 'Deploying' },
  pending: { tone: 'busy', word: 'Waiting' },
  error: { tone: 'bad', word: 'Error' },
  inactive: { tone: 'muted', word: 'Replaced' },
}

function State({ s }: { s: string }) {
  const k = RUN_ICON[s] ?? { tone: 'muted', word: s }
  return (
    <span className="st-state" data-tone={k.tone}>
      {k.tone === 'busy' ? <i className="st-spin" /> : <i className="st-dot" />} {k.word}
    </span>
  )
}

function Deploys({ ctx }: { ctx: StudioCtx }) {
  const [d, setD] = useState<DeployStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connect, setConnect] = useState(false)
  const [sure, setSure] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const { conn, save, reload } = useConnections(ctx.projectId)
  const load = useCallback(
    () =>
      getJson<DeployStatus>(`./api/studio/deploy?${q({ project: ctx.projectId, krystal: 1 })}`)
        .then((x) => {
          setD(x)
          setError(null)
        })
        .catch((e) => setError((e as Error).message)),
    [ctx.projectId],
  )
  const busy = !!d && (d.runs.some((r) => r.status === 'running' || r.status === 'queued') || d.deployments.some((x) => ['queued', 'pending', 'in_progress'].includes(x.state)) || (!!d.krystal && 'running' in d.krystal && d.krystal.running))
  const recent = !!d?.pushedAt && Date.now() - d.pushedAt < 15 * 60_000
  useEffect(() => {
    void load()
    const t = setInterval(load, busy || recent ? 8000 : 60_000)
    return () => clearInterval(t)
  }, [load, busy, recent, ctx.site.sha])

  const deploy = async () => {
    if (!sure) return setSure(true)
    setSure(false)
    setDeploying(true)
    setNote(null)
    try {
      await post('./api/studio/krystal', { projectId: ctx.projectId })
      setNote('cPanel is deploying the latest commit.')
      void load()
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  if (error) return <p className="st-error">{error}</p>
  if (!d) return <Spin />
  const k = d.krystal
  const kState = k && !('error' in k && !('branch' in k)) ? (k as Exclude<DeployStatus['krystal'], null | { error: string }>) : null
  const behind = kState && d.sha && kState.checkedOut && !d.sha.startsWith(kState.checkedOut.slice(0, 7))
  return (
    <>
      <p className="st-muted">
        GitHub has <code>{d.sha?.slice(0, 7) ?? '…'}</code> on <b>{d.branch}</b>
        {ctx.site.commit ? `: ${ctx.site.commit}` : ''}
      </p>
      {d.runs.length > 0 && (
        <>
          <h5>Checks on GitHub</h5>
          <ul className="st-deploys">
            {d.runs.map((r) => (
              <li key={r.id}>
                <State s={r.status} />
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
                <small>{r.durationS ? `${Math.round(r.durationS)} s` : relTime(r.started)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.deployments.length > 0 && (
        <>
          <h5>Deploys</h5>
          <ul className="st-deploys">
            {d.deployments.map((x) => (
              <li key={x.id}>
                <State s={x.state} />
                <span>{x.environment}</span>
                <small>{relTime(x.created)}</small>
                {x.url && (
                  <a href={x.url} target="_blank" rel="noreferrer" title="Open what was deployed">
                    <Icon.external size={12} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {!d.runs.length && !d.deployments.length && <p className="st-muted">GitHub shows no checks or deploys for this commit. If the site is hosted on Krystal, deploy it there below.</p>}
      <h5>Krystal (cPanel)</h5>
      {d.connected ? (
        <>
          {k && 'error' in k && !kState?.branch && <p className="st-error">{k.error}</p>}
          {kState && (
            <p className="st-muted">
              cPanel’s copy is on <code>{kState.checkedOut?.slice(0, 7) ?? '?'}</code>
              {kState.deployedAt ? `, last deployed ${relTime(kState.deployedAt)}` : ''}. {kState.running ? 'Deploying now…' : kState.failed ? 'The last deploy failed.' : behind ? 'It’s behind GitHub.' : 'Up to date.'}
            </p>
          )}
          <div className="st-row">
            <button className="st-primary" data-live onClick={deploy} onBlur={() => setSure(false)} disabled={deploying || ctx.working || !!kState?.running}>
              {deploying ? 'Asking cPanel…' : sure ? 'Click again to deploy' : 'Deploy to Krystal'}
            </button>
            <button className="st-link" onClick={() => setConnect(!connect)}>
              {connect ? 'Close' : 'cPanel details'}
            </button>
          </div>
          {note && <p className="st-muted">{note}</p>}
        </>
      ) : (
        !connect && (
          <div className="st-row">
            <p className="st-muted">Connect the site’s cPanel to deploy it from here after pushing live.</p>
            <button className="st-pill" onClick={() => setConnect(true)}>
              Connect cPanel
            </button>
          </div>
        )
      )}
      {connect && conn && (
        <KrystalConnect
          conn={conn}
          save={save}
          projectId={ctx.projectId}
          onDone={() => {
            reload()
            void load()
          }}
        />
      )}
    </>
  )
}

// --- Share -----------------------------------------------------------------------------------

function LinkRow({ label, url, note }: { label: string; url: string; note?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="st-linkrow">
      <span>
        <b>{label}</b>
        {note && <small>{note}</small>}
      </span>
      <code title={url}>{url.replace(/^https?:\/\//, '')}</code>
      <button
        className="st-btn"
        onClick={async () => {
          if (await copyText(url)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }
        }}
        title="Copy the link"
      >
        {copied ? <Icon.check size={14} /> : <Icon.copy size={14} />}
      </button>
      <a className="st-btn" href={url} target="_blank" rel="noreferrer" title="Open it">
        <Icon.external size={14} />
      </a>
    </div>
  )
}

function Share({ ctx, onPhone, onShot }: { ctx: StudioCtx; onPhone: () => void; onShot: () => void }) {
  const p = ctx.project
  const page = (base: string) => {
    try {
      return new URL(ctx.path, base).href
    } catch {
      return base
    }
  }
  const same = !!p?.url && !!p.previewUrl && new URL(p.url).host === new URL(p.previewUrl).host
  const draft = ctx.site.last?.kind === 'publish' && ctx.site.last.url?.includes('/compare/') ? ctx.site.last.url : null
  return (
    <>
      {p?.url && <LinkRow label="Live site" url={page(p.url)} note={same ? 'also the client preview' : 'what everyone sees'} />}
      {p?.previewUrl && !same && <LinkRow label="Client preview" url={page(p.previewUrl)} note="for checking before launch" />}
      {!p?.url && !p?.previewUrl && <p className="st-muted">This site has no live or preview address set.</p>}
      {same && <p className="st-tip">This site’s preview and live addresses are the same, so whatever you push live is what clients see. To share edits before they’re live, use your phone preview or a screenshot, or save as a draft and share the pull request.</p>}
      {draft && <LinkRow label="Draft for review" url={draft} note="a pull request on GitHub" />}
      <div className="st-row">
        <button className="st-pill" onClick={onPhone}>
          <Icon.qr size={13} /> Phone preview
        </button>
        <button className="st-pill" onClick={onShot}>
          <Icon.camera size={13} /> Client screenshot
        </button>
      </div>
    </>
  )
}

// --- History ---------------------------------------------------------------------------------

function History({ ctx }: { ctx: StudioCtx }) {
  const [commits, setCommits] = useState<HistoryCommit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ sha: string; mode: 'one' | 'back-to' } | null>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    getJson<{ commits: HistoryCommit[] }>(`./api/studio/history?${q({ project: ctx.projectId })}`)
      .then((d) => setCommits(d.commits))
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId, ctx.site.sha])
  const go = async () => {
    if (!confirm) return
    try {
      await post('./api/studio/revert', { projectId: ctx.projectId, sha: confirm.sha, mode: confirm.mode })
      ctx.refresh()
    } catch (e) {
      ctx.say((e as Error).message)
    }
    setConfirm(null)
  }
  if (error) return <p className="st-error">{error}</p>
  if (!commits) return <Spin>Reading the history…</Spin>
  const saved = ctx.site.changed.length > 0
  const blocked = ctx.working || ctx.ops.length > 0 || saved
  const shown = more ? commits : commits.slice(0, 12)
  const wait = ctx.ops.length ? 'save or take back your canvas edits first' : saved ? 'push live or discard your saved edits first' : ''
  return (
    <>
      <p className="st-tip">Every change to the site, newest first. Undoing one makes a saved change you review and push live as usual{wait ? `: ${wait}` : ''}.</p>
      <ol className="st-history">
        {shown.map((c, i) => (
          <li key={c.sha} data-studio={c.studio || undefined}>
            <div>
              <b title={c.title}>{c.title}</b>
              <small>
                {c.author} · {relTime(c.date)} · <code>{c.sha.slice(0, 7)}</code>
                {c.studio && <em> Studio</em>}
                {i === 0 && <em> latest</em>}
              </small>
              {confirm?.sha === c.sha && (
                <div className="st-confirm">
                  <span>{confirm.mode === 'one' ? 'Undo just this change, keeping everything after it?' : `Put the whole site back to how it was after this, undoing the ${i} change${i === 1 ? '' : 's'} since?`}</span>
                  <button className="st-pill" data-tone="bad" onClick={go}>
                    Yes
                  </button>
                  <button className="st-link" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {!c.merge && (
              <Menu icon={<Icon.more size={15} />} title={wait ? `Roll back: ${wait}` : 'Roll back'} disabled={blocked}>
                {(done) => (
                  <>
                    <MenuItem
                      icon={<Icon.undo size={14} />}
                      onClick={() => {
                        done()
                        setConfirm({ sha: c.sha, mode: 'one' })
                      }}
                    >
                      Undo just this change
                    </MenuItem>
                    {i > 0 && (
                      <MenuItem
                        icon={<Icon.history size={14} />}
                        tone="bad"
                        onClick={() => {
                          done()
                          setConfirm({ sha: c.sha, mode: 'back-to' })
                        }}
                      >
                        Go back to this version
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
            )}
          </li>
        ))}
      </ol>
      {commits.length > 12 && (
        <button className="st-link" onClick={() => setMore(!more)}>
          {more ? 'Fewer' : `All ${commits.length}`}
        </button>
      )}
      {ctx.site.last?.kind === 'revert' && <Result r={ctx.site.last} />}
    </>
  )
}

// --- Review & push live ------------------------------------------------------------------------

type ReviewTab = 'changes' | 'shots' | 'checks'

export function Review({ ctx, onClose }: { ctx: StudioCtx; onClose: () => void }) {
  const s = ctx.site
  const [tab, setTab] = useState<ReviewTab>('changes')
  const [diff, setDiff] = useState<string | null>(null)
  const [checks, setChecks] = useState<PreCheck[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sure, setSure] = useState(false)
  const [later, setLater] = useState(false)
  useEffect(() => {
    getJson<{ diff: string }>(`./api/studio/diff?${q({ project: s.projectId })}`)
      .then((d) => setDiff(d.diff ?? ''))
      .catch(() => setDiff(''))
    setChecks(null)
    getJson<{ checks: PreCheck[] }>(`./api/studio/checks?${q({ project: s.projectId })}`)
      .then((d) => setChecks(d.checks))
      .catch((e) => setChecks([{ level: 'improve', label: 'Checks didn’t run', detail: (e as Error).message }]))
  }, [s.projectId, s.changed.length])
  const go = async (url: string, body: Record<string, unknown>) => {
    setError(null)
    try {
      await post(url, { projectId: s.projectId, ...body })
      ctx.refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const last = s.last && ['publish', 'discard'].includes(s.last.kind) ? s.last : null
  const fix = checks?.filter((c) => c.level === 'fix').length ?? 0
  const improve = checks?.filter((c) => c.level === 'improve').length ?? 0
  return (
    <Modal
      title={`Push ${ctx.project?.name ?? 'the site'} live`}
      onClose={onClose}
      wide={s.changed.length > 0}
      tall={s.changed.length > 0}
      footer={
        s.changed.length > 0 ? (
          <>
            <button className="st-pill" data-tone="bad" disabled={ctx.working} onClick={() => (sure ? go('./api/studio/discard', {}) : setSure(true))} onBlur={() => setSure(false)} title="Throw away every saved edit not yet live">
              {sure ? 'Click again to discard' : 'Discard all'}
            </button>
            <span className="st-gap" />
            {fix > 0 && (
              <button className="st-link st-warn" onClick={() => setTab('checks')}>
                {fix} check{fix === 1 ? '' : 's'} to sort
              </button>
            )}
            <button className="st-pill" aria-pressed={later} onClick={() => setLater(!later)} disabled={ctx.working} title="Book a time for it to go live">
              <Icon.clock size={13} /> Later
            </button>
            <button className="st-pill" disabled={ctx.working} onClick={() => go('./api/studio/publish', { draft: true })} title="Push to a new branch and open a pull request, so someone can check it before it goes live">
              Save as draft
            </button>
            <button className="st-primary" data-live disabled={ctx.working} onClick={() => go('./api/studio/publish', { draft: false })}>
              Push live
            </button>
          </>
        ) : undefined
      }
    >
      {s.changed.length > 0 ? (
        <>
          <div className="st-review-tabs">
            <Seg
              value={tab}
              label="Review"
              onChange={setTab}
              options={[
                ['changes', `Changes (${s.notes.length || s.changed.length})`],
                ['shots', 'Before & after'],
                ['checks', checks ? `Checks${fix ? ` (${fix} to sort)` : improve ? ` (${improve} to improve)` : ' ✓'}` : 'Checks…'],
              ]}
            />
          </div>
          {later && <Schedule ctx={ctx} />}
          {tab === 'changes' && (
            <>
              <p className="st-muted">
                One commit to <b>{s.branch}</b> on GitHub, which the site’s own deploy picks up. {s.changed.length} file{s.changed.length === 1 ? '' : 's'} changed.
              </p>
              {s.notes.length > 0 && (
                <ol className="st-notes">
                  {s.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ol>
              )}
              <Diff text={diff} />
            </>
          )}
          {tab === 'shots' && <BeforeAfter ctx={ctx} />}
          {tab === 'checks' && <Checks checks={checks} onGo={(p) => (ctx.go(p), onClose())} />}
        </>
      ) : (
        <p className="st-muted">Nothing waiting to go live.</p>
      )}
      {error && <p className="st-error">{error}</p>}
      {ctx.working && <Spin>{s.message}</Spin>}
      {last && <Result r={last} />}
    </Modal>
  )
}

function Checks({ checks, onGo }: { checks: PreCheck[] | null; onGo: (page: string) => void }) {
  if (!checks) return <Spin>Checking the changed pages…</Spin>
  return (
    <ul className="st-checks">
      {checks.map((c, i) => (
        <li key={i} data-level={c.level}>
          <LevelIcon level={c.level} />
          <div>
            <b>{c.label}</b>
            <p>{c.detail}</p>
            {c.page && (
              <button className="st-pill" onClick={() => onGo(c.page!)}>
                Open {where(c.page)}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** the live page now, and the same page with the saved edits, side by side */
function BeforeAfter({ ctx }: { ctx: StudioCtx }) {
  const pages = ctx.site.touched.length ? ctx.site.touched : [ctx.path]
  const [page, setPage] = useState(pages.includes(ctx.path) ? ctx.path : pages[0])
  const [device, setDevice] = useState<'mobile' | 'laptop'>('laptop')
  const [shots, setShots] = useState<Record<string, string | { error: string }>>({})
  const size = device === 'mobile' ? { width: 390, height: 844, mobile: true } : { width: 1440, height: 900, mobile: false }
  const hasLive = !!(ctx.project?.url ?? ctx.project?.previewUrl)
  useEffect(() => {
    let gone = false
    for (const source of ['live', 'studio'] as const) {
      const key = `${source}|${page}|${device}`
      if (shots[key]) continue
      if (source === 'live' && !hasLive) continue
      // the saved edits only: the canvas's unsaved ones aren't part of this push
      postBlob('./api/studio/shot', { projectId: ctx.projectId, page, ...size, full: true, scale: 1, type: 'jpeg', source, ops: [] })
        .then((b) => !gone && setShots((x) => ({ ...x, [key]: URL.createObjectURL(b) })))
        .catch((e) => !gone && setShots((x) => ({ ...x, [key]: { error: (e as Error).message } })))
    }
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, device, ctx.projectId])
  const Shot = ({ source, label }: { source: 'live' | 'studio'; label: string }) => {
    const v = shots[`${source}|${page}|${device}`]
    return (
      <figure className="st-ba-shot" data-device={device}>
        <figcaption>{label}</figcaption>
        {source === 'live' && !hasLive ? <p className="st-muted">No live address set.</p> : !v ? <Spin>Taking the screenshot…</Spin> : typeof v === 'string' ? <img src={v} alt={label} /> : <p className="st-error">{v.error}</p>}
      </figure>
    )
  }
  return (
    <div className="st-ba">
      <div className="st-row">
        <select value={page} onChange={(e) => setPage(e.target.value)} aria-label="Page">
          {pages.map((p) => (
            <option key={p} value={p}>
              {where(p)}
            </option>
          ))}
        </select>
        <Seg
          small
          value={device}
          label="Screen"
          onChange={setDevice}
          options={[
            ['laptop', <>
              <Icon.desktop size={13} /> Laptop
            </>],
            ['mobile', <>
              <Icon.mobile size={13} /> Phone
            </>],
          ]}
        />
        <span className="st-muted">{pages.length > 1 ? `${pages.length} pages change` : ''}</span>
      </div>
      <div className="st-ba-pair">
        <Shot source="live" label="Live now" />
        <Shot source="studio" label="After pushing" />
      </div>
    </div>
  )
}

function Diff({ text }: { text: string | null }) {
  if (text === null) return <p className="st-muted">Reading the changes…</p>
  if (!text.trim()) return null
  const files = text.split(/^diff --git /m).filter(Boolean)
  return (
    <div className="st-diff">
      {files.map((f, i) => {
        const name = f.match(/^a\/(\S+)/)?.[1] ?? 'file'
        const binary = /Binary files/.test(f)
        const lines = f.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
        return (
          <details key={i} open={files.length <= 4 && !binary}>
            <summary>
              {name} <span className="st-muted">{binary ? 'image' : `+${lines.filter((l) => l[0] === '+').length} −${lines.filter((l) => l[0] === '-').length}`}</span>
            </summary>
            {!binary && (
              <pre>
                {lines.slice(0, 300).map((l, j) => (
                  <span key={j} data-d={l[0]}>
                    {l.length > 400 ? `${l.slice(0, 400)}…` : l}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )}
          </details>
        )
      })}
    </div>
  )
}
