import type { StudioEmbedProvider, StudioMedia, StudioOp } from './types'

// Plain-words descriptions of Studio edits, shared by the change list in
// Studio and the commit message when you push live, plus small helpers the
// canvas and the server both need.

const cut = (s: string, n = 40) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const META_NAME = { title: 'Google title', description: 'Google description', 'og:title': 'social share title', 'og:description': 'social share description', 'og:image': 'social share image' } as const

const where = (page: string) => (page === '/' ? 'home page' : page)

/** "“Book now”" or "Heading 2 .title": what an edit was made to */
const what = (op: StudioOp, n = 30) => (op.text ? `“${cut(op.text, n)}”` : op.label)

/** Edits that show on every page, not just the one they were made on. */
export function isGlobal(op: StudioOp): boolean {
  return op.kind === 'theme' || op.kind === 'palette' || op.kind === 'fonts' || (op.kind === 'replace' && op.scope === 'site') || (op.kind === 'text' && !!op.everywhere)
}

/** "900px and wider", "up to 899px", "600 to 899px" or "every size" */
export function mediaLabel(m: StudioMedia | null | undefined): string {
  if (!m || (m.min === undefined && m.max === undefined)) return 'every size'
  if (m.min !== undefined && m.max !== undefined) return `${m.min} to ${m.max}px`
  if (m.min !== undefined) return `${m.min}px and wider`
  return `up to ${m.max}px`
}

/** "@media (min-width: 900px)" for a range, or '' for every size */
export function mediaQuery(m: StudioMedia | null | undefined): string {
  if (!m) return ''
  const parts = [m.min !== undefined ? `(min-width: ${m.min}px)` : '', m.max !== undefined ? `(max-width: ${m.max}px)` : ''].filter(Boolean)
  return parts.length ? `@media ${parts.join(' and ')}` : ''
}

const PROP_NAME: Record<string, string> = {
  color: 'text colour',
  'background-color': 'background colour',
  'font-size': 'text size',
  'font-weight': 'text weight',
  'text-align': 'alignment',
  'padding-top': 'space inside (top)',
  'padding-bottom': 'space inside (bottom)',
  'padding-left': 'space inside (left)',
  'padding-right': 'space inside (right)',
  'margin-top': 'space above',
  'margin-bottom': 'space below',
  gap: 'gap between items',
  'grid-template-columns': 'columns',
  'object-position': 'photo focal point',
  'justify-content': 'alignment',
  'align-items': 'alignment',
}

export const propName = (p: string) => PROP_NAME[p] ?? p

