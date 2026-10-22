import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Project } from '../../data/types'
import { useData, useProject } from '../../data/store'
import { STATUS_LABEL, relTime } from '../../data/derive'
import { EFFORTS, MODELS, convsFor, fileUrl, hasTalk, openFile, uploadFile, useClaude, type Attachment, type Conversation, type MadeFile } from '../../shared/claude'
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

/** The messages of one conversation, newest at the bottom. */
export function ChatLog({ conv }: { conv: Conversation }) {
  const answer = useClaude((s) => s.answer)
  const retry = useClaude((s) => s.retry)
  const log = useRef<HTMLOListElement>(null)
  const last = conv.messages.at(-1)
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [conv.id, conv.messages.length, last?.text, last?.doing, last?.files?.length])
  const talked = conv.messages.some((m) => m.role === 'user')
  return (
    <ol ref={log} className="cl-log" aria-live="polite">
      {conv.messages.map((m, i) => (
        <li key={m.id} data-role={m.role} data-error={m.error || undefined}>
          <span>{m.role === 'claude' ? 'C' : 'D'}</span>
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
                {m.text && <Markdown text={m.text} />}
                {m.streaming && !m.doing && <i className="bp-caret" />}
              </>
            ) : (
              <p>{m.text}</p>
            )}
            {m.doing && (
              <p className="bp-doing">
                <i className="bp-caret" /> {m.doing}
              </p>
            )}
            {m.files && (
              <ul className="cl-files">
                {m.files.map((f) => (
                  <FileChip key={f.path} f={f} />
                ))}
              </ul>
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
            {m.role === 'claude' && !m.streaming && m.text && talked && i > 0 && (
              <div className="cl-acts">
                <Copy text={m.text} />
                {i === conv.messages.length - 1 && (
                  <button onClick={() => retry(conv.id)} disabled={conv.speaking} title="Ask again">
                    <Icon.refresh size={12} /> Retry
                  </button>
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
  const shown = convs.filter((c) => (hasTalk(c) || c.id === current) && (!find || c.title.toLowerCase().includes(find) || c.messages.some((m) => m.text.toLowerCase().includes(find))))
  return (
    <nav className={compact ? 'cl-tabs' : 'cl-threads'} aria-label="Threads">
      {!compact && <h3>Threads</h3>}
      <button className="cl-new" onClick={() => start(projectId)}>
        + New thread
      </button>
      {!compact && convs.filter(hasTalk).length > 3 && <input className="cl-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads" aria-label="Search threads" />}
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
