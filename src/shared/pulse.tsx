import { useEffect, useMemo, useState } from 'react'
import { useThree } from '@react-three/fiber'
import type { Note, NoteKind, NoteLevel } from '../data/types'
import { onNote } from '../data/store'
import { KindIcon } from './icons'

// Notification visuals shared by every concept. Scenes keep a map of the latest
// event per project (stamped with scene time) and read it in useFrame to play
// their own effect; DOM layers show a short-lived chip next to the project.

export interface Impulse {
  at: number
  kind: NoteKind
  level: NoteLevel
}
export type Impulses = Map<string, Impulse>

/** Inside a <Canvas>: latest notification per project, in scene time. */
export function useImpulses(onAny?: (n: Note, at: number) => void) {
  const map = useMemo<Impulses>(() => new Map(), [])
  const clock = useThree((s) => s.clock)
  useEffect(
    () =>
      onNote((n) => {
        map.set(n.projectId, { at: clock.elapsedTime, kind: n.kind, level: n.level })
        onAny?.(n, clock.elapsedTime)
      }),
    [map, clock, onAny],
  )
  return map
}

/** Seconds since this project's last event, or Infinity. */
export function since(map: Impulses, id: string, t: number) {
  const i = map.get(id)
  return i ? t - i.at : Infinity
}

/** Outside the canvas: the newest notification for a project, cleared after `ms`. */
export function useFreshNote(projectId: string | null, ms = 7000) {
  const [note, setNote] = useState<Note | null>(null)
  useEffect(() => {
    if (!projectId) return
    let timer = 0
    const off = onNote((n) => {
      if (n.projectId !== projectId) return
      setNote(n)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setNote(null), ms)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [projectId, ms])
  return note
}

/** Small chip that pops up beside a project when something happens to it. */
export function NoteChip({ projectId, className = '' }: { projectId: string; className?: string }) {
  const note = useFreshNote(projectId)
  if (!note) return null
  return (
    <div key={note.id} className={`note-chip ${className}`} data-level={note.level}>
      <KindIcon kind={note.kind} size={13} />
      <span>{note.title}</span>
    </div>
  )
}
