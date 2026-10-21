import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note, NoteKind } from '../data/types'
import { useData } from '../data/store'
import { ALL_KINDS, KIND_LABEL, relTime, unread } from '../data/derive'
import { useApp } from '../store'
import { Icon, KindIcon } from './icons'

// The notification layer every concept shares: a tray (bell + settings) in the
// top-right corner, toasts that slide in under it, and a drawer with the full
// history plus a "preview a notification" panel to fire any kind on demand.
// Concepts restyle all of it through the --ui-* tokens; the in-scene visuals
// (fireworks, cranes, smoke, bubbles...) live in each concept.

export function Tray() {
  const notes = useData((s) => s.notes)
  const setNotes = useApp((s) => s.setNotes)
  const setSettings = useApp((s) => s.setSettings)
  const open = useApp((s) => s.notesOpen)
  const n = unread(notes)
  const [bump, setBump] = useState(0)
  const last = useRef(notes[0]?.id)
  useEffect(() => {
    if (notes[0]?.id !== last.current) {
      last.current = notes[0]?.id
      setBump((b) => b + 1)
    }
  }, [notes])
  return (
    <div className="tray">
      <button className="tray-btn" key={bump} data-bump={bump > 0} aria-pressed={open} onClick={() => setNotes(!open)} title="Notifications">
        <Icon.bell size={18} />
        {n > 0 && <span className="tray-badge">{n > 99 ? '99+' : n}</span>}
      </button>
      <button className="tray-btn" onClick={() => setSettings(true)} title="Settings">
        <Icon.gear size={18} />
      </button>
    </div>
  )
}

export function Toasts() {
  const toasts = useData((s) => s.toasts)
  const dismiss = useData((s) => s.dismissToast)
  const projects = useData((s) => s.projects)
  const select = useApp((s) => s.select)
  const drawer = useApp((s) => s.notesOpen)
  if (drawer) return null
  return (
    <ol className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const p = projects.find((x) => x.id === t.projectId)
        return (
          <li key={t.id} className="toast" data-level={t.level} data-kind={t.kind} style={{ ['--pc' as string]: p?.accent ?? 'currentColor' }}>
            <button
              className="toast-body"
              onClick={() => {
                select(t.projectId)
                dismiss(t.id)
                useData.getState().markRead([t.id])
              }}
            >
              <span className="toast-icon">
                <KindIcon kind={t.kind} size={18} />
              </span>
              <span className="toast-text">
                <b>{t.title}</b>
                <small>{t.body}</small>
              </span>
            </button>
            <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon.close size={14} />
            </button>
            <i className="toast-timer" />
          </li>
        )
      })}
    </ol>
  )
}

type Filter = 'all' | 'problems' | 'ship' | 'claude'
const FILTERS: { id: Filter; label: string; kinds: NoteKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'problems', label: 'Problems', kinds: ['build-fail', 'deploy-fail', 'down', 'issue', 'perf', 'review'] },
  { id: 'ship', label: 'Builds & deploys', kinds: ['build', 'build-ok', 'deploying', 'deployed', 'merged', 'up'] },
  { id: 'claude', label: 'Claude', kinds: ['claude', 'pr', 'push'] },
]

export function NotesDrawer() {
  const open = useApp((s) => s.notesOpen)
  const setOpen = useApp((s) => s.setNotes)
  const select = useApp((s) => s.select)
  const notes = useData((s) => s.notes)
  const projects = useData((s) => s.projects)
  const markRead = useData((s) => s.markRead)
  const test = useData((s) => s.test)
  const [filter, setFilter] = useState<Filter>('all')
  const [target, setTarget] = useState('')
  const kinds = FILTERS.find((f) => f.id === filter)!.kinds
  const list = useMemo(() => notes.filter((n) => !kinds || kinds.includes(n.kind)), [notes, kinds])
  const groups = useMemo(() => {
    const today: Note[] = []
    const earlier: Note[] = []
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    for (const n of list) (Date.parse(n.at) >= start.getTime() ? today : earlier).push(n)
    return [
      ['Today', today],
      ['Earlier', earlier],
    ] as const
  }, [list])
  const projectId = target || projects[0]?.id || ''

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => markRead(), 2500)
    return () => window.clearTimeout(t)
  }, [open, markRead])

  return (
    <aside className="drawer" data-open={open} aria-hidden={!open}>
      <header>
        <h2>Notifications</h2>
        <button className="drawer-x" onClick={() => setOpen(false)} aria-label="Close">
          <Icon.close size={16} />
        </button>
      </header>
      <div className="drawer-filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={f.id === filter} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="drawer-list">
        {groups.map(([label, items]) =>
          items.length ? (
            <section key={label}>
              <h3>{label}</h3>
              <ul>
                {items.map((n) => {
                  const p = projects.find((x) => x.id === n.projectId)
                  return (
                    <li key={n.id} data-level={n.level} data-unread={!n.read}>
                      <button
                        onClick={() => {
                          select(n.projectId)
                          setOpen(false)
                        }}
                      >
                        <span className="drawer-icon">
                          <KindIcon kind={n.kind} />
                        </span>
                        <span className="drawer-text">
                          <b>{n.title}</b>
                          <small>{n.body}</small>
                          <em>
                            <i style={{ background: p?.accent }} />
                            {KIND_LABEL[n.kind]} · {relTime(n.at)}
                            {n.test ? ' · preview' : ''}
                          </em>
                        </span>
                      </button>
                      {n.url && (
                        <a href={n.url} target="_blank" rel="noreferrer" title="Open">
                          <Icon.external size={14} />
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null,
        )}
        {!list.length && <p className="drawer-empty">Nothing yet. Builds, deploys, issues and Claude's work will show up here as they happen.</p>}
      </div>
      <footer className="drawer-test">
        <h3>Preview a notification</h3>
        <p>Fire any kind at a project to see how this concept shows it.</p>
        <select value={projectId} onChange={(e) => setTarget(e.target.value)} aria-label="Project">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="drawer-kinds">
          {ALL_KINDS.map((k) => (
            <button key={k} onClick={() => projectId && test(projectId, k)} title={KIND_LABEL[k]}>
              <KindIcon kind={k} size={15} />
              <span>{KIND_LABEL[k]}</span>
            </button>
          ))}
        </div>
      </footer>
    </aside>
  )
}
