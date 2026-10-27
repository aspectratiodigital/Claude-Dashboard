import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, relTime } from '../../data/derive'
import { ASK_TEXT, EFFORTS, MODELS, PERMISSIONS, THREAD_STATES, cleanReply, convsFor, fileUrl, hasTalk, historyConvId, openFile, threadState, uploadFile, useClaude, useHistory, type Attachment, type ClaudeTask, type Conversation, type HistoryThread, type MadeFile, type ThreadState } from '../../shared/claude'
import { KnowledgePanel, ToolsPanel, useExtras } from './ClaudeExtras'
import { Icon } from '../../shared/icons'
import { useApp } from '../../store'

// Claude in Blueprint: the notes panel (bottom left), a building's Claude
// panel (in the callout) and the fullscreen workspace. All three show
// conversations from the same store (shared/claude.ts).

const LINK_NOTE = { checking: '', live: 'Claude Code', missing: 'Not connected', offline: 'Demo' }

function useConv(id: string | undefined) {
  return useClaude((s) => s.convs.find((c) => c.id === id))
}

const MD: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

/** Claude's reply, as Markdown (raw HTML is shown as text, never run). */
function Markdown({ text }: { text: string }) {
  return (
    <div className="cl-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** A file you attached. */
function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const [broken, setBroken] = useState(false)
  return (
    <li className="cl-chip">
      {IMAGE.test(a.name) && !broken ? <img src={fileUrl(a.path)} alt="" onError={() => setBroken(true)} /> : <Icon.file size={14} />}
      <b title={a.name}>{a.name}</b>
      <span>{size(a.size)}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`}>
          ✕
        </button>
      )}
    </li>
  )
}

/** A file Claude wrote: preview, open, show in its folder or download. */
function FileChip({ f }: { f: MadeFile }) {
  const [msg, setMsg] = useState('')
  const [broken, setBroken] = useState(false)
  const open = async (reveal: boolean) => setMsg((await openFile(f.path, reveal)) ?? '')
  return (
    <li className="cl-file">
      {IMAGE.test(f.name) && !broken && <img src={fileUrl(f.path)} alt={f.name} onError={() => setBroken(true)} />}
      <div>
        <Icon.file size={14} />
        <b title={f.path}>{f.name}</b>
        <span>{f.action}</span>
      </div>
      <div>
        <button onClick={() => open(false)}>Open</button>
        <button onClick={() => open(true)}>Show in folder</button>
        <a href={fileUrl(f.path, true)} download={f.name}>
          <Icon.download size={12} /> Download
        </a>
      </div>
      {msg && <em>{msg}</em>}
    </li>
  )
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        })
      }
      title="Copy this reply"
    >
      <Icon.copy size={12} /> {done ? 'Copied' : 'Copy'}
    </button>
  )
}

// Code Claude edits in the project shows as one "Changed N files" line; documents, images and
// exports it makes get a card each, with Open, Show in folder and Download.
const CODE = /\.(astro|[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|html?|json|ya?ml|toml|md|mdx|liquid|php|py|rb|go|rs|java|kt|swift|sh|ps1|lock|env|gitignore|svg|xml|graphql|gql|sql|prisma)$/i
const isDeliverable = (f: MadeFile) => f.action === 'created' && !CODE.test(f.name)

function ChangedFiles({ files }: { files: MadeFile[] }) {
  const [open, setOpen] = useState(false)
  const made = files.filter((f) => f.action === 'created').length
  return (
    <div className="cl-changed">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon.file size={12} />
        <b>
          Changed {files.length} file{files.length === 1 ? '' : 's'}
        </b>
        {made > 0 && <span>{made} new</span>}
        <i aria-hidden>{open ? '▾' : '▸'}</i>
      </button>
      {open && (
        <ul>
          {files.map((f) => (
            <li key={f.path} title={f.path}>
              <b>{f.name}</b> <span>{f.action}</span>
              <button onClick={() => openFile(f.path, false)}>Open</button>
              <button onClick={() => openFile(f.path, true)}>Show in folder</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What Claude said between steps, folded into one line under the answer. */
function Steps({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="cl-changed cl-steps">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <b>
          Worked through {steps.length} step{steps.length === 1 ? '' : 's'}
        </b>
        <i aria-hidden>{open ? '▾' : '▸'}</i>
      </button>
      {open && (
        <ol>
          {steps.map((t, i) => (
            <li key={i}>
              <Markdown text={t} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Claude's plan while it works: ticks as it goes, and gone once it's done. */
function Tasks({ tasks }: { tasks: ClaudeTask[] }) {
  const done = tasks.filter((t) => t.status === 'completed').length
  return (
    <div className="cl-tasks" role="status">
      <small>
        Tasks · {done} of {tasks.length} done
      </small>
      <ul>
        {tasks.map((t, i) => (
          <li key={i} data-status={t.status}>
            <i aria-hidden>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '✱' : '○'}</i>
            <span>{t.status === 'in_progress' && t.active ? t.active : t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A tiny crane moving a block back and forth, for while Claude works. */
function Crane() {
  return (
    <svg className="cl-crane" viewBox="0 0 30 16" width="30" height="16" aria-hidden>
      <path className="cl-crane-frame" d="M0 15.5h30M4 15.5V1.5M1 2.5h26M4 1.5 1 2.5M4 4.5l3-2M4 7.5l3-5" />
      <rect className="cl-crane-weight" x="0.5" y="2.5" width="2.5" height="2" />
      <g className="cl-crane-trolley">
        <rect x="8" y="2" width="2.5" height="1.2" />
        <rect className="cl-crane-cable" x="9" y="3" width="0.5" height="9.5" />
        <rect className="cl-crane-block" x="7.5" y="12.5" width="3.5" height="3" />
      </g>
    </svg>
  )
}

/** The one line at the bottom while Claude works: what it's doing now, replaced by the next thing. */
function Working({ text }: { text: string }) {
  return (
    <p className="cl-working" role="status">
      <Crane />
      <span key={text} title={text}>
        {text}
      </span>
    </p>
  )
}

/** The messages of one conversation, newest at the bottom. */
export function ChatLog({ conv }: { conv: Conversation }) {
  const answer = useClaude((s) => s.answer)
  const retry = useClaude((s) => s.retry)
  const log = useRef<HTMLOListElement>(null)
  const last = conv.messages.at(-1)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [conv.id, conv.messages.length, last?.text, last?.doing, last?.streaming, last?.files?.length])
  const talked = conv.messages.some((m) => m.role === 'user')
  return (
    <ol ref={log} className="cl-log" aria-live="polite">
      {conv.messages.map((m, i) =>
        m.answered && m.text === ASK_TEXT ? null : (
          <li key={m.id} data-role={m.role} data-error={m.error || undefined}>
            <span>{m.role === 'claude' ? 'C' : (m.author?.[0] ?? 'D').toUpperCase()}</span>
            <div>
              {m.attachments && (
                <ul className="cl-chips">
                  {m.attachments.map((a) => (
                    <AttachmentChip key={a.id} a={a} />
                  ))}
                </ul>
              )}
              {m.role === 'claude' && !m.error ? (
                <>
                  {m.text && <Markdown text={cleanReply(m.text, m.streaming)} />}
                  {m.streaming && !!m.text && <i className="bp-caret" />}
                </>
              ) : (
                <p>{m.text}</p>
              )}
              {!m.streaming && m.steps?.length ? <Steps steps={m.steps} /> : null}
              {m.files?.some(isDeliverable) && (
                <ul className="cl-files">
                  {m.files.filter(isDeliverable).map((f) => (
                    <FileChip key={f.path} f={f} />
                  ))}
                </ul>
              )}
              {m.files?.some((f) => !isDeliverable(f)) && <ChangedFiles files={m.files.filter((f) => !isDeliverable(f))} />}
              {m.links?.length ? (
                <ul className="cl-links">
                  {m.links.map((l, k) => (
                    <li key={k}>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.title} ↗</a> : <span>{l.title}</span>}</li>
                  ))}
                </ul>
              ) : null}
              {m.asks && !m.answered && (
                <div className="bp-ask">
                  <ul>
                    {m.asks.map((a) => (
                      <li key={a.rule} title={a.what}>
                        {a.what}
                      </li>
                    ))}
                  </ul>
                  <div>
                    <button onClick={() => answer(conv.id, m.id, true)} disabled={conv.speaking}>
                      Allow
                    </button>
                    <button onClick={() => answer(conv.id, m.id, false)} disabled={conv.speaking}>
                      No
                    </button>
                  </div>
                </div>
              )}
              {m.streaming && m.tasks?.length ? <Tasks tasks={m.tasks} /> : null}
              {m.streaming && <Working text={m.doing ?? (m.text ? 'Writing the reply' : 'Thinking')} />}
              {m.role === 'claude' && !m.streaming && m.text && talked && i > 0 && (
                <div className="cl-acts">
                  <Copy text={cleanReply(m.text)} />
                  {i === conv.messages.length - 1 && !conv.origin && (
                    <button onClick={() => retry(conv.id)} disabled={conv.speaking} title="Ask again">
                      <Icon.refresh size={12} /> Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          </li>
        ),
      )}
    </ol>
  )
}

const ORIGIN_STATE: Record<ThreadState, string> = { working: 'Working', waiting: 'Waiting on you', idle: 'Open', resolved: 'Resolved' }

/** Above the composer on an earlier thread: where it's from, and what writing in it does. */
function HistoryNote({ conv }: { conv: Conversation }) {
  const o = conv.origin
  if (!o) return null
  return (
    <p className="cl-origin">
      <b>{o.kind === 'project' ? `From the ${o.from} project` : `Claude Code on this computer, in ${o.from}`}</b>
      {o.kind === 'project' && <span data-state={o.state}>{ORIGIN_STATE[o.state]}</span>}
      {o.url && (
        <a href={o.url} target="_blank" rel="noreferrer">
          Open in Claude ↗
        </a>
      )}
      <em>Writing below carries this on as a new thread here, with the conversation so far as context.</em>
    </p>
  )
}

/** Earlier threads for a project: its Claude project's threads (open first) and sessions on this computer. */
function Earlier({ projectId, find }: { projectId: string | null; find: string }) {
  const key = projectId ?? ''
  const list = useHistory((s) => s.lists[key]?.threads)
  const load = useHistory((s) => s.load)
  const open = useHistory((s) => s.open)
  const opening = useHistory((s) => s.opening)
  const error = useHistory((s) => s.error)
  const current = useClaude((s) => s.current[key])
  const [showResolved, setShowResolved] = useState(false)
  const [showLocal, setShowLocal] = useState(false)
  useEffect(() => load(projectId), [projectId, load])
  if (!list?.length) return null
  const shown = list.filter((t) => !find || t.title.toLowerCase().includes(find))
  const project = shown.filter((t) => t.kind === 'project')
  const projOpen = project.filter((t) => t.state !== 'resolved')
  const projDone = project.filter((t) => t.state === 'resolved')
  const local = shown.filter((t) => t.kind === 'local')
  const names = [...new Set(project.map((t) => t.from))]
  const row = (t: HistoryThread) => (
    <li key={t.id} data-state={t.state}>
      <button aria-pressed={historyConvId(projectId, t) === current} onClick={() => open(projectId, t)} title={t.kind === 'project' ? `${t.from} · ${ORIGIN_STATE[t.state]}` : `Claude Code in ${t.from}`}>
        <b>
          <i className="cl-state" data-state={t.state === 'working' ? 'waiting' : t.state} aria-hidden />
          {t.title}
        </b>
        <span>{opening === t.id ? 'Opening…' : `${t.messages} message${t.messages === 1 ? '' : 's'} · ${relTime(t.updated)}`}</span>
      </button>
    </li>
  )
  const fold = (label: string, n: number, open: boolean, toggle: () => void) => (
    <button className="cl-group-head" onClick={toggle} aria-expanded={open || !!find}>
      {label} <span>{n}</span> <i aria-hidden>{open || find ? '▾' : '▸'}</i>
    </button>
  )
  return (
    <div className="cl-earlier">
      <h3>Earlier</h3>
      {error && <p className="cl-err">{error}</p>}
      {project.length > 0 && (
        <section className="cl-group" data-state="project">
          <h4 className="cl-group-head" title="From your Claude project, as of its last export">
            {names.length === 1 ? names[0] : 'Claude projects'} <span>{projOpen.length}</span>
          </h4>
          <ul>{projOpen.map(row)}</ul>
          {projDone.length > 0 && (
            <section className="cl-group" data-state="resolved">
              {fold('Resolved', projDone.length, showResolved, () => setShowResolved((v) => !v))}
              {(showResolved || !!find) && <ul>{projDone.map(row)}</ul>}
            </section>
          )}
        </section>
      )}
      {local.length > 0 && (
        <section className="cl-group" data-state="local">
          {fold('On this computer', local.length, showLocal, () => setShowLocal((v) => !v))}
          {(showLocal || !!find) && <ul>{local.map(row)}</ul>}
        </section>
      )}
    </div>
  )
}

/** In a building's Claude panel: how many earlier threads there are, opening them fullscreen. */
function EarlierLink({ projectId }: { projectId: string }) {
  const list = useHistory((s) => s.lists[projectId]?.threads)
  const load = useHistory((s) => s.load)
  const openFull = useClaude((s) => s.openFull)
  useEffect(() => load(projectId), [projectId, load])
  const open = list?.filter((t) => t.kind === 'project' && t.state !== 'resolved').length ?? 0
  if (!list?.length) return null
  return (
    <button className="cl-new cl-earlier-link" onClick={() => openFull(projectId)} title="See this site's threads from Claude, fullscreen">
      Earlier threads: {list.length}
      {open ? ` (${open} open)` : ''}
    </button>
  )
}

/** Model and effort for every message from here on (kept between launches). */
export function ModelPicker() {
  const model = useClaude((s) => s.model)
  const effort = useClaude((s) => s.effort)
  const setModel = useClaude((s) => s.setModel)
  const setEffort = useClaude((s) => s.setEffort)
  const permission = useClaude((s) => s.permission)
  const setPermission = useClaude((s) => s.setPermission)
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
      <label title={PERMISSIONS.find((m) => m.id === permission)?.note}>
        <span>Permissions</span>
        <select value={permission} onChange={(e) => setPermission(e.target.value)}>
          {PERMISSIONS.map((m) => (
            <option key={m.id} value={m.id} title={m.note}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export function Composer({ conv, placeholder, autoFocus, takesInserts }: { conv: Conversation; placeholder: string; autoFocus?: boolean; takesInserts?: boolean }) {
  const send = useClaude((s) => s.send)
  const stop = useClaude((s) => s.stop)
  const live = useClaude((s) => s.link === 'live')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [err, setErr] = useState('')
  const [over, setOver] = useState(false)
  const [pick, setPick] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const chooser = useRef<HTMLInputElement>(null)
  const { data: extras } = useExtras(live ? conv.projectId : undefined)
  const slash = /^\/([\w:.-]*)$/.exec(text)
  const matches = slash && extras ? extras.items.filter((e) => e.name.toLowerCase().includes(slash[1].toLowerCase())).slice(0, 8) : []

  // grow with the text, up to a few lines
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])
  useEffect(() => setPick(0), [slash?.[1]])
  useEffect(() => {
    if (!takesInserts) return
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail)
      area.current?.focus()
    }
    window.addEventListener('cl-insert', on)
    return () => window.removeEventListener('cl-insert', on)
  }, [takesInserts])

  const add = async (list: FileList | File[] | null) => {
    const all = [...(list ?? [])]
    if (!all.length) return
    if (!live) return setErr('Attaching files needs Claude Code on this computer.')
    setErr('')
    setUploading((n) => n + all.length)
    for (const f of all) {
      try {
        const a = await uploadFile(f)
        setFiles((x) => [...x, a])
      } catch (e) {
        setErr(`${f.name}: ${(e as Error).message}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }
  const submit = () => {
    if (conv.speaking) return stop(conv.id)
    if (uploading || (!text.trim() && !files.length)) return
    send(conv.id, text, files)
    setText('')
    setFiles([])
    setErr('')
  }
  const choose = (name: string) => {
    setText(`/${name} `)
    area.current?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        return choose(matches[pick]?.name ?? matches[0].name)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      add(e.clipboardData.files)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    add(e.dataTransfer.files)
  }
  return (
    <div
      className="cl-compose"
      data-over={over || undefined}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {matches.length > 0 && (
        <ul className="cl-slash" role="listbox" aria-label="Skills and commands">
          {matches.map((m, i) => (
            <li key={m.name} role="option" aria-selected={i === pick}>
              <button type="button" onMouseDown={(e) => (e.preventDefault(), choose(m.name))} onMouseEnter={() => setPick(i)}>
                <b>/{m.name}</b>
                <em>{m.source}</em>
                {m.description && <span>{m.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(files.length > 0 || uploading > 0) && (
        <ul className="cl-chips">
          {files.map((f) => (
            <AttachmentChip key={f.id} a={f} onRemove={() => setFiles((x) => x.filter((y) => y.id !== f.id))} />
          ))}
          {uploading > 0 && <li className="cl-chip">Attaching…</li>}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <button type="button" className="cl-clip" onClick={() => chooser.current?.click()} title="Attach files (or drop or paste them)" aria-label="Attach files">
          <Icon.paperclip size={14} />
        </button>
        <input ref={chooser} type="file" multiple hidden onChange={(e) => add(e.target.files).then(() => (e.target.value = ''))} />
        <textarea ref={area} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste} placeholder={placeholder} aria-label="Message Claude" autoFocus={autoFocus} />
        <button disabled={!conv.speaking && (uploading > 0 || (!text.trim() && !files.length))}>{conv.speaking ? 'Stop' : 'Send'}</button>
      </form>
      {err && <p className="cl-err">{err}</p>}
      <HistoryNote conv={conv} />
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
  const [q, setQ] = useState('')
  const find = q.trim().toLowerCase()
  const [showResolved, setShowResolved] = useState(false)
  const earlier = useHistory((s) => s.lists[projectId ?? '']?.threads.length ?? 0)
  const shown = convs.filter((c) => (hasTalk(c) || c.id === current) && (!find || c.title.toLowerCase().includes(find) || c.messages.some((m) => m.text.toLowerCase().includes(find))))
  const groups = THREAD_STATES.map((g) => ({ ...g, list: shown.filter((c) => (hasTalk(c) ? threadState(c) : 'idle') === g.id) })).filter((g) => g.list.length)
  const row = (c: Conversation) => {
    const st: ThreadState = hasTalk(c) ? threadState(c) : 'idle'
    const n = c.messages.filter((m) => m.role === 'user').length
    return (
      <li key={c.id} data-state={st}>
        <button aria-pressed={c.id === current} onClick={() => pick(c.id)} data-speaking={c.speaking || undefined} title={THREAD_STATES.find((x) => x.id === st)?.label}>
          <b>
            <i className="cl-state" data-state={st} aria-hidden />
            {c.title}
          </b>
          <span>{c.speaking ? 'Working…' : `${n} message${n === 1 ? '' : 's'} · ${relTime(new Date(c.updated).toISOString())}`}</span>
        </button>
        {!compact && hasTalk(c) && (
          <button className="cl-del" onClick={() => window.confirm(`Delete “${c.title}”?`) && remove(c.id)} title="Delete this thread" aria-label={`Delete ${c.title}`}>
            ✕
          </button>
        )}
      </li>
    )
  }
  if (compact)
    return (
      <nav className="cl-tabs" aria-label="Threads">
        <button className="cl-new" onClick={() => start(projectId)}>
          + New thread
        </button>
        <ul>{groups.flatMap((g) => (g.id === 'resolved' ? g.list.filter((c) => c.id === current) : g.list)).map(row)}</ul>
        {projectId && <EarlierLink projectId={projectId} />}
      </nav>
    )
  return (
    <nav className={compact ? 'cl-tabs' : 'cl-threads'} aria-label="Threads">
      {!compact && <h3>Threads</h3>}
      <button className="cl-new" onClick={() => start(projectId)}>
        + New thread
      </button>
      {!compact && convs.filter(hasTalk).length + earlier > 3 && <input className="cl-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads" aria-label="Search threads" />}
      {groups.map((g) => (
        <section key={g.id} className="cl-group" data-state={g.id}>
          {g.id === 'resolved' ? (
            <button className="cl-group-head" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved || !!find}>
              {g.label} <span>{g.list.length}</span> <i aria-hidden>{showResolved || find ? '▾' : '▸'}</i>
            </button>
          ) : (
            <h4 className="cl-group-head">
              {g.label} <span>{g.list.length}</span>
            </h4>
          )}
          {(g.id !== 'resolved' || showResolved || !!find) && <ul>{g.list.map(row)}</ul>}
        </section>
      ))}
      <Earlier projectId={projectId} find={find} />
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
  const [drawer, setDrawer] = useState<'knowledge' | 'tools' | null>(null)
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
          <div className="cl-head-acts">
            {conv && hasTalk(conv) && !conv.speaking && !conv.origin && (
              <button className="cl-tool" onClick={() => useClaude.getState().resolve(conv.id, conv.status !== 'resolved')} title={conv.status === 'resolved' ? 'Open this thread again' : 'Mark this thread finished'}>
                {conv.status === 'resolved' ? 'Reopen' : '✓ Resolve'}
              </button>
            )}
            <button className="cl-tool" aria-pressed={drawer === 'knowledge'} onClick={() => setDrawer((d) => (d === 'knowledge' ? null : 'knowledge'))} title="Instructions and files Claude uses in every thread">
              <Icon.page size={13} /> Instructions &amp; files
            </button>
            <button className="cl-tool" aria-pressed={drawer === 'tools'} onClick={() => setDrawer((d) => (d === 'tools' ? null : 'tools'))} title="Your skills, plugins and MCP servers">
              <Icon.bolt size={13} /> Skills &amp; tools
            </button>
            <button className="cl-close" onClick={closeFull}>
              Close <kbd>Esc</kbd>
            </button>
          </div>
        </header>
        <div className="cl-body" data-drawer={drawer || undefined}>
          {conv && (
            <>
              <ChatLog conv={conv} />
              <Composer conv={conv} placeholder={project ? `Ask Claude to look at or work on ${project.name}. Type / for skills` : 'Ask Claude about your sites. Type / for skills'} autoFocus takesInserts key={conv.id} />
            </>
          )}
          {drawer === 'knowledge' && <KnowledgePanel projectId={fullProject || null} name={project?.name ?? 'All projects'} onClose={() => setDrawer(null)} />}
          {drawer === 'tools' && <ToolsPanel projectId={fullProject || null} onClose={() => setDrawer(null)} />}
        </div>
      </main>
    </div>
  )
}

function Count({ talks, working }: { talks: number; working: boolean }) {
  if (working) return <small data-working>working</small>
  return talks ? <small>{talks}</small> : null
}