export function opNote(op: StudioOp): string {
  const on = where(op.page)
  switch (op.kind) {
    case 'text':
      if (op.everywhere) return `Change “${cut(op.before)}” to “${cut(op.after)}” everywhere on the site`
      return `${op.html && /<[a-z]/i.test(op.html) ? 'Restyle and change' : 'Change'} “${cut(op.before)}” to “${cut(op.after)}” on the ${on}`
    case 'image':
      return `Swap the photo in ${op.label}${op.src ? ` for ${op.src.split('/').pop()}` : ''} on the ${op.everywhere ? 'site (every page using it)' : on}`
    case 'add-image':
      return `Add a photo after ${op.label} on the ${on}`
    case 'alt':
      return `Set the alt text of a photo on the ${on} to “${cut(op.after)}”`
    case 'link':
      return `Point ${what(op)} at ${cut(op.after, 50)} on the ${on}`
    case 'move': {
      const bits = [op.dx ? `${Math.abs(op.dx)}px ${op.dx > 0 ? 'right' : 'left'}` : '', op.dy ? `${Math.abs(op.dy)}px ${op.dy > 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(' and ')
      return `Move ${what(op)} ${bits || 'back into place'} on the ${on} (${op.width}px wide)`
    }
    case 'order':
      return `Move ${what(op)} ${op.direction === 'earlier' ? 'before' : 'after'} ${cut(op.sibling, 40)} on the ${on}`
    case 'duplicate':
      return `Duplicate ${what(op)} on the ${on}`
    case 'hide':
      return `${op.scope === 'everywhere' ? 'Remove' : `Hide at ${op.width}px wide`} ${what(op)} on the ${on}`
    case 'meta':
      return op.field === 'og:image' ? `Set the social share image of the ${on}` : `Set the ${META_NAME[op.field]} of the ${on} to “${cut(op.after, 50)}”`
    case 'style': {
      const keys = Object.keys(op.props)
      const list = keys.map((k) => `${propName(k)} ${cut(op.props[k], 24)}`).join(', ')
      return `Set ${cut(list, 60)} on ${what(op)} on the ${on}${op.media ? ` (${mediaLabel(op.media)})` : ''}`
    }
    case 'attr':
      if (op.name === 'class') return `Restyle ${what(op)} on the ${on}`
      if (op.after === null) return `Remove ${op.name} from ${what(op)} on the ${on}`
      return `Set ${op.name} of ${what(op)} to “${cut(op.after, 40)}” on the ${on}`
    case 'paste':
      return `Paste ${op.from.label}${op.from.page !== op.page ? ` from ${where(op.from.page)}` : ''} after ${what(op)} on the ${on}`
    case 'table':
      return `${{ 'add-row': 'Add a row to', 'remove-row': 'Remove a row from', 'add-col': 'Add a column to', 'remove-col': 'Remove a column from' }[op.action]} the table on the ${on}`
    case 'bg':
      return `Swap the background photo of ${op.label} on the ${on}`
    case 'video':
      return `Swap the video in ${op.label} on the ${on}`
    case 'embed':
      return `Add ${op.provider === 'maps' ? 'a Google map' : op.provider === 'other' ? 'an embed' : `a ${op.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video`} after ${what(op)} on the ${on}`
    case 'svg':
      return `Swap the ${op.label.toLowerCase().startsWith('icon') ? 'icon' : 'logo'} in ${op.label} for ${op.name} on the ${on}`
    case 'replace':
      return `Replace “${cut(op.find, 30)}” with “${cut(op.replace, 30)}” ${op.scope === 'site' ? 'across the site' : `on the ${on}`}`
    case 'theme':
      return `Change the site’s ${op.name} from ${cut(op.before, 24)} to ${cut(op.after, 24)}`
    case 'palette': {
      const drop = op.drop.length
      const set = Object.keys(op.set).filter((k) => !op.drop.includes(k)).length
      if (drop + set === 1) return drop ? `Swap the colour ${op.drop[0]} for ${op.map[op.drop[0]] ?? 'the nearest kept'} across the site` : `Change the colour ${Object.keys(op.set)[0]} to ${Object.values(op.set)[0]} across the site`
      return `Tidy the site’s colours: ${[drop ? `${drop} taken out` : '', set ? `${set} changed` : ''].filter(Boolean).join(', ')}`
    }
    case 'fonts':
      return `Swap ${op.swaps.map((x) => `${x.from} for ${x.to}${Math.abs(x.scale - 1) >= 0.005 ? ` (at ${Math.round(x.scale * 100)}%)` : ''}`).join(', ')} across the site`
    case 'ask':
      return `${cut(op.prompt, 70)} (${what(op)} on the ${on})`
  }
}

/** A commit title for a set of edits: the edit itself when there's one, else a count by kind. */
export function commitTitle(siteName: string, notes: string[]): string {
  if (notes.length === 1) return cut(notes[0], 72)
  const words = notes.map((n) => n.split(' ')[0].toLowerCase())
  const kinds = [...new Set(words)].slice(0, 3)
  return cut(`Studio edits on ${siteName}: ${kinds.join(', ')} (${notes.length} changes)`, 72)
}

/**
 * A YouTube, Vimeo or Google Maps link (as copied from the address bar or a
 * share button), as the address to embed. Null when it isn't one of those.
 */
export function embedOf(raw: string): { src: string; provider: StudioEmbedProvider; title: string } | null {
  const s = raw.trim()
  // pasted embed code: take its address
  const fromCode = s.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]
  let u: URL
  try {
    u = new URL(fromCode ?? s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.replace(/^www\.|^m\./, '')
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') ?? u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1]
    if (!id || !/^[\w-]{6,20}$/.test(id)) return null
    const t = u.searchParams.get('t') ?? u.searchParams.get('start')
    const start = t ? Number(String(t).replace(/s$/, '')) : 0
    return { src: `https://www.youtube-nocookie.com/embed/${id}${start > 0 ? `?start=${Math.round(start)}` : ''}`, provider: 'youtube', title: 'YouTube video' }
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.match(/(?:video\/)?(\d{5,})/)?.[1]
    if (!id) return null
    const hash = u.pathname.match(/\d{5,}\/([0-9a-f]{6,})/)?.[1] ?? u.searchParams.get('h')
    return { src: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`, provider: 'vimeo', title: 'Vimeo video' }
  }
  if ((host === 'google.com' || host === 'google.co.uk' || host === 'maps.google.com' || host === 'maps.app.goo.gl') && (u.pathname.startsWith('/maps') || host.startsWith('maps.'))) {
    if (u.pathname.startsWith('/maps/embed')) return { src: u.href, provider: 'maps', title: 'Map' }
    // a place or search link: the free embed takes a search query
    const place = decodeURIComponent(u.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/)?.[1] ?? u.searchParams.get('q') ?? '').replace(/\+/g, ' ')
    if (!place) return null
    return { src: `https://www.google.com/maps?q=${encodeURIComponent(place)}&output=embed`, provider: 'maps', title: `Map of ${place}` }
  }
  return null
}

/** the words a page shows for "everywhere" and "find" matches: spaces squashed */
export const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
