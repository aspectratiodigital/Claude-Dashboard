import { useEffect, useMemo, useRef, useState } from 'react'
import { useData } from '../data/store'
import { STATUS_LABEL } from '../data/derive'
import { CONCEPTS, useApp } from '../store'
import { enterStage, sourcesFor } from './Preview'

interface Action {
  id: string
  label: string
  hint: string
  run: () => void
}

// Ctrl/Cmd K: jump to any project, open its fullscreen previews, switch concept.
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPalette)
  const projects = useData((s) => s.projects)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const actions = useMemo<Action[]>(() => {
    const st = useApp.getState()
    const out: Action[] = []
    for (const p of projects) {
      out.push({ id: `open-${p.id}`, label: `Open ${p.name}`, hint: `${STATUS_LABEL[p.status]} · ${p.reason}`, run: () => st.select(p.id) })
      const src = sourcesFor(p)[0]
      if (src) {
        out.push({ id: `desk-${p.id}`, label: `${p.name}: fullscreen desktop`, hint: 'Preview', run: () => enterStage({ projectId: p.id, device: 'desktop', source: src, path: '/' }) })
        out.push({ id: `mob-${p.id}`, label: `${p.name}: fullscreen mobile`, hint: 'Preview', run: () => enterStage({ projectId: p.id, device: 'mobile', source: src, path: '/' }) })
      }
    }
    out.push(
      ...CONCEPTS.map((c) => ({ id: `concept-${c.id}`, label: `Switch to ${c.name}`, hint: c.blurb, run: () => st.setConcept(c.id) })),
      { id: 'notes', label: 'Show notifications', hint: 'N', run: () => st.setNotes(true) },
      { id: 'settings', label: 'Settings: connect GitHub, links, quality', hint: '', run: () => st.setSettings(true) },
      { id: 'refresh', label: 'Refresh data now', hint: '', run: () => useData.getState().refresh() },
      { id: 'fps', label: 'Toggle frame-rate meter', hint: 'F', run: () => st.toggleFps() },
    )
    return out
  }, [projects])

  const results = actions.filter((a) => (a.label + a.hint).toLowerCase().includes(q.toLowerCase())).slice(0, 40)

  useEffect(() => {
    if (open) {
      setQ('')
      setI(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [open])

  if (!open) return null

  const run = (a?: Action) => {
    if (!a) return
    setOpen(false)
    a.run()
  }

  return (
    <div className="palette-scrim" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Jump to a project, a preview or a concept"
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setI((x) => Math.min(x + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setI((x) => Math.max(x - 1, 0))
            } else if (e.key === 'Enter') run(results[i])
            else if (e.key === 'Escape') setOpen(false)
          }}
        />
        <ul>
          {results.map((a, n) => (
            <li key={a.id} aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => run(a)}>
              <span>{a.label}</span>
              <small>{a.hint}</small>
            </li>
          ))}
          {!results.length && <li className="empty">No match.</li>}
        </ul>
      </div>
    </div>
  )
}
