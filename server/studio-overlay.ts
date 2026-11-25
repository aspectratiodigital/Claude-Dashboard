// The script Studio injects into every page of a site it previews. It runs in
// the site's own page (inside the canvas iframe) and talks to Blueprint only
// through postMessage. It reports which page is showing, and in Edit mode it
// outlines what's under the pointer, selects what you click (Shift adds to the
// selection), edits text in place with bold, italic, links and line breaks,
// drags elements with snap-to-align guides, measures distances (Alt), and
// applies or reverts the edits Blueprint holds: words, photos, styles,
// attributes, pasted sections, table rows, embeds, theme tokens and more. It
// also reads the page for the SEO and accessibility checks, the layers list and
// the site's design tokens, and draws share images with the site's own fonts.
//
// Without a canvas around it (a phone preview or a screenshot), it only
// applies the edits it was handed in window.__studioOps, then gets out of the way.
//
// Written as a plain function and shipped as its source text, so it needs no
// bundling and works the same from `npm run dev` and the desktop app.

function overlay() {
  interface Op {
    id: string
    kind: string
    page: string
    selector: string
    label: string
    text: string
    made?: string
    field?: 'title' | 'description' | 'og:title' | 'og:description' | 'og:image'
    after?: string | null
    before?: string | null | Record<string, string>
    html?: string
    everywhere?: boolean
    upload?: string
    src?: string
    dx?: number
    dy?: number
    width?: number
    snapped?: string[]
    direction?: 'earlier' | 'later'
    sibling?: string
    name?: string
    scope?: string
    alt?: string
    props?: Record<string, string>
    media?: { min?: number; max?: number } | null
    action?: string
    row?: number
    col?: number
    find?: string
    replace?: string
    matchCase?: boolean
    wholeWord?: boolean
    url?: string
    provider?: string
    title?: string
    inline?: boolean
    recolour?: boolean
    markup?: string
    prompt?: string
    from?: { page: string; selector: string; label: string; text: string }
  }
  type W = Window & { __studio?: boolean; __studioOps?: Op[]; __studioReady?: boolean; axe?: { run: (ctx: unknown, opts: unknown) => Promise<AxeResult> } }
  interface AxeResult {
    violations: { id: string; impact: string | null; help: string; description: string; helpUrl: string; tags: string[]; nodes: { target: unknown[]; failureSummary?: string; html: string }[] }[]
    incomplete: unknown[]
    passes: unknown[]
  }
  const win = window as W
  if (win.__studio) return
  const headless = window.parent === window
  if (headless && !Array.isArray(win.__studioOps)) return
  win.__studio = true

  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*'
  const post = (msg: Record<string, unknown>) => {
    if (!headless) window.parent.postMessage({ studio: true, ...msg }, parentOrigin)
  }
  const uid = () => Math.random().toString(36).slice(2, 10)
  let mode: 'browse' | 'select' = 'browse'
  let snapOn = true
  /** canvas zoom, so snapping feels the same at any zoom */
  let scale = 1
  let hovered: Element | null = null
  /** what's selected: the last one is the one the side panel shows */
  let selection: Element[] = []
  const primary = () => selection[selection.length - 1] ?? null
  let editing: HTMLElement | null = null
  let locks: string[] = []

  // --- Drawing ------------------------------------------------------------------------------

  const css = document.createElement('style')
  css.setAttribute('data-studio-ui', '')
  css.textContent = `
    [data-studio-box]{position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border-radius:2px;display:none}
    [data-studio-box=hover]{outline:1.5px dashed #2f7dff;background:rgba(47,125,255,.06)}
    [data-studio-box=selected]{outline:2px solid #2f7dff}
    [data-studio-box=selected][data-locked]{outline:2px dashed #8a94a6}
    [data-studio-box=guide]{background:#ff2fa0;border-radius:0}
    [data-studio-box=measure]{background:#ff4d4d;border-radius:0}
    [data-studio-box=target]{outline:1.5px solid #ff4d4d}
    [data-studio-box=drop]{outline:3px dashed #2fbf71;background:rgba(47,191,113,.12)}
    [data-studio-tag]{position:fixed;pointer-events:none;z-index:2147483647;font:600 11px/1 system-ui,sans-serif;color:#fff;background:#2f7dff;padding:4px 6px;border-radius:3px;white-space:nowrap;display:none}
    [data-studio-tag=offset]{background:#ff2fa0}
    [data-studio-tag=measure]{background:#ff4d4d}
    [data-studio-tag=drop]{background:#2fbf71}
    [data-studio-grid]{position:fixed;inset:0;pointer-events:none;z-index:2147483640;display:none}
    [data-studio-ruler]{position:fixed;pointer-events:none;z-index:2147483645;display:none;background:rgba(250,250,252,.94)}
    [data-studio-bar]{position:fixed;z-index:2147483647;display:none;gap:2px;padding:3px;background:#161b26;border-radius:7px;box-shadow:0 4px 18px rgba(0,0,0,.3);font:600 12px/1 system-ui,sans-serif;align-items:center}
    [data-studio-bar] button{all:unset;cursor:pointer!important;color:#fff;min-width:26px;height:26px;display:grid;place-items:center;border-radius:5px;padding:0 6px;box-sizing:border-box}
    [data-studio-bar] button:hover,[data-studio-bar] button[aria-pressed=true]{background:#2f7dff}
    [data-studio-bar] input{all:unset;cursor:text!important;background:#fff;color:#111;border-radius:4px;height:24px;padding:0 6px;width:200px;font:400 12px system-ui,sans-serif}
    [data-studio-bar] i{width:1px;height:16px;background:#ffffff33;margin:0 2px}
    html[data-studio-mode=select], html[data-studio-mode=select] *{cursor:default!important}
    html[data-studio-mode=select] [data-studio-selected]{cursor:move!important}
    html[data-studio-mode=select] [data-studio-locked-sel]{cursor:not-allowed!important}
    [data-studio-editing]{outline:2px solid #ff9f1a!important;outline-offset:2px;cursor:text!important;-webkit-user-select:text!important;user-select:text!important}
    [data-studio-editing] *{cursor:text!important}
    html[data-studio-dragging], html[data-studio-dragging] *{cursor:grabbing!important;user-select:none!important}
    ::highlight(studio-find){background:#ffe066;color:#111}
    ::highlight(studio-find-now){background:#ff9f1a;color:#111}
  `
  document.documentElement.appendChild(css)
  const make = (attr: string, kind: string) => {
    const el = document.createElement('div')
    el.setAttribute(attr, kind)
    document.documentElement.appendChild(el)
    return el
  }
  const hoverBox = make('data-studio-box', 'hover')
  const tag = make('data-studio-tag', '')
  const offsetTag = make('data-studio-tag', 'offset')
  const guides = [make('data-studio-box', 'guide'), make('data-studio-box', 'guide')]
  const measureLines = [0, 1, 2, 3].map(() => make('data-studio-box', 'measure'))
  const measureTags = [0, 1, 2, 3].map(() => make('data-studio-tag', 'measure'))
  const targetBox = make('data-studio-box', 'target')
  const dropBox = make('data-studio-box', 'drop')
  const dropTag = make('data-studio-tag', 'drop')
  const gridEl = make('data-studio-grid', '')
  const rulerTop = document.createElement('canvas')
  const rulerLeft = document.createElement('canvas')
  rulerTop.setAttribute('data-studio-ruler', 'top')
  rulerLeft.setAttribute('data-studio-ruler', 'left')
  document.documentElement.append(rulerTop, rulerLeft)
  const selBoxes: HTMLElement[] = []
  const ours = (el: Element | null) => !!el && (el.hasAttribute('data-studio-box') || el.hasAttribute('data-studio-tag') || el.hasAttribute('data-studio-bar') || el.hasAttribute('data-studio-grid') || el.hasAttribute('data-studio-ruler') || el.hasAttribute('data-studio-ui') || !!el.closest('[data-studio-bar]'))

  function place(el: Element | null, b: HTMLElement, label?: boolean) {
    if (!el || !el.isConnected) {
      b.style.display = 'none'
      if (label) tag.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(b.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    if (label) {
      tag.textContent = `${isLocked(el) ? '🔒 ' : ''}${describe(el)}`
      tag.style.display = 'block'
      const top = r.top > 22 ? r.top - 20 : r.bottom + 4
      Object.assign(tag.style, { left: `${Math.max(2, Math.min(r.left, innerWidth - tag.offsetWidth - 2))}px`, top: `${top}px` })
    }
  }

  /** one outline per selected element */
  function drawSelection() {
    while (selBoxes.length < selection.length) selBoxes.push(make('data-studio-box', 'selected'))
    selBoxes.forEach((b, i) => {
      const el = selection[i]
      place(el ?? null, b)
      if (el && isLocked(el)) b.setAttribute('data-locked', '')
      else b.removeAttribute('data-locked')
    })
    drawRulers()
  }

  function line(g: HTMLElement, x: number, y: number, w: number, h: number) {
    const t = Math.max(1, 1 / scale)
    Object.assign(g.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w || t}px`, height: `${h || t}px` })
  }
  const hideGuides = () => guides.forEach((g) => (g.style.display = 'none'))

  // --- Describing elements ------------------------------------------------------------------

  const NAMES: Record<string, string> = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', p: 'Paragraph', a: 'Link', img: 'Image', picture: 'Image', video: 'Video', iframe: 'Embed', button: 'Button', section: 'Section', header: 'Header', footer: 'Footer', nav: 'Menu', ul: 'List', ol: 'List', li: 'List item', form: 'Form', input: 'Field', textarea: 'Field', select: 'Field', label: 'Label', figure: 'Figure', blockquote: 'Quote', span: 'Text', svg: 'Icon', main: 'Main', article: 'Article', aside: 'Aside', div: 'Box', table: 'Table', tr: 'Table row', td: 'Table cell', th: 'Table heading', details: 'Question', summary: 'Question title' }

  const firstClass = (el: Element) => (typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('is-') && !c.startsWith('astro-'))[0] : '')

  function describe(el: Element) {
    const t = el.tagName.toLowerCase()
    const cls = firstClass(el)
    return `${NAMES[t] ?? t}${cls ? ` .${cls}` : ''}`
  }

  function selectorOf(el: Element): string {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const t = node.tagName.toLowerCase()
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !node.hasAttribute('data-studio-made')) {
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

  const query = (sel: string): Element | null => {
    try {
      return document.querySelector(sel)
    } catch {
      return null
    }
  }

  const TEXT_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, a, button, blockquote, figcaption, label, dt, dd, td, th, summary, small, legend, caption'

  /** what's worth selecting under the pointer: images win over the box they sit in */
  function pick(target: Element | null, exact = false): Element | null {
    if (!target || ours(target)) return null
    const media = target.closest('picture, img, video, svg, iframe')
    if (media) return media.closest('picture') ?? media
    if (target === document.body || target === document.documentElement) return null
    // a word or line inside a heading or paragraph (sites split headings into
    // spans for their reveal animations): select the whole heading instead.
    // Alt-click selects exactly what's under the pointer.
    if (!exact && getComputedStyle(target).display.startsWith('inline') && !target.matches('a, button, input, select, textarea, label')) {
      const block = target.closest(TEXT_BLOCKS)
      if (block) return block
    }
    return target
  }

  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const textOf = (el: Element) => squash(el.textContent ?? '')
  const imgOf = (el: Element) => (el.matches('img') ? (el as HTMLImageElement) : el.querySelector('img'))

  function isLocked(el: Element) {
    for (const s of locks) {
      try {
        if (el.closest(s)) return true
      } catch {
        /* a selector from an older page layout */
      }
    }
    return false
  }

  /** text you can edit in place: no images or nested blocks inside it */
  function isTextual(el: Element) {
    if (!textOf(el) || el.matches('img, picture, svg, video, input, textarea, select, iframe')) return false
    return !el.querySelector('img, picture, svg, video, h1, h2, h3, h4, h5, h6, p, ul, ol, div, section, table, form, iframe')
  }

  /** one of a run of matching things (list items, FAQs, cards, slides), found from the element or a parent of it */
  function itemOf(el: Element) {
    const sig = (e: Element) => `${e.tagName}|${(typeof e.className === 'string' ? e.className : '').split(/\s+/).filter((c) => c && !/^(is-|astro-|active|open|current|show|visible|in-view|revealed|aos-)/.test(c)).sort().join('.')}`
    const strong = (e: Element) => e.matches('li, details, tr, figure, article, dt') || /(^|[-_\s])(card|item|slide|tile|member|review|faq|plan|step|feature|question|testimonial|post|product|gig|col|cell|box|panel|entry)s?($|[-_\s])/i.test(typeof e.className === 'string' ? e.className : '')
    let medium: Element | null = null
    let node: Element | null = el
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++, node = node.parentElement) {
      const parent: Element | null = node.parentElement
      if (!parent) break
      const s = sig(node)
      const run = [...parent.children].filter((c) => !ours(c) && sig(c) === s)
      if (run.length < 2) continue
      if (strong(node)) return { el: node, run }
      const pd = getComputedStyle(parent).display
      if (!medium && /grid|flex/.test(pd) && !node.matches('p, span, h1, h2, h3, h4, h5, h6, a, br, small, strong, em')) medium = node
    }
    if (medium) {
      const s = sig(medium)
      return { el: medium, run: [...medium.parentElement!.children].filter((c) => !ours(c) && sig(c) === s) }
    }
    return null
  }

  function itemKind(e: Element): 'list' | 'faq' | 'card' | 'slide' | 'row' | 'item' {
    const c = typeof e.className === 'string' ? e.className : ''
    if (e.matches('tr')) return 'row'
    if (e.matches('details') || /faq|question|acc/i.test(c) || e.querySelector(':scope > summary')) return 'faq'
    if (/slide|carousel|swiper|splide|glide/i.test(c) || /slide|carousel|swiper|splide|track/i.test(typeof e.parentElement?.className === 'string' ? e.parentElement.className : '')) return 'slide'
    if (e.matches('li')) return 'list'
    if (/card|tile|review|testimonial|member|plan|product|post/i.test(c) || e.matches('article, figure')) return 'card'
    return 'item'
  }

  const BUTTONISH = /(^|[-_\s])(btn|button|cta)([-_\s]|$)/i
  function buttonOf(el: Element): HTMLElement | null {
    const b = (el.matches('a, button') ? el : el.closest('a, button')) as HTMLElement | null
    if (!b) return null
    if (b.matches('button') || BUTTONISH.test(typeof b.className === 'string' ? b.className : '')) return b
    const cs = getComputedStyle(b)
    const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0
    return filled && parseFloat(cs.paddingLeft) >= 8 && /inline-block|inline-flex|flex|block|grid/.test(cs.display) ? b : null
  }

  function fieldOf(el: Element) {
    const f = (el.matches('input, textarea, select') ? el : el.matches('label') ? (el as HTMLLabelElement).control ?? el.querySelector('input, textarea, select') : null) as HTMLInputElement | null
    if (!f || (f.type && /hidden|submit|button|image|reset/.test(f.type))) return null
    const label = (f.id ? document.querySelector(`label[for="${CSS.escape(f.id)}"]`) : null) ?? f.closest('label')
    // the words of the label, without the field's own text when the field sits inside it
    let labelText: string | null = null
    let labelSel: string | null = null
    if (label) {
      const textEl = [...label.querySelectorAll('span, b, strong')].find((s) => textOf(s) && !s.querySelector('input, textarea, select')) ?? label
      labelText = textEl === label ? squash([...label.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')) || textOf(label) : textOf(textEl)
      labelSel = selectorOf(textEl)
    }
    return { el: f, info: { type: f.tagName === 'INPUT' ? f.type || 'text' : f.tagName.toLowerCase(), label: labelText, labelSelector: labelSel, placeholder: f.getAttribute('placeholder'), required: f.required, name: f.name || '' } }
  }

  function formOf(el: Element) {
    const form = el.closest('form')
    if (!form) return null
    const scope = form.parentElement ?? form
    const thanks = [...scope.querySelectorAll('[class*="success" i], [class*="thank" i], [class*="sent" i], [data-success], [data-thanks], [role="status"], [aria-live]')].find((t) => textOf(t) && !t.querySelector('input, textarea, select, form') && textOf(t).length < 400)
    return { selector: selectorOf(form), thanks: thanks ? { selector: selectorOf(thanks), text: textOf(thanks) } : null }
  }

  const ANIM_ATTRS = ['data-reveal', 'data-split', 'data-aos', 'data-animate', 'data-anim', 'data-animation', 'data-sal', 'data-scroll', 'data-motion']
  function animationOf(el: Element) {
    for (const a of ANIM_ATTRS) if (el.hasAttribute(a)) return { attr: a, value: el.getAttribute(a) ?? '' }
    return null
  }

  function embedProvider(src: string) {
    if (/youtube(-nocookie)?\.com|youtu\.be/.test(src)) return 'youtube'
    if (/vimeo\.com/.test(src)) return 'vimeo'
    if (/google\.[a-z.]+\/maps|maps\.google/.test(src)) return 'maps'
    return 'other'
  }

  function bgOf(el: Element) {
    const bg = getComputedStyle(el).backgroundImage
    const m = bg && bg !== 'none' ? bg.match(/url\(["']?([^"')]+)["']?\)/) : null
    return m ? m[1] : null
  }

  function layoutOf(el: Element) {
    const cs = getComputedStyle(el)
    const kids = [...el.children].filter((c) => !ours(c) && getComputedStyle(c).display !== 'none')
    if (kids.length < 2) return null
    if (cs.display.includes('grid')) {
      const cols = cs.gridTemplateColumns.split(/\s+(?![^(]*\))/).filter(Boolean).length
      return { display: 'grid' as const, columns: cols, items: kids.length }
    }
    if (cs.display.includes('flex') && !cs.flexDirection.startsWith('column')) {
      const top = kids[0].getBoundingClientRect().top
      const cols = kids.filter((k) => Math.abs(k.getBoundingClientRect().top - top) < 4).length
      return { display: 'flex' as const, columns: cols, items: kids.length }
    }
    return null
  }

  const CSS_KEYS = ['font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'color', 'background-color', 'text-align', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin-top', 'margin-bottom', 'gap', 'display', 'grid-template-columns', 'justify-content', 'align-items', 'flex-direction', 'object-position', 'object-fit', 'border-radius', 'text-transform', 'letter-spacing']

  function info(el: Element) {
    const r = el.getBoundingClientRect()
    const img = el.matches('svg') ? null : imgOf(el)
    const cs = getComputedStyle(el)
    const parent = el.parentElement
    const sibs = parent ? [...parent.children].filter((c) => !ours(c)) : []
    const item = itemOf(el)
    const cell = el.closest('td, th') as HTMLTableCellElement | null
    const table = cell?.closest('table')
    const rows = table ? [...table.rows] : []
    const btn = buttonOf(el)
    const field = fieldOf(el)
    const media = el.matches('video') ? el : el.matches('iframe') ? el : el.querySelector(':scope > video, :scope > iframe')
    const cssOut: Record<string, string> = {}
    for (const k of CSS_KEYS) cssOut[k] = cs.getPropertyValue(k)
    const shotSrc = img ? img.currentSrc || img.src : el.matches('svg') ? '' : ''
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      label: describe(el),
      text: textOf(el).slice(0, 600),
      image: img
        ? { src: shotSrc, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight, svg: /\.svg(\?|$)/i.test(shotSrc), fit: getComputedStyle(img).objectFit, position: getComputedStyle(img).objectPosition }
        : el.matches('svg')
          ? { src: '', alt: el.getAttribute('aria-label') ?? '', width: Math.round(r.width), height: Math.round(r.height), svg: true, fit: '', position: '' }
          : null,
      href: (el.closest('a') ?? (el.querySelectorAll('a').length === 1 ? el.querySelector('a') : null))?.getAttribute('href') ?? null,
      rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      style: { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(',')[0].replace(/["']/g, '')}`, color: cs.color, background: cs.backgroundColor, padding: cs.padding, margin: cs.margin },
      css: cssOut,
      classes: typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [],
      children: el.children.length,
      editable: isTextual(el),
      index: sibs.indexOf(el),
      siblings: sibs.length,
      moved: !!(el as HTMLElement).style?.translate && (el as HTMLElement).style.translate !== 'none',
      locked: isLocked(el),
      made: el.closest('[data-studio-made]')?.getAttribute('data-studio-made') ?? null,
      item: item ? { selector: selectorOf(item.el), label: describe(item.el), index: item.run.indexOf(item.el), count: item.run.length, kind: itemKind(item.el) } : null,
      table: cell && table ? { selector: selectorOf(table), row: rows.indexOf(cell.parentElement as HTMLTableRowElement), col: cell.cellIndex, rows: rows.length, cols: Math.max(...rows.map((x) => x.cells.length)) } : null,
      button: btn ? { classes: typeof btn.className === 'string' ? btn.className.trim() : '', newTab: btn.getAttribute('target') === '_blank' } : null,
      field: field ? field.info : null,
      form: formOf(el),
      bg: bgOf(el),
      media: media ? (media.matches('video') ? { kind: 'video' as const, src: (media as HTMLVideoElement).currentSrc || media.getAttribute('src') || media.querySelector('source')?.getAttribute('src') || '', provider: null } : { kind: 'embed' as const, src: media.getAttribute('src') ?? '', provider: embedProvider(media.getAttribute('src') ?? '') }) : null,
      animation: animationOf(el),
      layout: layoutOf(el),
    }
  }

  function select(el: Element | null, add = false) {
    if (add && el) {
      const i = selection.indexOf(el)
      if (i >= 0) selection.splice(i, 1)
      else selection.push(el)
    } else selection = el ? [el] : []
    // a parent and its child together makes no sense to move: keep the newest
    if (add && el) selection = selection.filter((s) => s === el || (!s.contains(el) && !el.contains(s)))
    document.querySelectorAll('[data-studio-selected]').forEach((s) => s.removeAttribute('data-studio-selected'))
    document.querySelectorAll('[data-studio-locked-sel]').forEach((s) => s.removeAttribute('data-studio-locked-sel'))
    for (const s of selection) s.setAttribute(isLocked(s) ? 'data-studio-locked-sel' : 'data-studio-selected', '')
    drawSelection()
    report()
  }

  function report() {
    const p = primary()
    post({ type: 'select', element: p ? info(p) : null, count: selection.length, others: selection.slice(0, -1).map((s) => ({ selector: selectorOf(s), label: describe(s), text: textOf(s).slice(0, 80) })) })
  }

  // --- Rich text: what survives editing ------------------------------------------------------

  const INLINE_KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'A', 'BR'])
  /** an element's words with only bold, italic, links and line breaks kept */
  function cleanInline(root: Node): string {
    let out = ''
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const walk = (n: Node) => {
      if (n.nodeType === 3) {
        out += esc(n.textContent ?? '')
        return
      }
      if (n.nodeType !== 1) return
      const e = n as Element
      if (e.hasAttribute('data-studio-bar')) return
      const t = e.tagName
      if (t === 'BR') {
        out += '<br>'
        return
      }
      if (t === 'SCRIPT' || t === 'STYLE') return
      // Chrome's editor writes bold as a styled span sometimes
      const bold = t === 'SPAN' && /^(bold|[6-9]00)$/.test((e as HTMLElement).style.fontWeight)
      const italic = t === 'SPAN' && (e as HTMLElement).style.fontStyle === 'italic'
      const keep = INLINE_KEEP.has(t)
      const name = keep ? t.toLowerCase() : bold ? 'strong' : italic ? 'em' : ''
      if (name) {
        const href = name === 'a' ? (e.getAttribute('href') ?? '') : ''
        const blank = name === 'a' && e.getAttribute('target') === '_blank'
        out += name === 'a' ? `<a href="${esc(href).replace(/"/g, '&quot;')}"${blank ? ' target="_blank" rel="noopener"' : ''}>` : `<${name}>`
      }
      e.childNodes.forEach(walk)
      if (name) out += `</${name}>`
    }
    root.childNodes.forEach(walk)
    return out.replace(/\s+/g, ' ').replace(/\s*<br>\s*/g, '<br>').trim()
  }
  const hasTags = (h: string) => /<(strong|b|em|i|a|br)\b/i.test(h)

  /** inline HTML from an edit, made safe to put in the page */
  function safeInline(html: string): DocumentFragment {
    const t = document.createElement('template')
    t.innerHTML = html
    const frag = document.createDocumentFragment()
    const copy = (from: Node, to: Node) => {
      from.childNodes.forEach((n) => {
        if (n.nodeType === 3) to.appendChild(document.createTextNode(n.textContent ?? ''))
        else if (n.nodeType === 1) {
          const e = n as Element
          if (INLINE_KEEP.has(e.tagName)) {
            const x = document.createElement(e.tagName.toLowerCase())
            if (e.tagName === 'A') {
              const href = e.getAttribute('href') ?? ''
              if (!/^\s*javascript:/i.test(href)) x.setAttribute('href', href)
              if (e.getAttribute('target') === '_blank') {
                x.setAttribute('target', '_blank')
                x.setAttribute('rel', 'noopener')
              }
            }
            copy(e, x)
            to.appendChild(x)
          } else copy(e, to)
        }
      })
    }
    copy(t.content, frag)
    return frag
  }

  /** a copied element as markup: no scripts, handlers or Studio's own marks */
  function cleanOuter(el: Element): string {
    const c = el.cloneNode(true) as Element
    const strip = (e: Element) => {
      for (const a of [...e.attributes]) if (/^on/i.test(a.name) || a.name.startsWith('data-studio') || a.name === 'data-sx' || (a.name === 'href' && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name)
      if ((e as HTMLElement).style?.translate) (e as HTMLElement).style.removeProperty('translate')
    }
    strip(c)
    c.querySelectorAll('*').forEach(strip)
    c.querySelectorAll('script, noscript').forEach((s) => s.remove())
    return c.outerHTML.slice(0, 80_000)
  }

  function parseHtml(html: string): Element | null {
    const t = document.createElement('template')
    t.innerHTML = html
    t.content.querySelectorAll('script, noscript').forEach((s) => s.remove())
    t.content.querySelectorAll('*').forEach((e) => {
      for (const a of [...e.attributes]) if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name)
    })
    return t.content.firstElementChild
  }

  /** an SVG from a file, made safe: no scripts, handlers, outside links or embedded HTML */
  function safeSvg(markup: string): SVGSVGElement | null {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    const svg = doc.documentElement
    if (!svg || svg.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null
    svg.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((e) => e.remove())
    for (const e of [svg, ...svg.querySelectorAll('*')]) {
      for (const a of [...e.attributes]) {
        if (/^on/i.test(a.name)) e.removeAttribute(a.name)
        else if (/href$/i.test(a.name) && !a.value.trim().startsWith('#') && !a.value.trim().startsWith('data:image/')) e.removeAttribute(a.name)
      }
    }
    return document.importNode(svg, true) as unknown as SVGSVGElement
  }

  // --- Edits: apply and revert -------------------------------------------------------------

  /** how to undo each applied edit, by id */
  const applied = new Map<string, () => void>()
  /** style edits, kept as one stylesheet so screen-size ranges work in both canvases */
  const styleSheet = document.createElement('style')
  styleSheet.setAttribute('data-studio-ui', 'styles')
  document.head.appendChild(styleSheet)
  const styleOps = new Map<string, Op>()
  function writeStyles() {
    const rules: string[] = []
    for (const op of styleOps.values()) {
      const body = Object.entries(op.props ?? {})
        .filter(([k, v]) => /^[a-z-]+$/.test(k) && !/[{};<]/.test(v))
        .map(([k, v]) => `${k}: ${v} !important;`)
        .join(' ')
      const sel = `[data-sx~="${op.id}"]`
      const m = op.media
      const q = m && (m.min !== undefined || m.max !== undefined) ? [m.min !== undefined ? `(min-width: ${m.min}px)` : '', m.max !== undefined ? `(max-width: ${m.max}px)` : ''].filter(Boolean).join(' and ') : ''
      rules.push(q ? `@media ${q} { ${sel} { ${body} } }` : `${sel} { ${body} }`)
    }
    styleSheet.textContent = rules.join('\n')
  }
  const addToken = (el: Element, attr: string, id: string) => el.setAttribute(attr, `${el.getAttribute(attr) ?? ''} ${id}`.trim())
  const dropToken = (el: Element, attr: string, id: string) => {
    const v = (el.getAttribute(attr) ?? '').split(/\s+/).filter((x) => x && x !== id).join(' ')
    if (v) el.setAttribute(attr, v)
    else el.removeAttribute(attr)
  }

  /** text across the page: whole elements that read exactly `find`, then words inside longer text */
  function replaceText(id: string, find: string, replace: string | null, html: string | undefined, flags: { matchCase: boolean; wholeWord: boolean; exactBlocks: boolean }) {
    const undo: (() => void)[] = []
    if (!find) return false
    if (flags.exactBlocks) {
      for (const el of document.body.querySelectorAll(TEXT_BLOCKS)) {
        if (ours(el) || !isTextual(el) || textOf(el) !== find) continue
        const was = el.innerHTML
        if (html) el.replaceChildren(safeInline(html))
        else el.textContent = replace ?? ''
        undo.push(() => (el.innerHTML = was))
      }
    }
    const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(flags.wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, `g${flags.matchCase ? '' : 'i'}u`)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest('script, style, noscript, [data-studio-ui], [data-studio-bar], [data-studio-editing]') && !ours(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    })
    const nodes: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    for (const n of nodes) {
      const was = n.textContent ?? ''
      re.lastIndex = 0
      if (!re.test(was)) continue
      re.lastIndex = 0
      n.textContent = was.replace(re, replace ?? '')
      undo.push(() => (n.textContent = was))
    }
    if (!undo.length) return false
    applied.set(id, () => undo.reverse().forEach((u) => u()))
    return true
  }

  const uploadUrl = (id: string) => `/__studio/upload/${id}`

  function apply(op: Op): boolean {
    if (applied.has(op.id)) return true
    // edits that hold across the site
    if (op.kind === 'theme' && op.name && typeof op.after === 'string') {
      const root = document.documentElement
      const was = root.style.getPropertyValue(op.name)
      root.style.setProperty(op.name, op.after)
      applied.set(op.id, () => (was ? root.style.setProperty(op.name!, was) : root.style.removeProperty(op.name!)))
      return true
    }
    if (op.kind === 'replace' && typeof op.find === 'string') return replaceText(op.id, op.find, op.replace ?? '', undefined, { matchCase: !!op.matchCase, wholeWord: !!op.wholeWord, exactBlocks: false })
    if (op.kind === 'text' && op.everywhere && typeof op.before === 'string') return replaceText(op.id, op.before, typeof op.after === 'string' ? op.after : '', op.html, { matchCase: true, wholeWord: true, exactBlocks: true })

    const el = (op.selector === 'head' ? document.head : query(op.selector)) as HTMLElement | null
    if (!el) return false
    if (op.kind === 'text' && typeof op.after === 'string') {
      const html = el.innerHTML
      if (op.html) el.replaceChildren(safeInline(op.html))
      else el.textContent = op.after
      applied.set(op.id, () => (el.innerHTML = html))
    } else if ((op.kind === 'image' && (op.upload || op.src)) || (op.kind === 'svg' && !op.inline)) {
      const img = imgOf(el)
      if (!img) return false
      const pic = img.closest('picture')
      const sources = pic ? [...pic.querySelectorAll('source')] : []
      const was = { src: img.getAttribute('src'), srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes') }
      sources.forEach((s) => s.remove())
      img.removeAttribute('srcset')
      img.removeAttribute('sizes')
      img.src = op.upload ? uploadUrl(op.upload) : (op.src ?? '')
      applied.set(op.id, () => {
        if (was.src !== null) img.setAttribute('src', was.src)
        if (was.srcset !== null) img.setAttribute('srcset', was.srcset)
        if (was.sizes !== null) img.setAttribute('sizes', was.sizes)
        sources.forEach((s) => pic?.insertBefore(s, img))
      })
    } else if (op.kind === 'svg' && op.inline && op.markup) {
      const old = el.matches('svg') ? el : el.querySelector('svg')
      const svg = old ? safeSvg(op.markup) : null
      if (!old || !svg) return false
      const r = old.getBoundingClientRect()
      for (const a of ['class', 'width', 'height', 'aria-hidden', 'aria-label', 'role', 'focusable']) {
        const v = old.getAttribute(a)
        if (v !== null) svg.setAttribute(a, v)
      }
      if (!old.getAttribute('width') && !old.getAttribute('height')) {
        svg.setAttribute('width', String(Math.round(r.width)))
        svg.setAttribute('height', String(Math.round(r.height)))
      }
      if (op.recolour) {
        for (const e of [svg, ...svg.querySelectorAll('*')]) {
          for (const a of ['fill', 'stroke']) {
            const v = e.getAttribute(a)
            if (v && v !== 'none' && !v.startsWith('url(')) e.setAttribute(a, 'currentColor')
          }
          const st = (e as SVGElement).style
          if (st?.fill && st.fill !== 'none') st.fill = 'currentColor'
          if (st?.stroke && st.stroke !== 'none') st.stroke = 'currentColor'
        }
        if (!svg.getAttribute('fill')) svg.setAttribute('fill', 'currentColor')
      }
      old.replaceWith(svg)
      applied.set(op.id, () => svg.replaceWith(old))
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
      copy.setAttribute('data-studio-made', op.id)
      el.after(copy)
      applied.set(op.id, () => copy.remove())
    } else if (op.kind === 'paste' && typeof op.html === 'string') {
      const node = parseHtml(op.html)
      if (!node) return false
      node.setAttribute('data-studio-made', op.id)
      el.after(node)
      applied.set(op.id, () => node.remove())
    } else if (op.kind === 'hide') {
      if (op.scope === 'this-size' && op.width && Math.abs(innerWidth - op.width) > 0) {
        // hidden only at screen sizes like the one it was hidden on: a range either side
        const id = op.id
        styleOps.set(id, { ...op, props: { display: 'none' }, media: op.width < 900 ? { max: 899 } : { min: 900 } })
        addToken(el, 'data-sx', id)
        writeStyles()
        applied.set(id, () => {
          styleOps.delete(id)
          dropToken(el, 'data-sx', id)
          writeStyles()
        })
      } else {
        const was = el.style.display
        el.style.display = 'none'
        applied.set(op.id, () => (el.style.display = was))
      }
    } else if (op.kind === 'add-image' && (op.upload || op.src)) {
      const img = document.createElement('img')
      img.src = op.upload ? uploadUrl(op.upload) : (op.src ?? '')
      img.alt = op.alt ?? ''
      img.setAttribute('data-studio-made', op.id)
      img.style.cssText = 'display:block;max-width:100%;height:auto;margin:16px 0'
      el.after(img)
      applied.set(op.id, () => img.remove())
    } else if (op.kind === 'meta' && op.field) {
      if (op.field === 'title') {
        const was = document.title
        document.title = op.after ?? ''
        applied.set(op.id, () => (document.title = was))
      } else {
        const name = op.field
        const value = name === 'og:image' ? (op.upload ? `${location.origin}${uploadUrl(op.upload)}` : '') : (op.after ?? '')
        let t = metaTag(name)
        const made = !t
        if (!t) {
          t = document.createElement('meta')
          t.setAttribute(name === 'description' ? 'name' : 'property', name)
          document.head.appendChild(t)
        }
        const m = t
        const was = m.getAttribute('content')
        m.setAttribute('content', value)
        applied.set(op.id, () => (made ? m.remove() : m.setAttribute('content', was ?? '')))
      }
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
    } else if (op.kind === 'style' && op.props) {
      styleOps.set(op.id, op)
      addToken(el, 'data-sx', op.id)
      writeStyles()
      applied.set(op.id, () => {
        styleOps.delete(op.id)
        dropToken(el, 'data-sx', op.id)
        writeStyles()
      })
    } else if (op.kind === 'attr' && op.name && /^[a-z][\w:-]*$/i.test(op.name) && !/^on/i.test(op.name)) {
      const name = op.name
      const target = name === 'required' || name === 'placeholder' ? ((el.matches('input, textarea, select') ? el : el.querySelector('input, textarea, select')) as HTMLElement | null) : el.matches('a, button') || !['target', 'class'].includes(name) ? el : (buttonOf(el) ?? el)
      if (!target) return false
      if (name === 'src' && typeof op.after === 'string' && /^\s*javascript:/i.test(op.after)) return false
      const was = target.getAttribute(name)
      if (op.after === null || op.after === undefined) target.removeAttribute(name)
      else target.setAttribute(name, op.after)
      if (name === 'target' && op.after === '_blank') target.setAttribute('rel', 'noopener')
      // an animation switched off: show it as it ends up
      const reveal = ANIM_ATTRS.includes(name) && op.after === null
      const wasStyle = (target as HTMLElement).style.cssText
      if (reveal) Object.assign((target as HTMLElement).style, { opacity: '1', transform: 'none', visibility: 'visible' })
      applied.set(op.id, () => {
        if (was === null) target.removeAttribute(name)
        else target.setAttribute(name, was)
        if (reveal) (target as HTMLElement).style.cssText = wasStyle
      })
    } else if (op.kind === 'table') {
      const table = (el.closest('table') ?? el.querySelector('table')) as HTMLTableElement | null
      if (!table) return false
      const rows = [...table.rows]
      const undo: (() => void)[] = []
      const blank = (cell: Element) => {
        cell.textContent = ' '
        return cell
      }
      if (op.action === 'add-row' && rows[op.row ?? 0]) {
        const src = rows[op.row ?? 0]
        const copy = src.cloneNode(true) as HTMLTableRowElement
        ;[...copy.cells].forEach(blank)
        copy.setAttribute('data-studio-made', op.id)
        src.after(copy)
        undo.push(() => copy.remove())
      } else if (op.action === 'remove-row' && rows[op.row ?? 0]) {
        const row = rows[op.row ?? 0]
        const was = row.style.display
        row.style.display = 'none'
        undo.push(() => (row.style.display = was))
      } else if (op.action === 'add-col') {
        for (const row of rows) {
          const cell = row.cells[Math.min(op.col ?? 0, row.cells.length - 1)]
          if (!cell) continue
          const copy = blank(cell.cloneNode(true) as Element)
          copy.setAttribute('data-studio-made', op.id)
          cell.after(copy)
          undo.push(() => copy.remove())
        }
      } else if (op.action === 'remove-col') {
        for (const row of rows) {
          const cell = row.cells[op.col ?? 0] as HTMLElement | undefined
          if (!cell) continue
          const was = cell.style.display
          cell.style.display = 'none'
          undo.push(() => (cell.style.display = was))
        }
      } else return false
      applied.set(op.id, () => undo.reverse().forEach((u) => u()))
    } else if (op.kind === 'bg' && (op.upload || op.src)) {
      const was = el.style.getPropertyValue('background-image')
      const prio = el.style.getPropertyPriority('background-image')
      el.style.setProperty('background-image', `url("${op.upload ? uploadUrl(op.upload) : op.src}")`, 'important')
      applied.set(op.id, () => (was ? el.style.setProperty('background-image', was, prio) : el.style.removeProperty('background-image')))
    } else if (op.kind === 'video' && op.upload) {
      const v = (el.matches('video') ? el : el.querySelector('video')) as HTMLVideoElement | null
      if (!v) return false
      const sources = [...v.querySelectorAll('source')]
      const was = v.getAttribute('src')
      sources.forEach((s) => s.remove())
      v.src = uploadUrl(op.upload)
      v.load()
      applied.set(op.id, () => {
        sources.forEach((s) => v.appendChild(s))
        if (was === null) v.removeAttribute('src')
        else v.setAttribute('src', was)
        v.load()
      })
    } else if (op.kind === 'embed' && op.src && /^https:\/\//.test(op.src)) {
      const box = document.createElement('div')
      box.setAttribute('data-studio-made', op.id)
      box.style.cssText = `position:relative;width:100%;aspect-ratio:${op.provider === 'maps' ? '4 / 3' : '16 / 9'};margin:16px 0;border-radius:12px;overflow:hidden`
      const f = document.createElement('iframe')
      f.src = op.src
      f.title = op.title ?? 'Embed'
      f.loading = 'lazy'
      f.allowFullscreen = true
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
      f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0'
      box.appendChild(f)
      el.after(box)
      applied.set(op.id, () => box.remove())
    } else if (op.kind === 'ask') {
      // made in the source by Claude when you save: nothing to show yet
      applied.set(op.id, () => {})
    } else return false
    return true
  }

  function revert(id: string) {
    applied.get(id)?.()
    applied.delete(id)
  }

  /** an edit made here: applied at once, then handed to Blueprint to keep */
  function made(op: Omit<Op, 'id' | 'page'> & { id?: string }, el?: Element) {
    const madeBy = el?.closest('[data-studio-made]')?.getAttribute('data-studio-made') ?? undefined
    const full = { ...op, id: op.id ?? uid(), page: location.pathname, ...(madeBy ? { made: madeBy } : {}) } as Op
    if (op.kind !== 'move') apply(full)
    post({ type: 'op', op: full })
    return full
  }

  // --- Text editing ------------------------------------------------------------------------

  const bar = document.createElement('div')
  bar.setAttribute('data-studio-bar', '')
  bar.innerHTML = `<button data-cmd="bold" title="Bold (Ctrl B)"><b>B</b></button><button data-cmd="italic" title="Italic (Ctrl I)"><i style="all:unset;font-style:italic;font-family:Georgia,serif">I</i></button><button data-cmd="link" title="Link (Ctrl K)">Link</button><button data-cmd="unlink" title="Remove the link">Unlink</button><i></i><button data-cmd="br" title="Line break (Shift Enter)">↵</button><i></i><button data-cmd="done" title="Done (Enter)">Done</button><input data-url placeholder="https://… or /page, then Enter" style="display:none">`
  document.documentElement.appendChild(bar)
  const urlInput = bar.querySelector('input[data-url]') as HTMLInputElement
  let savedRange: Range | null = null

  function placeBar(el: HTMLElement) {
    const r = el.getBoundingClientRect()
    bar.style.display = 'flex'
    const top = r.top > 44 ? r.top - 40 : r.bottom + 8
    bar.style.left = `${Math.max(4, Math.min(r.left, innerWidth - bar.offsetWidth - 4))}px`
    bar.style.top = `${Math.max(4, top)}px`
  }

  let finishEdit: ((keep: boolean) => void) | null = null

  function startEdit(el: HTMLElement) {
    if (!isTextual(el) || editing || isLocked(el)) return
    const before = textOf(el)
    const original = el.innerHTML
    const beforeHtml = cleanInline(el)
    editing = el
    el.setAttribute('data-studio-editing', '')
    el.innerHTML = beforeHtml || before
    el.contentEditable = 'true'
    el.spellcheck = true
    if (!el.lang && !document.documentElement.lang) el.lang = 'en-GB'
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    place(null, hoverBox, true)
    placeBar(el)
    urlInput.style.display = 'none'
    post({ type: 'editing', on: true })

    const finish = (keep: boolean) => {
      finishEdit = null
      el.removeEventListener('keydown', onKey, true)
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('focusout', onBlur)
      el.removeEventListener('input', onInput)
      el.contentEditable = 'inherit'
      el.removeAttribute('contenteditable')
      el.removeAttribute('data-studio-editing')
      el.spellcheck = false
      bar.style.display = 'none'
      editing = null
      const afterHtml = cleanInline(el)
      const after = squash(el.innerText ?? '')
      el.innerHTML = original
      if (keep && after && (after !== before || afterHtml !== beforeHtml)) {
        const styled = hasTags(afterHtml) || hasTags(beforeHtml)
        made({ kind: 'text', selector: selectorOf(el), label: describe(el), text: before, before, after, ...(styled ? { html: afterHtml } : {}) }, el)
      }
      drawSelection()
      post({ type: 'editing', on: false })
      report()
    }
    finishEdit = finish
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        document.execCommand('insertLineBreak')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if ((e.ctrlKey || e.metaKey) && (k === 'b' || k === 'i')) {
        e.preventDefault()
        document.execCommand(k === 'b' ? 'bold' : 'italic')
      } else if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault()
        askUrl()
      }
    }
    // pasted text comes in plain, so a site's look isn't broken by copied formatting
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      const t = e.clipboardData?.getData('text/plain') ?? ''
      document.execCommand('insertText', false, t.replace(/\s+/g, ' '))
    }
    const onBlur = (e: FocusEvent) => {
      if (e.relatedTarget && bar.contains(e.relatedTarget as Node)) return
      // clicking the toolbar's link box moves focus there: keep editing
      setTimeout(() => {
        if (editing === el && !bar.contains(document.activeElement) && document.activeElement !== el) finish(true)
      }, 0)
    }
    const onInput = () => placeBar(el)
    el.addEventListener('keydown', onKey, true)
    el.addEventListener('paste', onPaste, true)
    el.addEventListener('focusout', onBlur)
    el.addEventListener('input', onInput)
  }

  function askUrl() {
    const s = getSelection()
    if (!editing || !s || !s.rangeCount || s.isCollapsed) return
    savedRange = s.getRangeAt(0).cloneRange()
    const a = (s.anchorNode?.parentElement?.closest('a') ?? null) as HTMLAnchorElement | null
    urlInput.value = a?.getAttribute('href') ?? ''
    urlInput.style.display = 'block'
    urlInput.focus()
  }
  urlInput.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      const url = urlInput.value.trim()
      urlInput.style.display = 'none'
      if (!editing) return
      editing.focus()
      if (savedRange) {
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(savedRange)
      }
      if (e.key === 'Enter' && url && !/^\s*javascript:/i.test(url)) document.execCommand('createLink', false, url)
      savedRange = null
    }
  })
  bar.addEventListener('mousedown', (e) => {
    // keep the text selection while pressing the toolbar
    if ((e.target as Element).closest('button')) e.preventDefault()
  })
  bar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('button')
    if (!b || !editing) return
    e.preventDefault()
    e.stopPropagation()
    const cmd = b.getAttribute('data-cmd')
    if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd)
    else if (cmd === 'link') askUrl()
    else if (cmd === 'unlink') document.execCommand('unlink')
    else if (cmd === 'br') document.execCommand('insertLineBreak')
    else if (cmd === 'done') finishEdit?.(true)
  })

  // --- Dragging with snap-to-align ----------------------------------------------------------

  interface Rect {
    l: number
    t: number
    r: number
    b: number
    name: string
  }
  interface Drag {
    els: HTMLElement[]
    starts: { x: number; y: number }[]
    x0: number
    y0: number
    base: { left: number; top: number; right: number; bottom: number }
    targets: Rect[]
    moved: boolean
    snapped: string[]
  }
  let drag: Drag | null = null

  const currentShift = (el: HTMLElement) => {
    const m = (el.style.translate || '').match(/(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/)
    return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : { x: 0, y: 0 }
  }

  const union = (els: Element[]) => {
    const rs = els.map((e) => e.getBoundingClientRect())
    return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) }
  }

  /** edges and centres worth lining up with: other visible elements and the page itself */
  function snapTargets(els: Element[]): Rect[] {
    const out: Rect[] = [{ l: 0, t: -1e5, r: innerWidth, b: 1e5, name: 'the page' }]
    const all = document.body.querySelectorAll('*')
    for (let i = 0; i < all.length && out.length < 1500; i++) {
      const o = all[i]
      if (els.some((el) => o === el || el.contains(o)) || ours(o)) continue
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
      clearMeasure()
    }
    let ox = mx
    let oy = my
    const b = drag.base
    const rect = { l: b.left + mx, t: b.top + my, r: b.right + mx, b: b.bottom + my }
    hideGuides()
    drag.snapped = []
    if (snapOn && !e.altKey) {
      const { bx, by } = snap(rect, drag.targets)
      if (bx) {
        ox += bx.d
        rect.l += bx.d
        rect.r += bx.d
        const top = Math.min(rect.t, bx.t.t)
        line(guides[0], bx.at, Math.max(top, 0), 0, Math.min(Math.max(rect.b, bx.t.b), innerHeight) - Math.max(top, 0))
        drag.snapped.push(`its ${EDGE[bx.i]} lines up with the ${EDGE[bx.j]} of ${bx.t.name}`)
      }
      if (by) {
        oy += by.d
        rect.t += by.d
        rect.b += by.d
        const left = Math.min(rect.l, by.t.l)
        line(guides[1], Math.max(left, 0), by.at, Math.min(Math.max(rect.r, by.t.r), innerWidth) - Math.max(left, 0), 0)
        drag.snapped.push(`its ${EDGE_Y[by.i]} lines up with the ${EDGE_Y[by.j]} of ${by.t.name}`)
      }
    }
    ox = Math.round(ox)
    oy = Math.round(oy)
    drag.els.forEach((el, i) => (el.style.translate = `${drag!.starts[i].x + ox}px ${drag!.starts[i].y + oy}px`))
    drawSelection()
    const first = drag.starts[drag.starts.length - 1]
    const dx = first.x + ox
    const dy = first.y + oy
    offsetTag.textContent = drag.els.length > 1 ? `${drag.els.length} items  x ${ox >= 0 ? '+' : ''}${ox}  y ${oy >= 0 ? '+' : ''}${oy}` : `x ${dx >= 0 ? '+' : ''}${dx}  y ${dy >= 0 ? '+' : ''}${dy}`
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
    d.els.forEach((el, i) => {
      const { x, y } = currentShift(el)
      const s = d.starts[i]
      el.style.translate = s.x || s.y ? `${s.x}px ${s.y}px` : ''
      moveTo(el, x, y, d.snapped, false)
    })
    drawSelection()
    report()
  }

  /** a move: always the element's total shift from where the site puts it */
  const lastMove = new Map<Element, string>()
  function moveTo(el: HTMLElement, dx: number, dy: number, snapped: string[], tellNow = true) {
    const reuse = lastMove.get(el)
    if (reuse) revert(reuse)
    const op = { id: reuse ?? uid(), kind: 'move' as const, selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 120), dx, dy, width: innerWidth, snapped }
    const madeBy = el.closest('[data-studio-made]')?.getAttribute('data-studio-made')
    const full = { ...op, page: location.pathname, ...(madeBy ? { made: madeBy } : {}) } as Op
    apply(full)
    post({ type: 'op', op: full })
    lastMove.set(el, full.id)
    if (tellNow) {
      drawSelection()
      report()
    }
  }

  /** line the selected elements up with each other, like a design tool's align buttons */
  function align(how: string) {
    const els = selection.filter((s) => !isLocked(s)) as HTMLElement[]
    if (els.length < 2) return
    const u = union(els)
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const s = currentShift(el)
      let dx = 0
      let dy = 0
      if (how === 'left') dx = u.left - r.left
      if (how === 'center') dx = (u.left + u.right) / 2 - (r.left + r.right) / 2
      if (how === 'right') dx = u.right - r.right
      if (how === 'top') dy = u.top - r.top
      if (how === 'middle') dy = (u.top + u.bottom) / 2 - (r.top + r.bottom) / 2
      if (how === 'bottom') dy = u.bottom - r.bottom
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      moveTo(el, Math.round(s.x + dx), Math.round(s.y + dy), [`aligned (${how}) with ${els.length - 1} other item${els.length > 2 ? 's' : ''}`], false)
    }
    drawSelection()
    report()
  }

  // --- Measuring (hold Alt) ---------------------------------------------------------------

  function clearMeasure() {
    measureLines.forEach((l) => (l.style.display = 'none'))
    measureTags.forEach((l) => (l.style.display = 'none'))
    targetBox.style.display = 'none'
  }

  function measure(other: Element | null) {
    clearMeasure()
    const sel = primary()
    if (!sel || !other || other === sel || ours(other)) return
    const a = sel.getBoundingClientRect()
    const b = other.getBoundingClientRect()
    place(other, targetBox)
    let n = 0
    const show = (x: number, y: number, w: number, h: number, value: number, lx: number, ly: number) => {
      if (n > 3 || value < 1) return
      line(measureLines[n], x, y, w, h)
      const t = measureTags[n]
      t.textContent = `${Math.round(value)}`
      Object.assign(t.style, { display: 'block', left: `${lx}px`, top: `${ly}px` })
      n++
    }
    const inside = b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom
    const cy = (a.top + a.bottom) / 2
    const cx = (a.left + a.right) / 2
    if (inside) {
      show(b.left, cy, a.left - b.left, 0, a.left - b.left, (b.left + a.left) / 2 - 10, cy + 4)
      show(a.right, cy, b.right - a.right, 0, b.right - a.right, (a.right + b.right) / 2 - 10, cy + 4)
      show(cx, b.top, 0, a.top - b.top, a.top - b.top, cx + 4, (b.top + a.top) / 2 - 8)
      show(cx, a.bottom, 0, b.bottom - a.bottom, b.bottom - a.bottom, cx + 4, (a.bottom + b.bottom) / 2 - 8)
      return
    }
    const y = Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom) ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 : cy
    const x = Math.max(a.left, b.left) < Math.min(a.right, b.right) ? (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2 : cx
    if (b.left >= a.right) show(a.right, y, b.left - a.right, 0, b.left - a.right, (a.right + b.left) / 2 - 10, y + 4)
    else if (a.left >= b.right) show(b.right, y, a.left - b.right, 0, a.left - b.right, (b.right + a.left) / 2 - 10, y + 4)
    if (b.top >= a.bottom) show(x, a.bottom, 0, b.top - a.bottom, b.top - a.bottom, x + 4, (a.bottom + b.top) / 2 - 8)
    else if (a.top >= b.bottom) show(x, b.bottom, 0, a.top - b.bottom, a.top - b.bottom, x + 4, (b.bottom + a.top) / 2 - 8)
  }

  // --- Grid and rulers ------------------------------------------------------------------------

  let showGrid = false
  let showRulers = false

  /** the page's content width: the most common centred max-width */
  function containerWidth() {
    const counts = new Map<number, number>()
    const all = document.body.querySelectorAll('div, section, main, header, footer, article')
    for (let i = 0; i < all.length && i < 3000; i++) {
      const cs = getComputedStyle(all[i])
      const mw = parseFloat(cs.maxWidth)
      if (!mw || mw >= innerWidth || cs.marginLeft !== cs.marginRight) continue
      counts.set(mw, (counts.get(mw) ?? 0) + 1)
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]
    return best ? Math.min(best[0], innerWidth) : innerWidth
  }

  function drawGrid() {
    if (!showGrid) {
      gridEl.style.display = 'none'
      return
    }
    const cols = innerWidth < 600 ? 4 : innerWidth < 900 ? 8 : 12
    const gutter = innerWidth < 600 ? 16 : 24
    const w = Math.min(containerWidth(), innerWidth - (innerWidth < 600 ? 32 : 48))
    const left = (innerWidth - w) / 2
    const col = (w - gutter * (cols - 1)) / cols
    gridEl.innerHTML = Array.from({ length: cols }, (_, i) => `<div style="position:absolute;top:0;bottom:0;left:${left + i * (col + gutter)}px;width:${col}px;background:rgba(255,47,160,.07);border-left:1px solid rgba(255,47,160,.25);border-right:1px solid rgba(255,47,160,.25)"></div>`).join('') + `<div style="position:absolute;top:${showRulers ? 22 : 4}px;left:${left + 4}px;font:600 10px system-ui;color:#ff2fa0">${cols} columns · ${Math.round(w)}px</div>`
    gridEl.style.display = 'block'
  }

  function drawRulers() {
    if (!showRulers) {
      rulerTop.style.display = rulerLeft.style.display = 'none'
      return
    }
    const dpr = devicePixelRatio || 1
    const T = 18
    const setup = (c: HTMLCanvasElement, w: number, h: number, css: Partial<CSSStyleDeclaration>) => {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      Object.assign(c.style, { display: 'block', width: `${w}px`, height: `${h}px`, ...css })
      const ctx = c.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      ctx.font = '9px system-ui, sans-serif'
      ctx.fillStyle = '#6b7385'
      ctx.strokeStyle = '#9aa3b5'
      return ctx
    }
    const sel = selection.map((s) => s.getBoundingClientRect())
    const top = setup(rulerTop, innerWidth, T, { left: '0', top: '0', borderBottom: '1px solid #d0d5df' })
    for (const r of sel) {
      top.fillStyle = 'rgba(47,125,255,.25)'
      top.fillRect(r.left, 0, r.width, T)
    }
    top.fillStyle = '#6b7385'
    for (let x = 0; x <= innerWidth; x += 10) {
      const h = x % 100 === 0 ? 10 : x % 50 === 0 ? 6 : 3
      top.beginPath()
      top.moveTo(x + 0.5, T)
      top.lineTo(x + 0.5, T - h)
      top.stroke()
      if (x % 100 === 0 && x > 0) top.fillText(String(x), x + 2, 9)
    }
    const left = setup(rulerLeft, T, innerHeight, { left: '0', top: '0', borderRight: '1px solid #d0d5df' })
    for (const r of sel) {
      left.fillStyle = 'rgba(47,125,255,.25)'
      left.fillRect(0, r.top, T, r.height)
    }
    left.fillStyle = '#6b7385'
    const start = Math.floor(scrollY / 10) * 10
    for (let y = start; y <= scrollY + innerHeight; y += 10) {
      const sy = y - scrollY
      const w = y % 100 === 0 ? 10 : y % 50 === 0 ? 6 : 3
      left.beginPath()
      left.moveTo(T, sy + 0.5)
      left.lineTo(T - w, sy + 0.5)
      left.stroke()
      if (y % 100 === 0 && y > 0) {
        left.save()
        left.translate(9, sy + 2)
        left.rotate(Math.PI / 2)
        left.fillText(String(y), 0, 0)
        left.restore()
      }
    }
  }

  // --- Pointer and keys --------------------------------------------------------------------

  let altDown = false
  addEventListener(
    'pointermove',
    (e) => {
      if (drag) return dragTo(e)
      if (mode !== 'select' || editing) return
      const el = pick(document.elementFromPoint(e.clientX, e.clientY), e.altKey && !primary())
      altDown = e.altKey
      if (e.altKey && primary()) {
        place(null, hoverBox, true)
        measure(el)
        hovered = el
        return
      }
      clearMeasure()
      if (el === hovered && hoverBox.style.display === 'block') return
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
      clearMeasure()
    },
    true,
  )

  // in Edit mode a click selects instead of following links or pressing buttons
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'dblclick', 'touchstart', 'auxclick']) {
    addEventListener(
      type,
      (e) => {
        if (mode !== 'select') return
        if (editing && editing.contains(e.target as Node)) return
        if (bar.contains(e.target as Node)) return
        if (type === 'pointerup') endDrag()
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'pointerdown') {
          const pe = e as PointerEvent
          if (pe.button !== 0) return
          if (editing) finishEdit?.(true)
          const el = pick(e.target as Element, pe.altKey) as HTMLElement | null
          if (pe.shiftKey && el) {
            select(el, true)
            return
          }
          if (!el || !selection.includes(el)) select(el)
          const els = (selection.length > 1 && el && selection.includes(el) ? selection : el ? [el] : []).filter((s) => !isLocked(s)) as HTMLElement[]
          if (els.length) {
            const starts = els.map((s) => {
              const c = currentShift(s)
              s.style.translate = c.x || c.y ? `${c.x}px ${c.y}px` : ''
              return c
            })
            // the one you grabbed last, so the offset label follows it
            if (el && els.includes(el)) {
              const i = els.indexOf(el)
              els.push(els.splice(i, 1)[0])
              starts.push(starts.splice(i, 1)[0])
            }
            drag = { els, starts, x0: pe.clientX, y0: pe.clientY, base: union(els), targets: snapTargets(els), moved: false, snapped: [] }
          }
        }
        if (type === 'dblclick' && primary()) startEdit(primary() as HTMLElement)
      },
      true,
    )
  }

  addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt' && mode === 'select' && primary() && hovered) {
        e.preventDefault()
        measure(hovered)
      }
      if (mode !== 'select' || editing || !primary()) return
      const k = e.key.toLowerCase()
      const step = e.shiftKey ? 10 : 1
      const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (keys[e.key]) {
        e.preventDefault()
        e.stopImmediatePropagation()
        for (const s of selection) {
          if (isLocked(s)) continue
          const c = currentShift(s as HTMLElement)
          moveTo(s as HTMLElement, c.x + keys[e.key][0], c.y + keys[e.key][1], [], false)
        }
        drawSelection()
        report()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        startEdit(primary() as HTMLElement)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        select(null)
        post({ type: 'escape' })
      } else if ((e.ctrlKey || e.metaKey) && /^[zy]$/.test(k)) {
        e.preventDefault()
        post({ type: 'key', key: k, shift: e.shiftKey })
      } else if ((e.ctrlKey || e.metaKey) && /^[cvdf]$/.test(k)) {
        e.preventDefault()
        if (k === 'c') post({ type: 'copy', clip: clipOf(primary()!) })
        else post({ type: 'key', key: k === 'v' ? 'paste' : k === 'd' ? 'duplicate' : 'find' })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        post({ type: 'key', key: 'delete' })
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[vh]$/.test(k)) {
        post({ type: 'key', key: k })
      }
    },
    true,
  )
  addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altDown = false
      clearMeasure()
    }
  })
  // undo, redo and tool keys still reach Studio while the canvas has focus
  addEventListener('keydown', (e) => {
    if (editing || (mode === 'select' && primary())) return
    const k = e.key.toLowerCase()
    const typing = !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/.test(k) && !typing) {
      e.preventDefault()
      post({ type: 'key', key: k, shift: e.shiftKey })
    } else if ((e.ctrlKey || e.metaKey) && k === 'f') {
      e.preventDefault()
      post({ type: 'key', key: 'find' })
    } else if ((e.ctrlKey || e.metaKey) && k === 'v' && mode === 'select' && !typing) post({ type: 'key', key: 'paste' })
    else if (e.key === 'Escape') post({ type: 'escape' })
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[vh]$/.test(k) && !typing) post({ type: 'key', key: k })
  })

  const follow = () => {
    drawSelection()
    if (hovered && !altDown) place(hovered, hoverBox, true)
    if (editing) placeBar(editing)
    if (altDown && hovered) measure(hovered)
  }
  addEventListener('scroll', follow, true)
  addEventListener('resize', () => {
    follow()
    drawGrid()
  })

  function setMode(m: 'browse' | 'select') {
    mode = m
    document.documentElement.setAttribute('data-studio-mode', m)
    if (m === 'browse') {
      if (editing) finishEdit?.(true)
      hovered = null
      place(null, hoverBox, true)
      clearMeasure()
      select(null)
    }
  }

  // --- Dropping a file from the desktop ------------------------------------------------------

  let dropTarget: Element | null = null
  const dropKind = (el: Element | null, file: { type: string } | null) => {
    if (!el) return null
    const video = !!file && file.type.startsWith('video/')
    if (video) return el.matches('video') || el.querySelector(':scope > video') ? 'video' : null
    if (el.matches('picture, img') || (el.matches('svg') && false)) return 'image'
    if (bgOf(el)) return 'bg'
    return 'add-image'
  }
  addEventListener(
    'dragover',
    (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      const item = e.dataTransfer.items?.[0]
      const el = pick(document.elementFromPoint(e.clientX, e.clientY))
      dropTarget = el
      const kind = dropKind(el, item ? { type: item.type } : null)
      e.dataTransfer.dropEffect = kind && !(el && isLocked(el)) ? 'copy' : 'none'
      if (!el || !kind) {
        dropBox.style.display = dropTag.style.display = 'none'
        return
      }
      place(el, dropBox)
      dropTag.textContent = isLocked(el) ? '🔒 Locked' : kind === 'image' ? 'Drop to replace this photo' : kind === 'video' ? 'Drop to replace this video' : kind === 'bg' ? 'Drop to replace the background' : 'Drop to add the photo after this'
      const r = el.getBoundingClientRect()
      Object.assign(dropTag.style, { display: 'block', left: `${Math.max(2, r.left + 6)}px`, top: `${Math.max(2, r.top + 6)}px` })
    },
    true,
  )
  addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) dropBox.style.display = dropTag.style.display = 'none'
  })
  addEventListener(
    'drop',
    (e) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      e.stopPropagation()
      dropBox.style.display = dropTag.style.display = 'none'
      const file = e.dataTransfer.files[0]
      const el = dropTarget ?? pick(document.elementFromPoint(e.clientX, e.clientY))
      const kind = dropKind(el, file)
      if (!el || !kind || isLocked(el)) return
      select(el)
      post({ type: 'drop', file, kind })
    },
    true,
  )

  // --- Reading the page: layers, design tokens, copy ---------------------------------------------

  function clipOf(el: Element) {
    return { html: cleanOuter(el), page: location.pathname, selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 160) }
  }

  function layers() {
    const out: { selector: string; label: string; text: string; depth: number; children: number; hidden: boolean }[] = []
    const SKIP = 'script, style, noscript, template, link, meta, br, [data-studio-ui]'
    const walk = (el: Element, depth: number) => {
      for (const c of el.children) {
        if (out.length >= 900) return
        if (ours(c) || c.matches(SKIP)) continue
        const kids = [...c.children].filter((k) => !ours(k) && !k.matches(SKIP))
        const cs = getComputedStyle(c)
        const own = squash([...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')) || (kids.length ? '' : textOf(c))
        out.push({ selector: selectorOf(c), label: describe(c), text: own.slice(0, 60), depth, children: c.matches('svg, picture') ? 0 : kids.length, hidden: cs.display === 'none' || cs.visibility === 'hidden' })
        if (!c.matches('svg, picture, select') && depth < 12) walk(c, depth + 1)
      }
    }
    walk(document.body, 0)
    return out
  }

  function design() {
    const tokens = new Map<string, string>()
    const bps = new Map<string, number>()
    const sheets = [...document.styleSheets]
    const root = getComputedStyle(document.documentElement)
    const visit = (rules: CSSRuleList, media: string | null) => {
      for (const r of rules) {
        if (r instanceof CSSMediaRule) {
          visit(r.cssRules, r.conditionText || r.media.mediaText)
          continue
        }
        if ('cssRules' in r && (r as CSSGroupingRule).cssRules && !(r instanceof CSSStyleRule)) {
          visit((r as CSSGroupingRule).cssRules, media)
          continue
        }
        if (media) for (const m of media.matchAll(/\((min|max)-width:\s*([\d.]+)(px|em|rem)\)/g)) {
          const w = Math.round(Number(m[2]) * (m[3] === 'px' ? 1 : 16))
          const key = `${m[1]}:${w}`
          bps.set(key, (bps.get(key) ?? 0) + 1)
        }
        if (r instanceof CSSStyleRule && !media && /^(:root|html)(\s*,\s*(:root|html))*$/.test(r.selectorText.trim())) {
          for (let i = 0; i < r.style.length; i++) {
            const name = r.style[i]
            if (name.startsWith('--')) tokens.set(name, root.getPropertyValue(name).trim() || r.style.getPropertyValue(name).trim())
          }
        }
      }
    }
    for (const s of sheets) {
      try {
        if (s.ownerNode && ours(s.ownerNode as Element)) continue
        const mt = s.media?.mediaText || null
        if (mt) {
          // a whole stylesheet loaded only at some sizes (<link media="(max-width: 899px)">)
          for (const m of mt.matchAll(/\((min|max)-width:\s*([\d.]+)(px|em|rem)\)/g)) {
            const w = Math.round(Number(m[2]) * (m[3] === 'px' ? 1 : 16))
            const key = `${m[1]}:${w}`
            bps.set(key, (bps.get(key) ?? 0) + (s.cssRules?.length ?? 1))
          }
        }
        visit(s.cssRules, mt)
      } catch {
        /* a stylesheet from another site (fonts): can't be read, and doesn't matter */
      }
    }
    const kind = (v: string): 'colour' | 'size' | 'font' | 'other' => {
      if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()/i.test(v)) return 'colour'
      if (/^-?[\d.]+(px|rem|em|vw|vh|%|ch)?$|^(clamp|min|max|calc)\(/i.test(v)) return 'size'
      if (/,\s*(serif|sans-serif|monospace|system-ui|cursive)|^["']/.test(v)) return 'font'
      return 'other'
    }
    const buttons = new Map<string, { classes: string; label: string; background: string; color: string; border: string }>()
    for (const b of document.querySelectorAll('a[class], button[class]')) {
      const cls = typeof b.className === 'string' ? b.className.trim().replace(/\s+/g, ' ') : ''
      if (!cls || !BUTTONISH.test(cls) || buttons.has(cls) || buttons.size >= 10 || ours(b)) continue
      const cs = getComputedStyle(b)
      buttons.set(cls, { classes: cls, label: textOf(b).slice(0, 30), background: cs.backgroundColor, color: cs.color, border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` })
    }
    const animations: { attr: string; values: string[] }[] = []
    for (const a of ANIM_ATTRS) {
      const found = [...document.querySelectorAll(`[${a}]`)].map((e) => e.getAttribute(a) ?? '')
      if (found.length) animations.push({ attr: a, values: [...new Set(found)].slice(0, 12) })
    }
    const fonts = new Map<string, Set<number>>()
    document.fonts.forEach((f) => {
      const fam = f.family.replace(/^["']|["']$/g, '')
      const ws = f.weight.split(/\s+/).map(Number).filter(Boolean)
      const set = fonts.get(fam) ?? new Set<number>()
      if (ws.length === 2) for (let w = Math.ceil(ws[0] / 100) * 100; w <= ws[1]; w += 100) set.add(w)
      else ws.forEach((w) => set.add(w))
      fonts.set(fam, set)
    })
    return {
      tokens: [...tokens].slice(0, 240).map(([name, value]) => ({ name, value, kind: kind(value) })),
      breakpoints: [...bps]
        .map(([k, rules]) => ({ kind: k.split(':')[0] as 'min' | 'max', width: Number(k.split(':')[1]), rules }))
        .filter((b) => b.width >= 280 && b.width <= 2600)
        .sort((a, b) => b.rules - a.rules)
        .slice(0, 12),
      buttons: [...buttons.values()],
      animations,
      fonts: [...fonts].map(([family, w]) => ({ family, weights: [...w].sort((a, b) => a - b) })),
    }
  }

  // --- Find on the page ------------------------------------------------------------------------

  let found: Range[] = []
  function find(q: string, matchCase: boolean, wholeWord: boolean, step: number) {
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    reg?.delete('studio-find')
    reg?.delete('studio-find-now')
    if (step === 0 || !q) {
      found = []
      if (!q) return { count: 0, index: -1 }
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, `g${matchCase ? '' : 'i'}u`)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && !n.parentElement.closest('script, style, noscript, [data-studio-ui], [data-studio-bar]') && !ours(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      })
      for (let n = walker.nextNode(); n && found.length < 500; n = walker.nextNode()) {
        for (const m of (n.textContent ?? '').matchAll(re)) {
          const r = document.createRange()
          r.setStart(n, m.index!)
          r.setEnd(n, m.index! + m[0].length)
          found.push(r)
        }
      }
      findIndex = found.length ? 0 : -1
    } else if (found.length) findIndex = (findIndex + step + found.length) % found.length
    if (H && reg && found.length) {
      reg.set('studio-find', new H(...found))
      reg.set('studio-find-now', new H(found[findIndex]))
      const el = found[findIndex].startContainer.parentElement
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    return { count: found.length, index: findIndex }
  }
  let findIndex = -1

  // --- Share images, drawn with the site's own fonts ---------------------------------------------

  interface ShareSpec {
    title: string
    kicker: string
    photo: string | null
    background: string
    color: string
    accent: string
    font: string
    layout: 'split' | 'full' | 'plain'
    /** the site's address, written along the bottom */
    domain?: string
  }
  const loadImage = (src: string) =>
    new Promise<HTMLImageElement | null>((res) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => res(null)
      i.src = src
    })

  async function shareImage(s: ShareSpec, full: boolean): Promise<Blob | string | null> {
    const W = 1200
    const H = 630
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    ctx.fillStyle = s.background
    ctx.fillRect(0, 0, W, H)
    const photo = s.photo && s.layout !== 'plain' ? await loadImage(s.photo) : null
    const cover = (img: HTMLImageElement, x: number, y: number, w: number, h: number) => {
      const k = Math.max(w / img.naturalWidth, h / img.naturalHeight)
      const sw = w / k
      const sh = h / k
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h)
    }
    let textX = 72
    let textW = W - 144
    if (photo && s.layout === 'split') {
      cover(photo, W * 0.52, 0, W * 0.48, H)
      textW = W * 0.52 - 120
    } else if (photo && s.layout === 'full') {
      cover(photo, 0, 0, W, H)
      const g = ctx.createLinearGradient(0, 0, W, 0)
      g.addColorStop(0, 'rgba(0,0,0,.72)')
      g.addColorStop(0.75, 'rgba(0,0,0,.2)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      textW = W * 0.68
    }
    const family = s.font.split(',')[0].replace(/["']/g, '').trim()
    try {
      await document.fonts.load(`700 64px "${family}"`)
      await document.fonts.load(`600 26px "${family}"`)
    } catch {
      /* the system font stands in */
    }
    ctx.fillStyle = s.accent
    ctx.fillRect(textX, 120, 64, 5)
    ctx.fillStyle = s.color
    ctx.font = `600 26px "${family}", system-ui, sans-serif`
    ctx.fillText(s.kicker.slice(0, 60), textX, 98)
    // the title, wrapped and shrunk to fit
    let size = 72
    let lines: string[] = []
    const words = s.title.split(/\s+/).filter(Boolean)
    for (; size >= 36; size -= 4) {
      ctx.font = `700 ${size}px "${family}", system-ui, sans-serif`
      lines = []
      let cur = ''
      for (const w of words) {
        const t = cur ? `${cur} ${w}` : w
        if (ctx.measureText(t).width > textW && cur) {
          lines.push(cur)
          cur = w
        } else cur = t
      }
      if (cur) lines.push(cur)
      if (lines.length * size * 1.12 <= H - 220) break
    }
    lines.forEach((l, i) => ctx.fillText(l, textX, 190 + size + i * size * 1.12))
    ctx.font = `500 22px system-ui, sans-serif`
    ctx.globalAlpha = 0.8
    ctx.fillText((s.domain ?? '').slice(0, 60), textX, H - 60)
    ctx.globalAlpha = 1
    if (!full) return c.toDataURL('image/jpeg', 0.7)
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
  }

  // --- Accessibility (axe-core, loaded when asked) ---------------------------------------------

  async function a11y() {
    if (!win.axe) {
      await new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.src = '/__studio/axe.js'
        s.setAttribute('data-studio-ui', '')
        s.onload = () => res()
        s.onerror = () => rej(new Error('The accessibility checker couldn’t load'))
        document.head.appendChild(s)
      })
    }
    const r = await win.axe!.run(
      { exclude: [['[data-studio-box]'], ['[data-studio-tag]'], ['[data-studio-bar]'], ['[data-studio-grid]'], ['[data-studio-ruler]']] },
      { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } },
    )
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? 'minor',
      help: v.help,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 25).map((n) => {
        const sel = Array.isArray(n.target) && typeof n.target[0] === 'string' ? (n.target[0] as string) : ''
        const el = sel ? query(sel) : null
        return { selector: el ? selectorOf(el) : sel, summary: (n.failureSummary ?? '').replace(/^Fix (any|all) of the following:\s*/i, '').split('\n')[0].trim(), html: n.html.slice(0, 200), label: el ? describe(el) : '', text: el ? textOf(el).slice(0, 80) : '' }
      }),
      count: v.nodes.length,
    }))
  }

  // --- SEO ----------------------------------------------------------------------------------

  const metaTag = (k: string) => document.head.querySelector(`meta[name="${k}"], meta[property="${k}"]`) as HTMLMetaElement | null
  const metaOf = (k: string) => metaTag(k)?.getAttribute('content')?.trim() || null

  /** the business's name, phone, address and hours, from the page's words and its structured data */
  function napOf(main: HTMLElement, ld: Record<string, unknown>[]) {
    const biz = ld.find((o) => /LocalBusiness|Dentist|Organization|Store|Restaurant|MedicalBusiness|ProfessionalService|Corporation|MusicGroup|Event/.test(String(o['@type'])))
    const addr = biz?.address as Record<string, string> | string | undefined
    const address = typeof addr === 'string' ? addr : addr ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', ') : null
    const hours: string[] = []
    const oh = biz?.openingHours
    if (typeof oh === 'string') hours.push(oh)
    else if (Array.isArray(oh)) hours.push(...oh.map(String))
    const spec = biz?.openingHoursSpecification
    if (Array.isArray(spec))
      for (const s of spec as Record<string, unknown>[]) hours.push(`${[s.dayOfWeek].flat().map((d) => String(d).replace(/^https?:\/\/schema\.org\//, '')).join(', ')} ${s.opens ?? ''}–${s.closes ?? ''}`)
    const phones = new Set<string>()
    for (const a of document.querySelectorAll('a[href^="tel:"]')) phones.add(decodeURIComponent(a.getAttribute('href')!.slice(4)).trim())
    const body = document.body.innerText
    for (const m of body.matchAll(/(?:\+44\s?\(?0?\)?\s?|\b0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g)) phones.add(m[0].trim())
    const emails = new Set<string>()
    for (const a of document.querySelectorAll('a[href^="mailto:"]')) emails.add(a.getAttribute('href')!.slice(7).split('?')[0].trim().toLowerCase())
    if (!hours.length) {
      for (const line of body.split('\n')) {
        if (/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b.*\d{1,2}(:\d{2})?\s*(am|pm)?/i.test(line) && line.length < 80) hours.push(squash(line))
        if (hours.length >= 8) break
      }
    }
    void main
    return {
      name: (biz?.name as string | undefined) ?? metaOf('og:site_name'),
      phones: [...phones].slice(0, 12),
      emails: [...emails].slice(0, 8),
      address: address || (document.querySelector('address') ? textOf(document.querySelector('address')!).slice(0, 200) : null),
      hours: [...new Set(hours)].slice(0, 10),
      schemaPhone: (biz?.telephone as string | undefined) ?? null,
    }
  }

  /** What Google and the social networks read from this page. Links are checked when asked (`known`: statuses already found). */
  async function seoReport(known: Record<string, number>, checkLinks: boolean) {
    const nav = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined
    const headings = [...document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => !ours(h)).map((h) => ({ level: Number(h.tagName[1]), text: ((h as HTMLElement).innerText || textOf(h)).replace(/\s+/g, ' ').trim().slice(0, 120) }))

    const imgs = ([...document.body.querySelectorAll('img')] as HTMLImageElement[]).filter((i) => !ours(i) && !(i.complete && i.naturalWidth > 0 && i.naturalWidth <= 2))
    const missingAlt = imgs
      .filter((img) => {
        if (img.closest('[aria-hidden="true"]') || img.getAttribute('role') === 'presentation') return false
        const alt = img.getAttribute('alt')
        if (alt === null) return true
        if (alt.trim()) return false
        // an empty alt marks a decorative image, but on a big photo it's usually a mistake
        const r = img.getBoundingClientRect()
        return r.width >= 160 && r.height >= 120
      })
      .slice(0, 60)
      .map((img) => ({ selector: selectorOf(img.closest('picture') ?? img), src: img.currentSrc || img.src }))
    const seen = new Set<string>()
    const large = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((e) => (e.initiatorType === 'img' || /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(e.name)) && !e.name.includes('/__studio/'))
      .map((e) => ({ src: e.name, kb: Math.round((e.encodedBodySize || e.transferSize || 0) / 1024) }))
      .filter((x) => x.kb > 300 && !seen.has(x.src) && seen.add(x.src))

    const main = (document.querySelector('main') ?? document.body) as HTMLElement
    const mainText = squash(main.innerText)
    const words = (mainText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

    const schema = new Set<string>()
    const ld: Record<string, unknown>[] = []
    const types = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(types)
      if (!v || typeof v !== 'object') return
      const o = v as Record<string, unknown>
      ld.push(o)
      for (const t of [o['@type']].flat()) if (typeof t === 'string') schema.add(t)
      if (o['@graph']) types(o['@graph'])
    }
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        types(JSON.parse(s.textContent ?? ''))
      } catch {
        /* not valid JSON: Google ignores it too */
      }
    }

    const internal = new Set<string>()
    let external = 0
    for (const a of document.body.querySelectorAll('a[href]')) {
      const raw = (a.getAttribute('href') ?? '').trim()
      if (!raw || raw.startsWith('#') || /^(mailto|tel|sms|javascript|whatsapp):/i.test(raw)) continue
      let u: URL
      try {
        u = new URL(raw, location.href)
      } catch {
        continue
      }
      if (u.origin !== location.origin) {
        if (/^https?:$/.test(u.protocol)) external++
        continue
      }
      if (!u.pathname.startsWith('/__studio/')) internal.add(u.pathname)
    }
    const statuses: Record<string, number> = {}
    const todo: string[] = []
    for (const p of internal) {
      if (known[p] !== undefined) statuses[p] = known[p]
      else todo.push(p)
    }
    const status = async (p: string) => {
      try {
        let r = await fetch(p, { method: 'HEAD', cache: 'no-store' })
        // some dev servers don't answer HEAD: make sure before calling it broken
        if (r.status >= 400) r = await fetch(p, { cache: 'no-store' })
        return r.status
      } catch {
        return 0
      }
    }
    if (checkLinks) {
      const queue = todo.slice(0, 120)
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let p = queue.shift(); p !== undefined; p = queue.shift()) statuses[p] = await status(p)
        }),
      )
    }
    let favicon = !!document.querySelector('link[rel~="icon"]')
    if (!favicon) favicon = known['/favicon.ico'] === 200 || (await status('/favicon.ico')) === 200
    const lead = [...main.querySelectorAll('p')].map((p) => textOf(p)).find((t) => t.length >= 40) ?? ''

    return {
      path: location.pathname,
      url: location.href,
      status: nav?.responseStatus || 200,
      title: document.title.trim(),
      description: metaOf('description'),
      canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      robots: metaOf('robots'),
      lang: document.documentElement.lang || '',
      viewport: !!metaTag('viewport'),
      favicon,
      og: { title: metaOf('og:title'), description: metaOf('og:description'), image: metaOf('og:image'), url: metaOf('og:url'), type: metaOf('og:type') },
      twitter: metaOf('twitter:card'),
      headings,
      images: { total: imgs.length, missingAlt, large },
      words,
      schema: [...schema],
      links: {
        internal: internal.size,
        external,
        broken: Object.entries(statuses)
          .filter(([, c]) => c >= 400)
          .map(([href, c]) => ({ href, status: c })),
        statuses,
        checked: checkLinks,
      },
      // Studio fills these in from the repo
      site: { robots: true, sitemap: true },
      nap: napOf(main, ld),
      lead: lead.slice(0, 600),
      text: mainText.slice(0, 30_000),
    }
  }

  let seoAsked = 0
  async function sendSeo(known: Record<string, number>, links: boolean) {
    const n = ++seoAsked
    // the details at once, then again when the links have been checked
    post({ type: 'seo', report: await seoReport(known, false) })
    if (!links) return
    // photo sizes are only known once they've loaded
    if (document.readyState !== 'complete') await new Promise((done) => (addEventListener('load', done, { once: true }), setTimeout(done, 8000)))
    const full = await seoReport(known, true)
    if (n === seoAsked) post({ type: 'seo', report: full })
  }

  // --- Acting on the selection ---------------------------------------------------------------

  /** what an action from the side panel works on */
  function targetOf(which: string | undefined, el: Element): Element | null {
    if (!which || which === 'self') return el
    if (which === 'item') return itemOf(el)?.el ?? null
    if (which === 'button') return buttonOf(el)
    if (which === 'field') return fieldOf(el)?.el ?? null
    if (which === 'form') return el.closest('form')
    if (which === 'parent') return el.parentElement
    return query(which)
  }

  function act(a: { action: string; value?: string | null; upload?: string; src?: string; name?: string; scope?: string; target?: string; props?: Record<string, string>; media?: { min?: number; max?: number } | null; attr?: string; clip?: { html: string; page: string; selector: string; label: string; text: string }; table?: string; row?: number; col?: number; markup?: string; recolour?: boolean; provider?: string; title?: string; url?: string; prompt?: string; edit?: boolean }) {
    const first = primary()
    if (!first) return
    const el = targetOf(a.target, first)
    if (!el) return
    if (isLocked(el) && a.action !== 'ask') return
    const base = { selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 160) }
    const many = selection.length > 1 && (!a.target || a.target === 'self') ? selection.filter((s) => !isLocked(s)) : [el]
    if (a.action === 'link') {
      const link = el.closest('a') ?? el.querySelector('a')
      made({ ...base, kind: 'link', before: link?.getAttribute('href') ?? '', after: a.value ?? '' }, el)
    } else if (a.action === 'alt') {
      made({ ...base, kind: 'alt', before: imgOf(el)?.getAttribute('alt') ?? '', after: a.value ?? '' }, el)
    } else if (a.action === 'image' && (a.upload || a.src)) {
      made({ ...base, kind: 'image', before: imgOf(el)?.currentSrc ?? '', ...(a.upload ? { upload: a.upload } : { src: a.src }), name: a.name ?? 'photo', ...(a.scope === 'everywhere' ? { everywhere: true } : {}) }, el)
      setTimeout(report, 300)
      return
    } else if (a.action === 'add-image' && (a.upload || a.src)) {
      made({ ...base, kind: 'add-image', ...(a.upload ? { upload: a.upload } : { src: a.src }), name: a.name ?? 'photo', alt: a.value ?? '' }, el)
      const img = el.nextElementSibling
      setTimeout(() => select(img), 300)
      return
    } else if (a.action === 'duplicate') {
      const op = made({ ...base, kind: 'duplicate' }, el)
      const copy = el.nextElementSibling
      if (copy?.getAttribute('data-studio-made') === op.id) {
        select(copy)
        // a new item starts with its words ready to type over
        if (a.edit) {
          const t = isTextual(copy) ? copy : [...copy.querySelectorAll(TEXT_BLOCKS)].find((x) => isTextual(x))
          if (t) setTimeout(() => startEdit(t as HTMLElement), 50)
        }
      }
      return
    } else if (a.action === 'hide') {
      for (const s of many) made({ selector: selectorOf(s), label: describe(s), text: textOf(s).slice(0, 160), kind: 'hide', scope: a.scope ?? 'everywhere', width: innerWidth }, s)
      select(null)
      return
    } else if (a.action === 'unmove') {
      for (const s of many) moveTo(s as HTMLElement, 0, 0, [], false)
    } else if (a.action === 'text' && typeof a.value === 'string') {
      made({ ...base, kind: 'text', before: textOf(el), after: a.value, ...(a.scope === 'everywhere' ? { everywhere: true } : {}) }, el)
    } else if (a.action === 'style' && a.props) {
      for (const s of many) {
        const cs = getComputedStyle(s)
        const before: Record<string, string> = {}
        for (const k of Object.keys(a.props)) before[k] = cs.getPropertyValue(k)
        made({ selector: selectorOf(s), label: describe(s), text: textOf(s).slice(0, 160), kind: 'style', props: a.props, before, media: a.media ?? null, width: innerWidth }, s)
      }
    } else if (a.action === 'attr' && a.attr) {
      for (const s of a.target && a.target !== 'self' ? [el] : many) {
        const t = a.attr === 'required' || a.attr === 'placeholder' ? (fieldOf(s)?.el ?? s) : s
        made({ selector: selectorOf(s), label: describe(s), text: textOf(s).slice(0, 160), kind: 'attr', name: a.attr, before: t.getAttribute(a.attr), after: a.value ?? null }, s)
      }
    } else if (a.action === 'paste' && a.clip) {
      const op = made({ ...base, kind: 'paste', html: a.clip.html, from: { page: a.clip.page, selector: a.clip.selector, label: a.clip.label, text: a.clip.text } }, el)
      const node = el.nextElementSibling
      if (node?.getAttribute('data-studio-made') === op.id) {
        select(node)
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      return
    } else if (a.action === 'table' && a.table) {
      made({ ...base, kind: 'table', action: a.table, row: a.row ?? 0, col: a.col ?? 0 }, el)
    } else if (a.action === 'bg' && (a.upload || a.src)) {
      made({ ...base, kind: 'bg', before: bgOf(el) ?? '', ...(a.upload ? { upload: a.upload } : { src: a.src }), name: a.name ?? 'background' }, el)
    } else if (a.action === 'video' && a.upload) {
      const v = (el.matches('video') ? el : el.querySelector('video')) as HTMLVideoElement | null
      made({ ...base, kind: 'video', before: v?.currentSrc ?? '', upload: a.upload, name: a.name ?? 'video' }, el)
    } else if (a.action === 'embed' && a.url && a.value) {
      const op = made({ ...base, kind: 'embed', url: a.url, src: a.value, provider: a.provider ?? 'other', title: a.title ?? 'Embed' }, el)
      const box = el.nextElementSibling
      if (box?.getAttribute('data-studio-made') === op.id) {
        select(box)
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      return
    } else if (a.action === 'svg' && a.upload) {
      const inline = !imgOf(el) && !!(el.matches('svg') ? el : el.querySelector('svg'))
      const old = inline ? (el.matches('svg') ? el : el.querySelector('svg')) : null
      made({ ...base, kind: 'svg', upload: a.upload, name: a.name ?? 'logo.svg', inline, before: inline ? (old?.outerHTML.slice(0, 300) ?? '') : (imgOf(el)?.currentSrc ?? ''), recolour: !!a.recolour, markup: a.markup }, el)
      setTimeout(report, 200)
      return
    } else if (a.action === 'ask' && a.prompt) {
      made({ ...base, kind: 'ask', prompt: a.prompt }, el)
    }
    drawSelection()
    report()
  }

  // --- Messages from Studio -----------------------------------------------------------------

  interface Msg {
    type: string
    mode?: 'browse' | 'select'
    selector?: string
    op?: Op
    ops?: Op[]
    id?: string
    on?: boolean
    scale?: number
    known?: Record<string, number>
    links?: boolean
    selectors?: string[]
    grid?: boolean
    rulers?: boolean
    how?: string
    q?: string
    matchCase?: boolean
    wholeWord?: boolean
    step?: number
    spec?: ShareSpec
    full?: boolean
    add?: boolean
    nonce?: number
  }

  function onMessage(d: Msg, raw: Record<string, unknown>) {
    if (d.type === 'seo-request') void sendSeo(d.known && typeof d.known === 'object' ? d.known : {}, !!d.links)
    if (d.type === 'mode' && d.mode) setMode(d.mode)
    if (d.type === 'snap') snapOn = !!d.on
    if (d.type === 'scale' && d.scale) scale = d.scale
    if (d.type === 'clear') select(null)
    if (d.type === 'locks' && Array.isArray(d.selectors)) {
      locks = d.selectors.filter((s) => typeof s === 'string')
      select(primary()) // redraw with the new lock state
      if (selection.length > 1) report()
    }
    if (d.type === 'view') {
      showGrid = !!d.grid
      showRulers = !!d.rulers
      drawGrid()
      drawRulers()
    }
    if (d.type === 'apply' && d.op) {
      apply(d.op)
      drawSelection()
    }
    if (d.type === 'apply-all' && d.ops) for (const op of d.ops) apply(op)
    if (d.type === 'revert' && d.id) {
      revert(d.id)
      for (const [el, id] of lastMove) if (id === d.id) lastMove.delete(el)
      selection = selection.filter((s) => s.isConnected)
      drawSelection()
      if (primary()) report()
    }
    if (d.type === 'revert-all') {
      for (const id of [...applied.keys()].reverse()) revert(id)
      lastMove.clear()
    }
    if (d.type === 'edit-text' && primary()) startEdit(primary() as HTMLElement)
    if (d.type === 'action') act(raw as Parameters<typeof act>[0])
    if (d.type === 'align' && d.how) align(d.how)
    if (d.type === 'order' && primary() && (d.on === true || d.on === false)) {
      const el = targetOf((raw as { target?: string }).target, primary()!)
      if (!el || isLocked(el)) return
      const parent = el.parentElement
      const sibs = parent ? [...parent.children].filter((c) => !ours(c)) : []
      const i = sibs.indexOf(el)
      const other = sibs[d.on ? i - 1 : i + 1]
      if (!other) return
      made({ kind: 'order', selector: selectorOf(el), label: describe(el), text: textOf(el).slice(0, 120), direction: d.on ? 'earlier' : 'later', sibling: `${describe(other)}${textOf(other) ? ` (“${textOf(other).slice(0, 60)}”)` : ''}` }, el)
      drawSelection()
      report()
    }
    if (d.type === 'reveal' && d.selector) {
      const el = query(d.selector)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        select(el, !!d.add)
        setTimeout(drawSelection, 400)
      }
    }
    if (d.type === 'hover' ) {
      const el = d.selector ? query(d.selector) : null
      hovered = el
      place(el, hoverBox, true)
    }
    if (d.type === 'copy' && primary()) post({ type: 'copy', clip: clipOf(primary()!) })
    if (d.type === 'layers') post({ type: 'layers', layers: layers(), nonce: d.nonce })
    if (d.type === 'design') post({ type: 'design', design: design() })
    if (d.type === 'find') post({ type: 'found', ...find(d.q ?? '', !!d.matchCase, !!d.wholeWord, d.step ?? 0) })
    if (d.type === 'a11y')
      void a11y()
        .then((issues) => post({ type: 'a11y', issues }))
        .catch((e) => post({ type: 'a11y', error: (e as Error).message }))
    if (d.type === 'share-image' && d.spec) void shareImage(d.spec, !!d.full).then((out) => post({ type: 'share-image', out, full: !!d.full, nonce: d.nonce }))
    if (d.type === 'images') {
      // the photos on this page, for the share image maker
      const list = ([...document.images] as HTMLImageElement[]).filter((i) => i.naturalWidth >= 400 && !ours(i)).map((i) => i.currentSrc || i.src)
      post({ type: 'images', images: [...new Set(list)].slice(0, 24) })
    }
  }

  if (headless) {
    // a phone preview or a screenshot: show the unsaved edits, nothing else
    const go = () => {
      for (const op of win.__studioOps ?? []) if (op.page === location.pathname || op.page === '*' || op.kind === 'theme' || (op.kind === 'replace' && op.scope === 'site') || (op.kind === 'text' && op.everywhere)) apply(op)
      win.__studioReady = true
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
    return
  }

  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.studio !== true) return
    const d = e.data as Msg
    // edits that belong to other pages never run here
    if ((d.type === 'apply' && d.op && !here(d.op)) || d.type === 'apply-all') {
      if (d.type === 'apply-all' && d.ops) onMessage({ ...d, ops: d.ops.filter(here) }, e.data)
      return
    }
    onMessage(d, e.data)
  })
  function here(op: Op) {
    return op.page === location.pathname || op.kind === 'theme' || (op.kind === 'replace' && op.scope === 'site') || (op.kind === 'text' && !!op.everywhere)
  }

  const announce = () => post({ type: 'page', path: location.pathname, hash: location.hash, title: document.title })
  announce()
  addEventListener('popstate', announce)
  addEventListener('hashchange', announce)
  // Astro view transitions swap pages without a load
  document.addEventListener('astro:page-load', () => {
    applied.clear()
    styleOps.clear()
    writeStyles()
    selection = []
    announce()
    post({ type: 'ready' })
  })
  post({ type: 'ready' })
}

export const OVERLAY_JS = `(${overlay.toString()})();`
