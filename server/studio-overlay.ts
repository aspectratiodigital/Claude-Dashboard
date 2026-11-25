// The script Studio injects into every page of a site it previews. It runs in
// the site's own page (inside the canvas iframe) and talks to Blueprint only
// through postMessage. It reports which page is showing, and in Select mode it
// outlines what's under the pointer, selects what you click, edits text in
// place (double-click), drags elements with snap-to-align guides, nudges them
// with the arrow keys, and applies or reverts the edits Blueprint holds.
//
// Written as a plain function and shipped as its source text, so it needs no
// bundling and works the same from `npm run dev` and the desktop app.

function overlay() {
  type W = Window & { __studio?: boolean }
  if ((window as W).__studio || window.parent === window) return
  ;(window as W).__studio = true

  interface Op {
    id: string
    kind: 'text' | 'image' | 'move' | 'order' | 'link' | 'alt' | 'duplicate' | 'hide' | 'add-image'
    page: string
    selector: string
    label: string
    text: string
    after?: string
    upload?: string
    dx?: number
    dy?: number
    width?: number
    snapped?: string[]
    direction?: 'earlier' | 'later'
    sibling?: string
    before?: string
    name?: string
    scope?: 'everywhere' | 'this-size'
    alt?: string
  }

  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*'
  const post = (msg: Record<string, unknown>) => window.parent.postMessage({ studio: true, ...msg }, parentOrigin)
  const uid = () => Math.random().toString(36).slice(2, 10)
  let mode: 'browse' | 'select' = 'browse'
  let snapOn = true
  /** canvas zoom, so snapping feels the same at any zoom */
  let scale = 1
  let hovered: Element | null = null
  let selected: Element | null = null
  let editing: HTMLElement | null = null

  // --- Drawing ------------------------------------------------------------------------------

  const css = document.createElement('style')
  css.textContent = `
    [data-studio-box]{position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border-radius:2px;display:none}
    [data-studio-box=hover]{outline:1.5px dashed #2f7dff;background:rgba(47,125,255,.06)}
    [data-studio-box=selected]{outline:2px solid #2f7dff}
    [data-studio-box=guide]{background:#ff2fa0;border-radius:0}
    [data-studio-tag]{position:fixed;pointer-events:none;z-index:2147483647;font:600 11px/1 system-ui,sans-serif;color:#fff;background:#2f7dff;padding:4px 6px;border-radius:3px;white-space:nowrap;display:none}
    [data-studio-tag=offset]{background:#ff2fa0}
    html[data-studio-mode=select], html[data-studio-mode=select] *{cursor:default!important}
    html[data-studio-mode=select] [data-studio-selected]{cursor:move!important}
    [data-studio-editing]{outline:2px solid #ff9f1a!important;outline-offset:2px;cursor:text!important;-webkit-user-select:text!important;user-select:text!important}
    html[data-studio-dragging], html[data-studio-dragging] *{cursor:grabbing!important;user-select:none!important}
  `
  document.documentElement.appendChild(css)
  const make = (attr: string, kind: string) => {
    const el = document.createElement('div')
    el.setAttribute(attr, kind)
    document.documentElement.appendChild(el)
    return el
  }
  const hoverBox = make('data-studio-box', 'hover')
  const selBox = make('data-studio-box', 'selected')
  const tag = make('data-studio-tag', '')
  const offsetTag = make('data-studio-tag', 'offset')
  const guides = [make('data-studio-box', 'guide'), make('data-studio-box', 'guide')]
  const ours = (el: Element | null) => !!el && (el.hasAttribute('data-studio-box') || el.hasAttribute('data-studio-tag'))

  function place(el: Element | null, b: HTMLElement, label?: boolean) {
    if (!el || !el.isConnected) {
      b.style.display = 'none'
      if (label) tag.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(b.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    if (label) {
      tag.textContent = describe(el)
      tag.style.display = 'block'
      const top = r.top > 22 ? r.top - 20 : r.bottom + 4
      Object.assign(tag.style, { left: `${Math.max(2, Math.min(r.left, innerWidth - tag.offsetWidth - 2))}px`, top: `${top}px` })
    }
  }

  function line(g: HTMLElement, x: number, y: number, w: number, h: number) {
    const t = Math.max(1, 1 / scale)
    Object.assign(g.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w || t}px`, height: `${h || t}px` })
  }
  const hideGuides = () => guides.forEach((g) => (g.style.display = 'none'))

  // --- Describing elements ------------------------------------------------------------------

  const NAMES: Record<string, string> = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', p: 'Paragraph', a: 'Link', img: 'Image', picture: 'Image', video: 'Video', button: 'Button', section: 'Section', header: 'Header', footer: 'Footer', nav: 'Menu', ul: 'List', ol: 'List', li: 'List item', form: 'Form', input: 'Field', textarea: 'Field', figure: 'Figure', blockquote: 'Quote', span: 'Text', svg: 'Icon', main: 'Main', article: 'Article', aside: 'Aside', div: 'Box' }

  function describe(el: Element) {
    const t = el.tagName.toLowerCase()
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('is-') && !c.startsWith('astro-'))[0] : ''
    return `${NAMES[t] ?? t}${cls ? ` .${cls}` : ''}`
  }

  function selectorOf(el: Element): string {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const t = node.tagName.toLowerCase()
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`${t}#${node.id}`)
        break
      }
      const parent: Element | null = node.parentElement
      if (!parent) break
      const same = [...parent.children].filter((c) => c.tagName === node!.tagName)
      parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t)
      node = parent
    }
    return parts.join(' > ')
  }

  const TEXT_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, a, button, blockquote, figcaption, label, dt, dd, td, th, summary, small'

  /** what's worth selecting under the pointer: images win over the box they sit in */
  function pick(target: Element | null, exact = false): Element | null {
    if (!target || ours(target)) return null
    const media = target.closest('picture, img, video, svg')
    if (media) return media.closest('picture') ?? media
    if (target === document.body || target === document.documentElement) return null
    // a word or line inside a heading or paragraph (sites split headings into
    // spans for their reveal animations): select the whole heading instead.
    // Alt-click selects exactly what's under the pointer.
    if (!exact && getComputedStyle(target).display.startsWith('inline')) {
      const block = target.closest(TEXT_BLOCKS)
      if (block) return block
    }
    return target
  }

  const textOf = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const imgOf = (el: Element) => (el.matches('img') ? (el as HTMLImageElement) : el.querySelector('img'))

  function info(el: Element) {
    const r = el.getBoundingClientRect()
    const img = imgOf(el)
    const cs = getComputedStyle(el)
    const parent = el.parentElement
    const sibs = parent ? [...parent.children].filter((c) => !ours(c)) : []
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      label: describe(el),
      text: textOf(el).slice(0, 600),
      image: img ? { src: img.currentSrc || img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight } : null,
      href: (el.closest('a') ?? (el.querySelectorAll('a').length === 1 ? el.querySelector('a') : null))?.getAttribute('href') ?? null,
      rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      style: { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(',')[0].replace(/["']/g, '')}`, color: cs.color, background: cs.backgroundColor, padding: cs.padding, margin: cs.margin },
      children: el.children.length,
      editable: isTextual(el),
      index: sibs.indexOf(el),
      siblings: sibs.length,
      moved: !!(el as HTMLElement).style?.translate && (el as HTMLElement).style.translate !== 'none',
    }
  }

  /** text you can edit in place: no images or nested blocks inside it */
  function isTextual(el: Element) {
    if (!textOf(el) || el.matches('img, picture, svg, video, input, textarea, select')) return false
    return !el.querySelector('img, picture, svg, video, h1, h2, h3, h4, h5, h6, p, ul, ol, div, section, table, form')
  }

  function select(el: Element | null) {
    selected?.removeAttribute('data-studio-selected')
    selected = el
    el?.setAttribute('data-studio-selected', '')
    place(el, selBox)
    post({ type: 'select', element: el ? info(el) : null })
  }

  // --- Edits: apply and revert -------------------------------------------------------------

  /** how to undo each applied edit, by id */
  const applied = new Map<string, () => void>()

  function apply(op: Op): boolean {
    if (applied.has(op.id)) return true
    const el = document.querySelector(op.selector) as HTMLElement | null
    if (!el) return false
    if (op.kind === 'text' && typeof op.after === 'string') {
      const html = el.innerHTML
      el.textContent = op.after
      applied.set(op.id, () => (el.innerHTML = html))
    } else if (op.kind === 'image' && op.upload) {
      const img = imgOf(el)
      if (!img) return false
      const pic = img.closest('picture')
      const sources = pic ? [...pic.querySelectorAll('source')] : []
      const was = { src: img.getAttribute('src'), srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes') }
      sources.forEach((s) => s.remove())
      img.removeAttribute('srcset')
      img.removeAttribute('sizes')
      img.src = `/__studio/upload/${op.upload}`
      applied.set(op.id, () => {
        if (was.src !== null) img.setAttribute('src', was.src)
        if (was.srcset !== null) img.setAttribute('srcset', was.srcset)
        if (was.sizes !== null) img.setAttribute('sizes', was.sizes)
        sources.forEach((s) => pic?.insertBefore(s, img))
      })
    } else if (op.kind === 'move') {
      const was = el.style.translate
      el.style.translate = `${op.dx}px ${op.dy}px`
      applied.set(op.id, () => (el.style.translate = was))
    } else if (op.kind === 'link' && typeof op.after === 'string') {
      const a = (el.closest('a') ?? el.querySelector('a')) as HTMLAnchorElement | null
      if (!a) return false
      const was = a.getAttribute('href')
      a.setAttribute('href', op.after)
      applied.set(op.id, () => (was === null ? a.removeAttribute('href') : a.setAttribute('href', was)))
    } else if (op.kind === 'alt' && typeof op.after === 'string') {
      const img = imgOf(el)
      if (!img) return false
      const was = img.getAttribute('alt')
      img.alt = op.after
      applied.set(op.id, () => (was === null ? img.removeAttribute('alt') : img.setAttribute('alt', was)))
    } else if (op.kind === 'duplicate') {
      const copy = el.cloneNode(true) as HTMLElement
      copy.removeAttribute('id')
      copy.removeAttribute('data-studio-selected')
      el.after(copy)
      applied.set(op.id, () => copy.remove())
    } else if (op.kind === 'hide') {
      const was = el.style.display
      el.style.display = 'none'
      applied.set(op.id, () => (el.style.display = was))
    } else if (op.kind === 'add-image' && op.upload) {
      const img = document.createElement('img')
      img.src = `/__studio/upload/${op.upload}`
      img.alt = op.alt ?? ''
      img.style.cssText = 'display:block;max-width:100%;height:auto;margin:16px 0'
      el.after(img)
      applied.set(op.id, () => img.remove())
    } else if (op.kind === 'order') {
      const parent = el.parentElement
      if (!parent) return false
      const next = el.nextSibling
      const sibs = [...parent.children].filter((c) => !ours(c))
      const i = sibs.indexOf(el)
      if (op.direction === 'earlier' && i > 0) parent.insertBefore(el, sibs[i - 1])
      else if (op.direction === 'later' && i < sibs.length - 1) parent.insertBefore(el, sibs[i + 1].nextSibling)
      else return false
      applied.set(op.id, () => parent.insertBefore(el, next))
    }
    return true
  }

  function revert(id: string) {
    applied.get(id)?.()
    applied.delete(id)
  }

  /** an edit made here: applied at once, then handed to Blueprint to keep */
  function made(op: Omit<Op, 'id' | 'page'> & { id?: string }) {
    const full = { ...op, id: op.id ?? uid(), page: location.pathname } as Op
    if (op.kind !== 'move') apply(full)
    post({ type: 'op', op: full })
    return full
  }

  // --- Text editing ------------------------------------------------------------------------

  function startEdit(el: HTMLElement) {
    if (!isTextual(el) || editing) return
    const before = textOf(el)
    const html = el.innerHTML
    editing = el
    el.setAttribute('data-studio-editing', '')
    el.textContent = before
    try {
      el.contentEditable = 'plaintext-only'
    } catch {
      el.contentEditable = 'true'
    }
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    place(null, hoverBox, true)
    post({ type: 'editing', on: true })

    const finish = (keep: boolean) => {
      el.removeEventListener('keydown', onKey, true)
      el.removeEventListener('blur', onBlur)
      el.contentEditable = 'inherit'
      el.removeAttribute('contenteditable')
      el.removeAttribute('data-studio-editing')
      editing = null
      const after = (el.innerText ?? '').replace(/\s+/g, ' ').trim()
      el.innerHTML = html
      if (keep && after && after !== before) made({ kind: 'text', selector: selectorOf(el), label: describe(el), text: before, before, after })
      place(el, selBox)
      post({ type: 'editing', on: false })
      post({ type: 'select', element: info(el) })
    }
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        finish(true)
      }
    }
    const onBlur = () => finish(true)
    el.addEventListener('keydown', onKey, true)
    el.addEventListener('blur', onBlur)
  }

  // --- Dragging with snap-to-align ----------------------------------------------------------

  interface Rect {
    l: number
    t: number
    r: number
    b: number
    name: string
  }
  let drag: { el: HTMLElement; x0: number; y0: number; dx0: number; dy0: number; base: DOMRect; targets: Rect[]; moved: boolean; snapped: string[] } | null = null

  const currentShift = (el: HTMLElement) => {
    const m = (el.style.translate || '').match(/(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/)
    return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : { x: 0, y: 0 }
  }

  /** edges and centres worth lining up with: other visible elements and the page itself */
  function snapTargets(el: Element): Rect[] {
    const out: Rect[] = [{ l: 0, t: -1e5, r: innerWidth, b: 1e5, name: 'the page' }]
    const all = document.body.querySelectorAll('*')
    for (let i = 0; i < all.length && out.length < 1500; i++) {
      const o = all[i]
      if (o === el || el.contains(o) || ours(o)) continue
      const r = o.getBoundingClientRect()
      if (r.width < 6 || r.height < 6 || r.bottom < -innerHeight || r.top > innerHeight * 2) continue
      if (r.width >= innerWidth - 1 && r.height >= innerHeight - 1) continue // full-screen wrappers
      out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, name: describe(o) })
    }
    return out
  }

  const EDGE = ['left edge', 'centre', 'right edge']
  const EDGE_Y = ['top', 'middle', 'bottom']

  function snap(rect: { l: number; t: number; r: number; b: number }, targets: Rect[]) {
    const limit = 6 / scale
    const mine = { x: [rect.l, (rect.l + rect.r) / 2, rect.r], y: [rect.t, (rect.t + rect.b) / 2, rect.b] }
    let bx: { d: number; at: number; t: Rect; i: number; j: number } | null = null
    let by: { d: number; at: number; t: Rect; i: number; j: number } | null = null
    for (const t of targets) {
      const tx = [t.l, (t.l + t.r) / 2, t.r]
      const ty = [t.t, (t.t + t.b) / 2, t.b]
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const dx = tx[j] - mine.x[i]
          if (Math.abs(dx) <= limit && (!bx || Math.abs(dx) < Math.abs(bx.d))) bx = { d: dx, at: tx[j], t, i, j }
          const dy = ty[j] - mine.y[i]
          if (t.name !== 'the page' && Math.abs(dy) <= limit && (!by || Math.abs(dy) < Math.abs(by.d))) by = { d: dy, at: ty[j], t, i, j }
        }
    }
    return { bx, by }
  }

  function dragTo(e: PointerEvent) {
    if (!drag) return
    const mx = e.clientX - drag.x0
    const my = e.clientY - drag.y0
    if (!drag.moved && Math.hypot(mx, my) < 3) return
    if (!drag.moved) {
      drag.moved = true
      document.documentElement.setAttribute('data-studio-dragging', '')
      place(null, hoverBox, true)
    }
    let dx = drag.dx0 + mx
    let dy = drag.dy0 + my
    const b = drag.base
    const rect = { l: b.left + mx, t: b.top + my, r: b.right + mx, b: b.bottom + my }
    hideGuides()
    drag.snapped = []
    if (snapOn && !e.altKey) {
      const { bx, by } = snap(rect, drag.targets)
      if (bx) {
        dx += bx.d
        rect.l += bx.d
        rect.r += bx.d
        const top = Math.min(rect.t, bx.t.t)
        line(guides[0], bx.at, Math.max(top, 0), 0, Math.min(Math.max(rect.b, bx.t.b), innerHeight) - Math.max(top, 0))
        drag.snapped.push(`its ${EDGE[bx.i]} lines up with the ${EDGE[bx.j]} of ${bx.t.name}`)
      }
      if (by) {
        dy += by.d
        rect.t += by.d
        rect.b += by.d
        const left = Math.min(rect.l, by.t.l)
        line(guides[1], Math.max(left, 0), by.at, Math.min(Math.max(rect.r, by.t.r), innerWidth) - Math.max(left, 0), 0)
        drag.snapped.push(`its ${EDGE_Y[by.i]} lines up with the ${EDGE_Y[by.j]} of ${by.t.name}`)
      }
    }
    dx = Math.round(dx)
    dy = Math.round(dy)
    drag.el.style.translate = `${dx}px ${dy}px`
    place(drag.el, selBox)
    offsetTag.textContent = `x ${dx >= 0 ? '+' : ''}${dx}  y ${dy >= 0 ? '+' : ''}${dy}`
    Object.assign(offsetTag.style, { display: 'block', left: `${rect.l}px`, top: `${rect.b + 6}px` })
  }

  function endDrag() {
    if (!drag) return
    const d = drag
    drag = null
    document.documentElement.removeAttribute('data-studio-dragging')
    hideGuides()
    offsetTag.style.display = 'none'
    if (!d.moved) return
    const { x, y } = currentShift(d.el)
    d.el.style.translate = d.dx0 || d.dy0 ? `${d.dx0}px ${d.dy0}px` : ''
    moveTo(d.el, x, y, d.snapped)
  }

  /** a move: always the element's total shift from where the site puts it */
  let lastMove: { el: Element; id: string } | null = null
  function moveTo(el: HTMLElement, dx: number, dy: number, snapped: string[]) {
    const reuse = lastMove?.el === el ? lastMove.id : undefined
    if (reuse) revert(reuse)
    const op = { id: reuse ?? uid(), kind: 'move' as const, selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 120), dx, dy, width: innerWidth, snapped }
    const full = { ...op, page: location.pathname } as Op
    apply(full)
    post({ type: 'op', op: full })
    lastMove = { el, id: full.id }
    place(el, selBox)
    post({ type: 'select', element: info(el) })
  }

  // --- Pointer and keys --------------------------------------------------------------------

  addEventListener(
    'pointermove',
    (e) => {
      if (drag) return dragTo(e)
      if (mode !== 'select' || editing) return
      const el = pick(document.elementFromPoint(e.clientX, e.clientY), e.altKey)
      if (el === hovered) return
      hovered = el
      place(el, hoverBox, true)
    },
    true,
  )
  addEventListener('pointerup', endDrag, true)
  addEventListener('pointercancel', endDrag, true)
  addEventListener(
    'mouseleave',
    () => {
      hovered = null
      place(null, hoverBox, true)
    },
    true,
  )

  // in Select mode a click selects instead of following links or pressing buttons
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'dblclick', 'touchstart']) {
    addEventListener(
      type,
      (e) => {
        if (mode !== 'select') return
        if (editing && editing.contains(e.target as Node)) return
        if (type === 'pointerup') endDrag()
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'pointerdown') {
          const pe = e as PointerEvent
          if (pe.button !== 0) return
          const el = pick(e.target as Element, pe.altKey) as HTMLElement | null
          if (el !== selected) select(el)
          if (el) {
            const s = currentShift(el)
            el.style.translate = s.x || s.y ? `${s.x}px ${s.y}px` : ''
            drag = { el, x0: pe.clientX, y0: pe.clientY, dx0: s.x, dy0: s.y, base: el.getBoundingClientRect(), targets: snapTargets(el), moved: false, snapped: [] }
          }
        }
        if (type === 'dblclick' && selected) startEdit(selected as HTMLElement)
      },
      true,
    )
  }

  addEventListener(
    'keydown',
    (e) => {
      if (mode !== 'select' || editing || !selected) return
      const step = e.shiftKey ? 10 : 1
      const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (keys[e.key]) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const s = currentShift(selected as HTMLElement)
        moveTo(selected as HTMLElement, s.x + keys[e.key][0], s.y + keys[e.key][1], [])
      } else if (e.key === 'Enter') {
        e.preventDefault()
        startEdit(selected as HTMLElement)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        select(null)
        post({ type: 'escape' })
      } else if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) {
        e.preventDefault()
        post({ type: 'key', key: e.key.toLowerCase(), shift: e.shiftKey })
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[vh]$/i.test(e.key)) {
        post({ type: 'key', key: e.key.toLowerCase() })
      }
    },
    true,
  )
  // undo, redo and tool keys still reach Studio while the canvas has focus
  addEventListener('keydown', (e) => {
    if (editing || (mode === 'select' && selected)) return
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) {
      e.preventDefault()
      post({ type: 'key', key: e.key.toLowerCase(), shift: e.shiftKey })
    } else if (e.key === 'Escape') post({ type: 'escape' })
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[vh]$/i.test(e.key) && !(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) post({ type: 'key', key: e.key.toLowerCase() })
  })

  const follow = () => {
    place(selected, selBox)
    if (hovered) place(hovered, hoverBox, true)
  }
  addEventListener('scroll', follow, true)
  addEventListener('resize', follow)

  function setMode(m: 'browse' | 'select') {
    mode = m
    document.documentElement.setAttribute('data-studio-mode', m)
    if (m === 'browse') {
      hovered = null
      place(null, hoverBox, true)
      select(null)
    }
  }

  // --- Messages from Studio -----------------------------------------------------------------

  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.studio !== true) return
    const d = e.data as { type: string; mode?: 'browse' | 'select'; selector?: string; op?: Op; ops?: Op[]; id?: string; on?: boolean; scale?: number }
    if (d.type === 'mode' && d.mode) setMode(d.mode)
    if (d.type === 'snap') snapOn = !!d.on
    if (d.type === 'scale' && d.scale) scale = d.scale
    if (d.type === 'clear') select(null)
    if (d.type === 'apply' && d.op && d.op.page === location.pathname) {
      apply(d.op)
      if (selected) place(selected, selBox)
    }
    if (d.type === 'apply-all' && d.ops) {
      for (const op of d.ops) if (op.page === location.pathname) apply(op)
    }
    if (d.type === 'revert' && d.id) {
      revert(d.id)
      if (lastMove?.id === d.id) lastMove = null
      if (selected) {
        place(selected, selBox)
        post({ type: 'select', element: info(selected) })
      }
    }
    if (d.type === 'revert-all') {
      for (const id of [...applied.keys()].reverse()) revert(id)
      lastMove = null
    }
    if (d.type === 'edit-text' && selected) startEdit(selected as HTMLElement)
    if (d.type === 'action' && selected) {
      const el = selected
      const a = e.data as { action: string; value?: string; upload?: string; name?: string; scope?: 'everywhere' | 'this-size' }
      const base = { selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 160) }
      if (a.action === 'link') {
        const link = el.closest('a') ?? el.querySelector('a')
        made({ ...base, kind: 'link', before: link?.getAttribute('href') ?? '', after: a.value ?? '' })
        select(el)
      } else if (a.action === 'alt') {
        made({ ...base, kind: 'alt', before: imgOf(el)?.getAttribute('alt') ?? '', after: a.value ?? '' })
        select(el)
      } else if (a.action === 'image' && a.upload) {
        made({ ...base, kind: 'image', before: imgOf(el)?.currentSrc ?? '', upload: a.upload, name: a.name ?? 'photo' })
        setTimeout(() => select(el), 300)
      } else if (a.action === 'add-image' && a.upload) {
        made({ ...base, kind: 'add-image', upload: a.upload, name: a.name ?? 'photo', alt: a.value ?? '' })
        const img = el.nextElementSibling
        setTimeout(() => select(img), 300)
      } else if (a.action === 'duplicate') {
        made({ ...base, kind: 'duplicate' })
        select(el.nextElementSibling)
      } else if (a.action === 'hide') {
        made({ ...base, kind: 'hide', scope: a.scope ?? 'everywhere', width: innerWidth })
        select(null)
      } else if (a.action === 'unmove') {
        moveTo(el as HTMLElement, 0, 0, [])
      } else if (a.action === 'text' && typeof a.value === 'string') {
        made({ ...base, kind: 'text', before: textOf(el), after: a.value })
        select(el)
      }
    }
    if (d.type === 'order' && selected && (d.on === true || d.on === false)) {
      const el = selected
      const parent = el.parentElement
      const sibs = parent ? [...parent.children].filter((c) => !ours(c)) : []
      const i = sibs.indexOf(el)
      const other = sibs[d.on ? i - 1 : i + 1]
      if (!other) return
      made({ kind: 'order', selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 120), direction: d.on ? 'earlier' : 'later', sibling: `${describe(other)}${textOf(other) ? ` (“${textOf(other).slice(0, 60)}”)` : ''}` })
      select(el)
    }
    if (d.type === 'reveal' && d.selector) {
      const el = document.querySelector(d.selector)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        select(el)
        setTimeout(() => place(el, selBox), 400)
      }
    }
  })

  const announce = () => post({ type: 'page', path: location.pathname, hash: location.hash, title: document.title })
  announce()
  addEventListener('popstate', announce)
  addEventListener('hashchange', announce)
  // Astro view transitions swap pages without a load
  document.addEventListener('astro:page-load', () => {
    applied.clear()
    announce()
    post({ type: 'ready' })
  })
  post({ type: 'ready' })
}

export const OVERLAY_JS = `(${overlay.toString()})();`
