import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, log, readJson, writeJson, writeJsonNow } from './util.ts'
import { loadSettings, type ProjectOverride } from './config.ts'

// Claude conversations and shared preferences, kept on this computer and,
// when a sync folder is set (say inside OneDrive), in that folder too, so
// every computer pointed at it sees the same threads, theme and site links.
//
// Each conversation is its own file in the sync folder, so two computers
// writing different threads never overwrite each other; for the same thread
// the newest `updated` wins. A deleted thread leaves a small tombstone so the
// other computer drops it too.

export interface StoredConversation {
  id: string
  updated: number
  deleted?: boolean
  [k: string]: unknown
}

export interface Prefs {
  theme?: string
  font?: string
  cars?: boolean
  model?: string
  effort?: string
  permission?: string
  at: number
}

interface Shared {
  prefs?: Prefs
  projects?: Record<string, ProjectOverride>
}

const LOCAL_FILE = path.join(DATA_DIR, 'conversations.json')
const KEEP = 300

/** The sync folder from Settings, if it's set and reachable. */
export function syncDir(): string | null {
  const dir = loadSettings().syncDir
  if (!dir) return null
  try {
    fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** Where OneDrive lives on this computer, for the "Use OneDrive" button. */
export function oneDriveSuggestion(): string | null {
  const root = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial
  return root ? path.join(root, 'ARD Blueprint') : null
}

export const host = () => os.hostname()

// --- Conversations ------------------------------------------------------------------------

let local: Record<string, StoredConversation> | null = null
const loadLocal = () => (local ??= readJson<Record<string, StoredConversation>>(LOCAL_FILE, {}))

function saveLocal() {
  const keep = Object.values(loadLocal())
    .sort((a, b) => b.updated - a.updated)
    .slice(0, KEEP)
  local = Object.fromEntries(keep.map((x) => [x.id, x]))
  writeJson(LOCAL_FILE, local, 300)
}

const fileFor = (dir: string, id: string) => path.join(dir, 'conversations', `${id}.json`)

// sync-folder files, re-read only when they change
const seen = new Map<string, { mtime: number; conv: StoredConversation | null }>()

function readSynced(dir: string): StoredConversation[] {
  const folder = path.join(dir, 'conversations')
  let names: string[] = []
  try {
    names = fs.readdirSync(folder).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: StoredConversation[] = []
  for (const n of names) {
    const file = path.join(folder, n)
    try {
      const mtime = fs.statSync(file).mtimeMs
      let hit = seen.get(file)
      if (!hit || hit.mtime !== mtime) {
        hit = { mtime, conv: readJson<StoredConversation | null>(file, null) }
        seen.set(file, hit)
      }
      if (hit.conv && typeof hit.conv.id === 'string') out.push(hit.conv)
    } catch {
      /* a file mid-sync; next time */
    }
  }
  return out
}

/** Every conversation this computer knows about, newest copy of each, deleted ones left out. */
export function listConversations(): StoredConversation[] {
  const all = loadLocal()
  const dir = syncDir()
  let changed = false
  if (dir) {
    for (const c of readSynced(dir)) {
      const mine = all[c.id]
      if (!mine || c.updated > mine.updated) {
        all[c.id] = c
        changed = true
      }
    }
  }
  if (changed) saveLocal()
  return Object.values(loadLocal()).filter((c) => !c.deleted)
}

export function saveConversation(c: StoredConversation) {
  loadLocal()[c.id] = c
  saveLocal()
  const dir = syncDir()
  if (!dir) return
  try {
    const file = fileFor(dir, c.id)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(c))
    fs.renameSync(tmp, file)
  } catch (e) {
    log('could not write to the sync folder', (e as Error).message)
  }
}

export function deleteConversation(id: string) {
  saveConversation({ id, updated: Date.now(), deleted: true })
}

/** Copy this computer's conversations and site links into a newly chosen sync folder. */
export function seedSyncFolder() {
  const dir = syncDir()
  if (!dir) return
  const mine = loadSettings().projects
  if (mine && !loadShared().projects) saveSharedProjects(mine)
  const there = new Map(readSynced(dir).map((c) => [c.id, c.updated]))
  for (const c of Object.values(loadLocal())) {
    if ((there.get(c.id) ?? -1) >= c.updated) continue
    try {
      fs.writeFileSync(fileFor(dir, c.id), JSON.stringify(c))
    } catch {
      /* ignore */
    }
  }
}

// --- Shared preferences and site links -----------------------------------------------------------

const sharedFile = (dir: string) => path.join(dir, 'shared.json')

export function loadShared(): Shared {
  const dir = syncDir()
  return dir ? readJson<Shared>(sharedFile(dir), {}) : {}
}

function saveShared(patch: Shared) {
  const dir = syncDir()
  if (!dir) return
  writeJsonNow(sharedFile(dir), { ...loadShared(), ...patch })
}

export function savePrefs(prefs: Prefs) {
  const cur = loadShared().prefs
  if (cur && cur.at >= prefs.at) return
  saveShared({ prefs })
}

export function saveSharedProjects(projects: Record<string, ProjectOverride>) {
  const cur = loadShared().projects ?? {}
  const next = { ...cur }
  for (const [k, { folder: _, ...v }] of Object.entries(projects)) next[k] = { ...next[k], ...v }
  saveShared({ projects: next })
}

// --- The Mini theme's map (one for the demo projects, one for yours) ------------------------------

type MiniMaps = Record<string, { at: number; edited?: boolean }>

const MINI_FILE = path.join(DATA_DIR, 'mini-map.json')
const miniIn = (dir: string) => path.join(dir, 'mini-map.json')

/** A map you've changed beats one the app laid out by itself; then the newest wins. */
const beats = (a: MiniMaps[string] | undefined, b: MiniMaps[string] | undefined) => !!a && (!b || (!!a.edited && !b.edited) || (!!a.edited === !!b.edited && a.at > b.at))

/** This computer's maps, swapped for the sync folder's wherever that copy is newer. */
export function loadMini(): MiniMaps {
  const mine = readJson<MiniMaps>(MINI_FILE, {})
  const dir = syncDir()
  if (!dir) return mine
  for (const [world, m] of Object.entries(readJson<MiniMaps>(miniIn(dir), {}))) if (beats(m, mine[world])) mine[world] = m
  return mine
}

export function saveMini(world: string, map: MiniMaps[string]) {
  const mine = readJson<MiniMaps>(MINI_FILE, {})
  if (beats(map, mine[world])) writeJsonNow(MINI_FILE, { ...mine, [world]: map })
  const dir = syncDir()
  if (!dir) return
  const there = readJson<MiniMaps>(miniIn(dir), {})
  if (beats(map, there[world])) writeJsonNow(miniIn(dir), { ...there, [world]: map })
}
