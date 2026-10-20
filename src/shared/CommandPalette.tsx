import { useEffect, useMemo, useRef, useState } from 'react'
import { SITES, STATUS_LABEL } from '../data/mock'
import { CONCEPTS, useApp } from '../store'

interface Action {
  id: string
  label: string
  hint: string
  run: () => void
}

// Ctrl/Cmd K: jump to any site or concept from the keyboard.
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPalette)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const actions = useMemo<Action[]>(() => {
    const st = useApp.getState()
    return [
      ...SITES.map((s) => ({
        id: `site-${s.id}`,
        label: `Open ${s.name}`,
        hint: `${s.repo} · ${STATUS_LABEL[s.status]}`,
        run: () => st.select(s.id),
      })),
      ...CONCEPTS.map((c) => ({
        id: `concept-${c.id}`,
        label: `Switch to ${c.name}`,
        hint: c.blurb,
        run: () => st.setConcept(c.id),
      })),
      { id: 'fps', label: 'Toggle frame-rate meter', hint: 'F', run: () => st.toggleFps() },
    ]
  }, [])

  const results = actions.filter((a) => (a.label + a.hint).toLowerCase().includes(q.toLowerCase()))

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
    a.run()
    setOpen(false)
  }

  return (
    <div className="palette-scrim" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Jump to a site or concept"
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
          {!results.length && <li className="empty">No match. Try a site name like “Kiln”.</li>}
        </ul>
      </div>
    </div>
  )
}
