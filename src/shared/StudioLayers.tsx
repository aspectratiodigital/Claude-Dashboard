import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudioLayer } from '../data/types'
import { Icon } from './icons'
import { Spin, type StudioCtx } from './StudioUi'

// Layers: everything on the page as a folding list, for selecting what's
// hard to click (something under something else, or hidden at this size),
// and for locking parts of the page so they can't be changed by accident.

export function Layers({ ctx, locked, onLock, onClose }: { ctx: StudioCtx; locked: string[]; onLock: (selector: string) => void; onClose: () => void }) {
  const [layers, setLayers] = useState<StudioLayer[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const nonce = useRef(0)
  const list = useRef<HTMLOListElement>(null)
  const { tell, on } = ctx

  useEffect(
    () =>
      on('layers', (d) => {
        if (Number(d.nonce) !== nonce.current) return
        setLayers((d.layers as StudioLayer[]) ?? [])
      }),
    [on],
  )
  // read the page again when it or its edits change
  const opCount = ctx.ops.length
  useEffect(() => {
    const t = setTimeout(() => tell({ type: 'layers', nonce: ++nonce.current }), 250)
    return () => clearTimeout(t)
  }, [ctx.path, opCount, tell])
  useEffect(() => setOpen(new Set()), [ctx.path])

  // open the way down to what's selected, and bring it into view
  const sel = ctx.selected?.selector ?? null
  useEffect(() => {
    if (!sel || !layers) return
    const i = layers.findIndex((l) => l.selector === sel)
    if (i < 0) return
    const up = new Set(open)
    let depth = layers[i].depth
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (layers[j].depth < depth) {
        up.add(layers[j].selector)
        depth = layers[j].depth
      }
    }
    if (up.size !== open.size) setOpen(up)
    requestAnimationFrame(() => list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }))
    // only when the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, layers])

  const shown = useMemo(() => {
    if (!layers) return []
    const f = filter.trim().toLowerCase()
    if (f) return layers.filter((l) => l.label.toLowerCase().includes(f) || l.text.toLowerCase().includes(f)).slice(0, 300)
    // the top two levels show; deeper ones once their parent is opened
    const out: StudioLayer[] = []
    let hideBelow = Infinity
    for (const l of layers) {
      if (l.depth > hideBelow) continue
      hideBelow = Infinity
      out.push(l)
      if (l.children && !(l.depth < 1 || open.has(l.selector))) hideBelow = l.depth
    }
    return out
  }, [layers, filter, open])

  const toggle = (s: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(s)) n.delete(s)
      else n.add(s)
      return n
    })

  return (
    <aside className="st-layers" aria-label="Layers">
      <header>
        <b>
          <Icon.list size={14} /> Layers
        </b>
        <button className="st-btn" onClick={onClose} title="Close layers">
          <Icon.close size={14} />
        </button>
      </header>
      <input className="st-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find on this page" aria-label="Find a layer" spellCheck={false} />
      {!layers && <Spin>Reading the page…</Spin>}
      <ol ref={list} onMouseLeave={() => tell({ type: 'hover', selector: null })}>
        {shown.map((l) => {
          const isOpen = open.has(l.selector) || l.depth < 1
          const lockedHere = locked.includes(l.selector)
          return (
            <li key={l.selector} aria-current={l.selector === sel} data-hidden={l.hidden || undefined} data-locked={lockedHere || undefined} style={{ paddingLeft: filter ? 6 : 6 + Math.min(l.depth, 10) * 12 }} onMouseEnter={() => tell({ type: 'hover', selector: l.selector })}>
              {l.children > 0 && !filter ? (
                <button className="st-twist" aria-expanded={isOpen} onClick={() => toggle(l.selector)} title={isOpen ? 'Fold' : 'Unfold'}>
                  <Icon.chevron size={11} />
                </button>
              ) : (
                <i className="st-twist" />
              )}
              <button
                className="st-layer"
                onClick={(e) => tell({ type: 'reveal', selector: l.selector, add: e.shiftKey })}
                title={`${l.label}${l.text ? `: ${l.text}` : ''}${l.hidden ? ' (hidden at this size)' : ''}\nShift-click to add to the selection`}
              >
                <b>{l.label}</b>
                {l.text && <small>{l.text}</small>}
              </button>
              {l.hidden && <Icon.eyeOff size={12} />}
              <button className="st-lock" aria-pressed={lockedHere} onClick={() => onLock(l.selector)} title={lockedHere ? 'Unlock' : 'Lock: it and what’s inside can’t be changed or moved'}>
                {lockedHere ? <Icon.lock size={12} /> : <Icon.unlock size={12} />}
              </button>
            </li>
          )
        })}
      </ol>
      {layers && layers.length >= 900 && <p className="st-muted">The first 900 shown: find to narrow it down.</p>}
    </aside>
  )
}
