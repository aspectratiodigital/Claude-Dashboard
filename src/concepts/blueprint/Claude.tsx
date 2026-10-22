import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, relTime } from '../../data/derive'
import { EFFORTS, MODELS, convsFor, hasTalk, useClaude, type Conversation } from '../../shared/claude'
import { Icon } from '../../shared/icons'
import { useApp } from '../../store'

// Claude in Blueprint: the notes panel (bottom left), a building's Claude
// panel (in the callout) and the fullscreen workspace. All three show
// conversations from the same store (shared/claude.ts).

const LINK_NOTE = { checking: '', live: 'Claude Code', missing: 'Not connected', offline: 'Demo' }

function useConv(id: string | undefined) {
  return useClaude((s) => s.convs.find((c) => c.id === id))
}

/** The messages of one conversation, newest at the bottom. */
export function ChatLog({ conv }: { conv: Conversation }) {
  const answer = useClaude((s) => s.answer)
  const log = useRef<HTMLOListElement>(null)
  const last = conv.messages.at(-1)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [conv.id, conv.messages.length, last?.text, last?.doing])
  return (
    <ol ref={log} className="cl-log" aria-live="polite">
      {conv.messages.map((m) => (
        <li key={m.id} data-role={m.role} data-error={m.error || undefined}>
          <span>{m.role === 'claude' ? 'C' : 'D'}</span>
          <div>
            <p>
              {m.text}
              {m.streaming && !m.doing && <i className="bp-caret" />}
            </p>
            {m.doing && (
              <p className="bp-doing">
                <i className="bp-caret" /> {m.doing}
              </p>
            )}
            {m.asks && (
              <div className="bp-ask">
                <ul>
                  {m.asks.map((a) => (
                    <li key={a.rule}>{a.what}</li>
                  ))}
                </ul>
                {m.answered ? (
                  <em>{m.answered === 'allowed' ? 'Allowed' : 'Not allowed'}</em>
                ) : (
                  <div>
                    <button onClick={() => answer(conv.id, m.id, true)} disabled={conv.speaking}>
                      Allow
                    </button>
                    <button onClick={() => answer(conv.id, m.id, false)} disabled={conv.speaking}>
                      No
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Model and effort for every message from here on (kept between launches). */
export function ModelPicker() {
  const model = useClaude((s) => s.model)
  const effort = useClaude((s) => s.effort)
  const setModel = useClaude((s) => s.setModel)
  const setEffort = useClaude((s) => s.setEffort)
  return (
    <div className="cl-picker">
      <label title={MODELS.find((m) => m.id === model)?.note}>
        <span>Model</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Effort</span>
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          {EFFORTS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export function Composer({ conv, placeholder, autoFocus }: { conv: Conversation; placeholder: string; autoFocus?: boolean }) {
  const send = useClaude((s) => s.send)
  const stop = useClaude((s) => s.stop)
  const [text, setText] = useState('')
  return (
    <div className="cl-compose">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (conv.speaking) return stop(conv.id)
          send(conv.id, text)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Message Claude" autoFocus={autoFocus} />
        <button disabled={!conv.speaking && !text.trim()}>{conv.speaking ? 'Stop' : 'Send'}</button>
      </form>
      <ModelPicker />
    </div>
  )
}

/** The small Claude panel in the corner of the plan. */
export function Notes() {
  const selectedId = useApp((s) => s.selectedId)
  const projects = useData((s) => s.projects)
  const link = useClaude((s) => s.link)
  const ensure = useClaude((s) => s.ensure)
  const openFull = useClaude((s) => s.openFull)
  const [target, setTarget] = useState('')
  // follow the building you pick, but let the dropdown override it
  useEffect(() => {
    if (selectedId) setTarget(selectedId)
  }, [selectedId])
  const convId = useClaude((s) => s.current[target])
  useEffect(() => {
    if (!convId) ensure(target || null)
  }, [convId, target, ensure])
  const conv = useConv(convId)
  return (
    <section className="bp-notes">
      <header className="bp-notes-head">
        <h2>Notes with Claude</h2>
        {LINK_NOTE[link] && <small data-link={link}>{LINK_NOTE[link]}</small>}
        <button className="cl-icon" onClick={() => openFull(target || null)} title="Open Claude fullscreen" aria-label="Open Claude fullscreen">
          <Icon.expand size={14} />
        </button>
      </header>
      <label className="bp-notes-target">
        <span>About</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={conv?.speaking}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {conv && (
        <>
          <ChatLog conv={conv} />
          <Composer conv={conv} placeholder={target ? 'Ask Claude to look at or work on this project' : 'Ask Claude about your sites'} />
        </>
      )}
    </section>
  )
}

/** Thread tabs for one project: every conversation about it since the app opened. */
function Threads({ projectId, compact }: { projectId: string | null; compact?: boolean }) {
  const all = useClaude((s) => s.convs)
  const convs = convsFor(all, projectId)
  const current = useClaude((s) => s.current[projectId ?? ''])
  const pick = useClaude((s) => s.pick)
  const start = useClaude((s) => s.start)
  const remove = useClaude((s) => s.remove)
  const shown = convs.filter((c) => hasTalk(c) || c.id === current)
  return (
    <nav className={compact ? 'cl-tabs' : 'cl-threads'} aria-label="Threads">
      {!compact && <h3>Threads</h3>}
      <button className="cl-new" onClick={() => start(projectId)}>
        + New thread
      </button>
      <ul>
        {shown.map((c) => (
          <li key={c.id}>
            <button aria-pressed={c.id === current} onClick={() => pick(c.id)} data-speaking={c.speaking || undefined}>
              <b>{c.title}</b>
              <span>{c.speaking ? 'Working…' : `${c.messages.filter((m) => m.role === 'user').length} message${c.messages.filter((m) => m.role === 'user').length === 1 ? '' : 's'} · ${relTime(new Date(c.updated).toISOString())}`}</span>
            </button>
            {!compact && hasTalk(c) && (
              <button className="cl-del" onClick={() => window.confirm(`Delete “${c.title}”?`) && remove(c.id)} title="Delete this thread" aria-label={`Delete ${c.title}`}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Claude for one building, shown in place of its details. */
export function ProjectClaude({ project }: { project: Project }) {
  const ensure = useClaude((s) => s.ensure)
  const openFull = useClaude((s) => s.openFull)
  const convId = useClaude((s) => s.current[project.id])
  useEffect(() => {
    if (!convId) ensure(project.id)
  }, [convId, project.id, ensure])
  const conv = useConv(convId)
  if (!conv) return null
  return (
    <div className="cl-project">
      <Threads projectId={project.id} compact />
      <ChatLog conv={conv} />
      <Composer conv={conv} placeholder={`Ask Claude about ${project.name}`} autoFocus />
      <button className="bp-open" onClick={() => openFull(project.id)}>
        Open fullscreen <span>several threads side by side</span>
      </button>
    </div>
  )
}

/** Claude fullscreen: projects on the left, their threads, and the open conversation. */
export function ClaudeFull() {
  const full = useClaude((s) => s.full)
  const fullProject = useClaude((s) => s.fullProject)
  const setFullProject = useClaude((s) => s.setFullProject)
  const closeFull = useClaude((s) => s.closeFull)
  const link = useClaude((s) => s.link)
  const convs = useClaude((s) => s.convs)
  const convId = useClaude((s) => s.current[fullProject])
  const conv = useConv(convId)
  const projects = useData((s) => s.projects)
  const project = useProject(fullProject || null)
  const ensure = useClaude((s) => s.ensure)
  useEffect(() => {
    if (full && !convId) ensure(fullProject || null)
  }, [full, convId, fullProject, ensure])
  if (!full) return null
  const counts = (id: string | null) => {
    const mine = convsFor(convs, id)
    return { talks: mine.filter(hasTalk).length, working: mine.some((c) => c.speaking) }
  }
  const all = counts(null)
  return (
    <div className="cl-full" role="dialog" aria-label="Claude">
      <aside className="cl-side">
        <header>
          <h2>
            <Icon.claude size={16} /> Claude
          </h2>
          {LINK_NOTE[link] && <small data-link={link}>{LINK_NOTE[link]}</small>}
        </header>
        <ul>
          <li>
            <button aria-pressed={fullProject === ''} onClick={() => setFullProject('')}>
              <i data-status="all" />
              <b>All projects</b>
              <Count {...all} />
            </button>
          </li>
          {projects.map((p) => (
            <li key={p.id}>
              <button aria-pressed={fullProject === p.id} onClick={() => setFullProject(p.id)}>
                <i data-status={p.status} title={STATUS_LABEL[p.status]} />
                <b>{p.name}</b>
                <Count {...counts(p.id)} />
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <Threads projectId={fullProject || null} />
      <main className="cl-main">
        <header>
          <div>
            <h2>{project ? project.name : 'All projects'}</h2>
            <p>{project ? `${project.repo} · ${project.reason}` : 'Questions about every site at once. Pick a project on the left to have Claude work in its folder.'}</p>
          </div>
          <button className="cl-close" onClick={closeFull}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        {conv && (
          <>
            <ChatLog conv={conv} />
            <Composer conv={conv} placeholder={project ? `Ask Claude to look at or work on ${project.name}` : 'Ask Claude about your sites'} autoFocus key={conv.id} />
          </>
        )}
      </main>
    </div>
  )
}

function Count({ talks, working }: { talks: number; working: boolean }) {
  if (working) return <small data-working>working</small>
  return talks ? <small>{talks}</small> : null
}
