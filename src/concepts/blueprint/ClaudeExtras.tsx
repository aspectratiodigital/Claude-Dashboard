import { useCallback, useEffect, useRef, useState } from 'react'
import { useData } from '../../data/store'
import { relTime } from '../../data/derive'
import { Icon } from '../../shared/icons'

// The fullscreen workspace's side drawers: project knowledge (instructions
// and files Claude reads in every thread, like a Claude project) and the
// skills, plugins and MCP servers your Claude Code already has.

export interface Extra {
  name: string
  description: string
  kind: 'skill' | 'command'
  source: string
}

export interface Extras {
  items: Extra[]
  plugins: { name: string; description: string; enabled: boolean; skills: number; commands: number; source: string }[]
  mcp: { name: string; type: string; scope: string }[]
  suggestions: { id: string; name: string; why: string }[]
}

const cache = new Map<string, { at: number; data: Extras }>()

/** Skills and commands for the "/" picker, refreshed every few minutes. `undefined` skips loading. */
export function useExtras(projectId: string | null | undefined) {
  const key = projectId ?? ''
  const api = useData((s) => s.api)
  const [data, setData] = useState<Extras | null>(cache.get(key)?.data ?? null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (projectId === undefined || !api) return
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < 3 * 60_000 && !nonce) return setData(hit.data)
    let live = true
    fetch(`./api/claude/extras?project=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Extras | null) => {
        if (!d || !live) return
        cache.set(key, { at: Date.now(), data: d })
        setData(d)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [key, projectId, api, nonce])
  const reload = useCallback(() => {
    cache.delete(key)
    setNonce((n) => n + 1)
  }, [key])
  return { data, reload }
}

/** Put text into the fullscreen composer (picking a skill from the drawer). */
export const insertIntoComposer = (text: string) => window.dispatchEvent(new CustomEvent('cl-insert', { detail: text }))

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

interface Knowledge {
  instructions: string
  files: { name: string; size: number; updated: string }[]
}

export function KnowledgePanel({ projectId, name, onClose }: { projectId: string | null; name: string; onClose: () => void }) {
  const key = projectId || '_all'
  const api = useData((s) => s.api)
  const [k, setK] = useState<Knowledge | null>(null)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const pickFile = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!api) return
    setK(null)
    fetch(`./api/knowledge?project=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((d: Knowledge) => {
        setK(d)
        setText(d.instructions)
      })
      .catch(() => setMsg('Could not reach the local API'))
  }, [key, api])

  const post = async (url: string, body: BodyInit, type = 'application/json') => {
    setBusy(true)
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error ?? 'That didn’t work')
      setK(d as Knowledge)
      return true
    } catch (e) {
      setMsg((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (await post('./api/knowledge', JSON.stringify({ project: key, instructions: text }))) setMsg('Saved. Claude uses these from the next message.')
  }
  const add = async (files: FileList | null) => {
    for (const f of files ?? []) await post(`./api/knowledge/file?project=${encodeURIComponent(key)}&name=${encodeURIComponent(f.name)}`, f, 'application/octet-stream')
  }

  return (
    <aside className="cl-drawer" aria-label="Project knowledge">
      <header>
        <h3>{projectId ? `${name}: instructions and files` : 'Instructions for everything'}</h3>
        <button className="cl-icon" onClick={onClose} aria-label="Close">
          <Icon.close size={14} />
        </button>
      </header>
      {!api ? (
        <p className="bp-help">Project knowledge needs the dashboard's local API (the desktop app or npm run dev).</p>
      ) : (
        <>
          <label className="cl-field">
            <span>Instructions</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={projectId ? `How Claude should work on ${name}: tone of voice, brand colours, what not to touch, how to deploy…` : 'How you like Claude to work on every project: your studio, your stack, how you like answers.'}
            />
          </label>
          <div className="bp-actions">
            <button className="bp-open" onClick={save} disabled={busy || text === k?.instructions}>
              Save instructions
            </button>
          </div>
          <p className="bp-help">{projectId ? `Claude follows these in every thread about ${name}, on top of your instructions for everything.` : 'Claude follows these in every thread, for every project.'}</p>

          <h4>Files</h4>
          <ul className="cl-kfiles">
            {k?.files.map((f) => (
              <li key={f.name}>
                <Icon.file size={13} />
                <b title={f.name}>{f.name}</b>
                <span>
                  {kb(f.size)} · {relTime(f.updated)}
                </span>
                <button className="cl-del-inline" onClick={() => post('./api/knowledge', JSON.stringify({ project: key, remove: f.name }))} aria-label={`Remove ${f.name}`} title="Remove">
                  ✕
                </button>
              </li>
            ))}
            {k && !k.files.length && <li className="bp-help">No files yet. Add a brand guide, copy deck, price list or anything Claude should know.</li>}
          </ul>
          <div className="bp-actions">
            <button className="bp-open" onClick={() => pickFile.current?.click()} disabled={busy}>
              Add files
            </button>
            <input ref={pickFile} type="file" multiple hidden onChange={(e) => add(e.target.files).then(() => (e.target.value = ''))} />
          </div>
          <p className="bp-help">Claude reads the ones that help with each request. They're kept in your sync folder when you've set one, so your other computer has them too.</p>
        </>
      )}
      {msg && (
        <p className="bp-help" role="status">
          {msg}
        </p>
      )}
    </aside>
  )
}

export function ToolsPanel({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const { data, reload } = useExtras(projectId)
  const link = useData((s) => s.api)
  const [adding, setAdding] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const add = async (id: string) => {
    setAdding(id)
    try {
      const r = await fetch('./api/claude/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const d = await r.json().catch(() => ({}))
      setMsg(d.ok ? 'Added. Claude can use it from the next message.' : (d.error ?? d.output ?? 'That didn’t work'))
      reload()
    } finally {
      setAdding('')
    }
  }
  const match = (e: Extra) => !q || `${e.name} ${e.description}`.toLowerCase().includes(q.toLowerCase())
  const skills = data?.items.filter((i) => i.kind === 'skill' && match(i)) ?? []
  const commands = data?.items.filter((i) => i.kind === 'command' && match(i)) ?? []
  const remove = async (e: Extra) => {
    if (!window.confirm(`Remove the skill “${e.name}” from ${e.source === 'Project' ? 'this project' : 'Claude Code on this computer'}?`)) return
    const r = await fetch('./api/claude/skill/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.name, scope: e.source === 'Project' ? 'project' : 'you', project: projectId }) })
    const d = await r.json().catch(() => ({}))
    setMsg(r.ok ? `Removed ${e.name}.` : (d.error ?? 'That didn’t work'))
    reload()
  }
  const row = (e: Extra) => (
    <li key={e.name} className="cl-extra-row">
      <button onClick={() => insertIntoComposer(`/${e.name} `)} title="Use it in your next message">
        <b>/{e.name}</b>
        <em>{e.source}</em>
        {e.description && <span>{e.description}</span>}
      </button>
      {e.kind === 'skill' && (e.source === 'You' || e.source === 'Project') && (
        <button className="cl-del-inline" onClick={() => remove(e)} aria-label={`Remove ${e.name}`} title="Remove this skill">
          ✕
        </button>
      )}
    </li>
  )
  return (
    <aside className="cl-drawer" aria-label="Skills and tools">
      <header>
        <h3>Skills, plugins and tools</h3>
        <button className="cl-icon" onClick={onClose} aria-label="Close">
          <Icon.close size={14} />
        </button>
      </header>
      {!link ? (
        <p className="bp-help">These come from Claude Code on this computer, through the dashboard's local API.</p>
      ) : !data ? (
        <p className="bp-help">Looking in Claude Code…</p>
      ) : (
        <>
          <input className="cl-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter skills" />
          <p className="bp-help">Claude picks skills up by itself when they fit. To use one on purpose, click it or type / in the message box.</p>
          <h4>Skills ({skills.length})</h4>
          <ul className="cl-extras">{skills.map(row)}</ul>
          {!skills.length && <p className="bp-help">No skills found in ~/.claude/skills or your plugins.</p>}
          <AddSkill
            projectId={projectId}
            onAdded={(m) => {
              setMsg(m)
              reload()
            }}
          />
          {commands.length > 0 && (
            <>
              <h4>Commands ({commands.length})</h4>
              <ul className="cl-extras">{commands.map(row)}</ul>
            </>
          )}
          <h4>Plugins ({data.plugins.length})</h4>
          <ul className="cl-kfiles">
            {data.plugins.map((p) => (
              <li key={p.name} data-off={!p.enabled || undefined}>
                <Icon.layers size={13} />
                <b title={p.description}>{p.name}</b>
                <span>
                  {p.enabled ? `${p.skills} skill${p.skills === 1 ? '' : 's'}${p.commands ? `, ${p.commands} command${p.commands === 1 ? '' : 's'}` : ''}` : 'turned off'} · {p.source}
                </span>
              </li>
            ))}
            {!data.plugins.length && <li className="bp-help">No plugins yet. Add them with /plugin in Claude Code.</li>}
          </ul>
          <h4>MCP servers ({data.mcp.length})</h4>
          <ul className="cl-kfiles">
            {data.mcp.map((m) => (
              <li key={`${m.scope}-${m.name}`}>
                <Icon.terminal size={13} />
                <b>{m.name}</b>
                <span>
                  {m.type} · {m.scope}
                </span>
              </li>
            ))}
            {!data.mcp.length && <li className="bp-help">None set up.</li>}
          </ul>
          {data.suggestions.map((s) => (
            <div key={s.id} className="cl-suggest">
              <b>{s.name}</b>
              <p className="bp-help">{s.why}</p>
              <button className="bp-open" onClick={() => add(s.id)} disabled={!!adding}>
                {adding === s.id ? 'Adding…' : 'Add to Claude Code'}
              </button>
            </div>
          ))}
          <p className="bp-help">Skills from your Claude account show up here once Claude Code on this computer has them (sign in to Claude Code with the same account).</p>
        </>
      )}
      {msg && (
        <p className="bp-help" role="status">
          {msg}
        </p>
      )}
    </aside>
  )
}

/** Add a skill to Claude Code: upload a SKILL.md, .zip or .skill, or write one here. */
function AddSkill({ projectId, onAdded }: { projectId: string | null; onAdded: (msg: string) => void }) {
  const [mode, setMode] = useState<'closed' | 'write'>('closed')
  const [scope, setScope] = useState<'you' | 'project'>('you')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pick = useRef<HTMLInputElement>(null)
  const where = `scope=${scope}&project=${encodeURIComponent(projectId ?? '')}`
  const done = async (r: Response) => {
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error ?? 'That didn’t work')
    onAdded(`Added the skill “${d.name}”${scope === 'project' ? ' to this project' : ''}. Claude can use it from the next message.`)
  }
  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await job()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const upload = (files: FileList | null) =>
    run(async () => {
      for (const f of files ?? []) await done(await fetch(`./api/claude/skill?${where}&file=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f }))
    })
  const write = async () => {
    const ok = await run(async () => done(await fetch(`./api/claude/skill?${where}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, body }) })))
    if (ok) {
      setMode('closed')
      setName('')
      setDescription('')
      setBody('')
    }
  }
  return (
    <section className="cl-addskill">
      <div className="bp-actions">
        <button className="bp-open" onClick={() => pick.current?.click()} disabled={busy}>
          Upload a skill <span>SKILL.md, .zip or .skill</span>
        </button>
        <button className="bp-link" onClick={() => setMode(mode === 'write' ? 'closed' : 'write')}>
          {mode === 'write' ? 'Cancel' : 'Write one'}
        </button>
        <input ref={pick} type="file" accept=".md,.zip,.skill" multiple hidden onChange={(e) => upload(e.target.files).then(() => (e.target.value = ''))} />
      </div>
      {projectId && (
        <div className="bp-seg" role="group" aria-label="Where the skill goes">
          <button aria-pressed={scope === 'you'} onClick={() => setScope('you')}>
            All my projects
          </button>
          <button aria-pressed={scope === 'project'} onClick={() => setScope('project')}>
            This project only
          </button>
        </div>
      )}
      {mode === 'write' && (
        <>
          <label className="cl-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="brand-voice" />
          </label>
          <label className="cl-field">
            <span>When to use it</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when writing copy for Aspect Ratio Digital clients" />
          </label>
          <label className="cl-field">
            <span>Instructions</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} placeholder="What Claude should do, step by step, in Markdown." />
          </label>
          <div className="bp-actions">
            <button className="bp-open" onClick={write} disabled={busy || !name.trim() || !description.trim() || !body.trim()}>
              Save the skill
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="bp-help" role="alert">
          {error}
        </p>
      )}
      <p className="bp-help">{scope === 'project' ? 'Saved in the project’s .claude/skills folder, so it travels with the repo.' : 'Saved in ~/.claude/skills on this computer, for every project.'}</p>
    </section>
  )
}
