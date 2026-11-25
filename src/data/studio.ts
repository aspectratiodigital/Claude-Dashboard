import type { StudioOp } from './types'

// Plain-words descriptions of Studio edits, shared by the change list in
// Studio and the commit message when you push live.

const cut = (s: string, n = 40) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const META_NAME = { title: 'Google title', description: 'Google description', 'og:title': 'social share title', 'og:description': 'social share description', 'og:image': 'social share image' } as const

const where = (page: string) => (page === '/' ? 'home page' : page)

export function opNote(op: StudioOp): string {
  const on = where(op.page)
  switch (op.kind) {
    case 'text':
      return `Change “${cut(op.before)}” to “${cut(op.after)}” on the ${on}`
    case 'image':
      return `Swap the photo in ${op.label} on the ${on}`
    case 'add-image':
      return `Add a photo after ${op.label} on the ${on}`
    case 'alt':
      return `Set the alt text of a photo on the ${on} to “${cut(op.after)}”`
    case 'link':
      return `Point ${op.text ? `“${cut(op.text, 30)}”` : op.label} at ${cut(op.after, 50)} on the ${on}`
    case 'move': {
      const bits = [op.dx ? `${Math.abs(op.dx)}px ${op.dx > 0 ? 'right' : 'left'}` : '', op.dy ? `${Math.abs(op.dy)}px ${op.dy > 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(' and ')
      return `Move ${op.text ? `“${cut(op.text, 30)}”` : op.label} ${bits || 'back into place'} on the ${on} (${op.width}px wide)`
    }
    case 'order':
      return `Move ${op.text ? `“${cut(op.text, 30)}”` : op.label} ${op.direction === 'earlier' ? 'before' : 'after'} ${cut(op.sibling, 40)} on the ${on}`
    case 'duplicate':
      return `Duplicate ${op.text ? `“${cut(op.text, 30)}”` : op.label} on the ${on}`
    case 'hide':
      return `${op.scope === 'everywhere' ? 'Remove' : `Hide at ${op.width}px wide`} ${op.text ? `“${cut(op.text, 30)}”` : op.label} on the ${on}`
    case 'meta':
      return op.field === 'og:image' ? `Set the social share image of the ${on}` : `Set the ${META_NAME[op.field]} of the ${on} to “${cut(op.after, 50)}”`
  }
}

/** A commit title for a set of edits: the edit itself when there's one, else a count by kind. */
export function commitTitle(siteName: string, notes: string[]): string {
  if (notes.length === 1) return cut(notes[0], 72)
  const words = notes.map((n) => n.split(' ')[0].toLowerCase())
  const kinds = [...new Set(words)].slice(0, 3)
  return cut(`Studio edits on ${siteName}: ${kinds.join(', ')} (${notes.length} changes)`, 72)
}
