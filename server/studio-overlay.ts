// The script Studio injects into every page of a site it previews. It runs in
// the site's own page (inside the canvas iframe) and talks to Blueprint only
// through postMessage: it reports which page is showing, and in Select mode it
// outlines what's under the pointer and reports what you click.
//
// Written as a plain function and shipped as its source text, so it needs no
// bundling and works the same from `npm run dev` and the desktop app.

function overlay() {
  if ((window as unknown as { __studio?: boolean }).__studio || window.parent === window) return
  ;(window as unknown as { __studio?: boolean }).__studio = true

  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*'
  const post = (msg: Record<string, unknown>) => window.parent.postMessage({ studio: true, ...msg }, parentOrigin)
  let mode: 'browse' | 'select' = 'browse'
  let hovered: Element | null = null
  let selected: Element | null = null

  const css = document.createElement('style')
  css.textContent = `
    [data-studio-box]{position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border-radius:2px;transition:all .08s ease-out;display:none}
    [data-studio-box=hover]{outline:1.5px dashed #2f7dff;outline-offset:0;background:rgba(47,125,255,.06)}
    [data-studio-box=selected]{outline:2px solid #2f7dff;outline-offset:0}
    [data-studio-tag]{position:fixed;pointer-events:none;z-index:2147483647;font:600 11px/1 system-ui,sans-serif;color:#fff;background:#2f7dff;padding:4px 6px;border-radius:3px;white-space:nowrap;display:none}
    html[data-studio-mode=select], html[data-studio-mode=select] *{cursor:default!important}
  `
  document.documentElement.appendChild(css)
  const box = (kind: string) => {
    const el = document.createElement('div')
    el.setAttribute('data-studio-box', kind)
    document.documentElement.appendChild(el)
    return el
  }
  const hoverBox = box('hover')
  const selBox = box('selected')
  const tag = document.createElement('div')
  tag.setAttribute('data-studio-tag', '')
  document.documentElement.appendChild(tag)

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

  const NAMES: Record<string, string> = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', p: 'Paragraph', a: 'Link', img: 'Image', picture: 'Image', video: 'Video', button: 'Button', section: 'Section', header: 'Header', footer: 'Footer', nav: 'Menu', ul: 'List', ol: 'List', li: 'List item', form: 'Form', input: 'Field', textarea: 'Field', figure: 'Figure', blockquote: 'Quote', span: 'Text', svg: 'Icon', main: 'Main', article: 'Article', aside: 'Aside' }

  function describe(el: Element) {
    const t = el.tagName.toLowerCase()
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('is-'))[0] : ''
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
  const TEXT_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, a, button, blockquote, figcaption, label, dt, dd, td, th, summary, small'

  function info(el: Element) {
    const r = el.getBoundingClientRect()
    const img = el.matches('img') ? (el as HTMLImageElement) : el.querySelector('img')
    const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
    const cs = getComputedStyle(el)
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      label: describe(el),
      text: text.trim().slice(0, 600),
      image: img ? { src: img.currentSrc || img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight } : null,
      href: el.closest('a')?.getAttribute('href') ?? null,
      rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      style: { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(',')[0].replace(/["']/g, '')}`, color: cs.color, background: cs.backgroundColor, padding: cs.padding, margin: cs.margin },
      children: el.children.length,
    }
  }

  function setMode(m: 'browse' | 'select') {
    mode = m
    document.documentElement.setAttribute('data-studio-mode', m)
    if (m === 'browse') {
      hovered = null
      place(null, hoverBox, true)
    }
  }

  addEventListener(
    'mousemove',
    (e) => {
      if (mode !== 'select') return
      const el = pick(document.elementFromPoint(e.clientX, e.clientY), e.altKey)
      if (el === hovered) return
      hovered = el
      place(el, hoverBox, true)
    },
    true,
  )
  addEventListener(
    'mouseleave',
    () => {
      hovered = null
      place(null, hoverBox, true)
    },
    true,
  )
  // in Select mode a click selects instead of following links or pressing buttons
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'dblclick']) {
    addEventListener(
      type,
      (e) => {
        if (mode !== 'select') return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type !== 'click') return
        const el = pick(e.target as Element, (e as MouseEvent).altKey)
        selected = el
        place(el, selBox)
        post(el ? { type: 'select', element: info(el) } : { type: 'select', element: null })
      },
      true,
    )
  }
  const follow = () => {
    place(selected, selBox)
    if (hovered) place(hovered, hoverBox, true)
  }
  addEventListener('scroll', follow, true)
  addEventListener('resize', follow)

  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.studio !== true) return
    const d = e.data as { type: string; mode?: 'browse' | 'select'; selector?: string }
    if (d.type === 'mode' && d.mode) setMode(d.mode)
    if (d.type === 'clear') {
      selected = null
      place(null, selBox)
    }
    if (d.type === 'reveal' && d.selector) {
      const el = document.querySelector(d.selector)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        selected = el
        setTimeout(() => place(el, selBox), 400)
      }
    }
  })

  const announce = () => post({ type: 'page', path: location.pathname, hash: location.hash, title: document.title })
  announce()
  addEventListener('popstate', announce)
  addEventListener('hashchange', announce)
  // Astro view transitions swap pages without a load
  document.addEventListener('astro:page-load', announce)
  post({ type: 'ready' })
}

export const OVERLAY_JS = `(${overlay.toString()})();`
