import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, ROOT, log, readJson, slug } from './util.ts'
import { scanLocalSessions, type LocalSession } from './claude.ts'
import { listConversations, syncDir } from './sync.ts'

// Earlier conversations for each site's Claude chat, from two places:
//
// - Project exports. claude.ai has no API for project threads, but Claude in a
//   project can read all of them, so the "Export threads to Blueprint" skill
//   writes them to a file (format below) in .jarvis/project-threads/. The file
//   names the project's repos, which is how its threads find their sites.
// - Claude Code sessions run on this computer (Remote Control, the terminal),
//   read back from their transcripts in ~/.claude/projects. Sessions the app's
//   own Claude bar started are left out, since those are already threads here.
//
// Both are read-only here. Writing in one starts a thread in the app that
// carries the conversation over as context.

export const EXPORT_FORMAT = 'ard-blueprint-threads'

export type HistoryState = 'working' | 'waiting' | 'idle' | 'resolved'

export interface HistoryMessage {
  role: 'user' | 'claude'
  text: string
  at?: string
  author?: string
  /** what Claude said between steps, for local sessions */
  steps?: string[]
  /** links and files the message carried (PRs, documents) */
  links?: { title: string; url?: string }[]
}

export interface HistoryThread {
  /** p:<project>:<thread> or l:<session> */
  id: string
  kind: 'project' | 'local'
  title: string
  state: HistoryState
  updated: string
  created?: string
  messages: number
  /** opens it in Claude */
  url?: string
  /** the claude.ai project's name, or the folder a local session ran in */
  from: string
}

export interface ExportInfo {
  id: string
  name: string
  url?: string
  exportedAt: string
  threads: number
  open: number
  repos: string[]
  /** dashboard projects (sites) its threads show under */
  sites: string[]
}

interface ExportThread {
  id: string
  title: string
  state?: string
  resolved?: boolean
  created?: string
  updated?: string
  url?: string
  messages: HistoryMessage[]
}

interface ProjectExport {
  format: string
  version: number
  exportedAt: string
  project: { id: string; name: string; url?: string; repos?: string[] }
  threads: ExportThread[]
}

interface Site {
  id: string
  name: string
  repo: string
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const iso = (v: unknown) => {
  const s = str(v, 40)
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined
}

/** owner/repo, lowercased, from a GitHub URL or an owner/repo string */
export function repoKey(r: string) {
  const m = r.trim().match(/(?:github\.com[:/])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

// A status card or widget in a project thread is JSON, not something anyone said.
function cleanBody(text: string) {
  const t = text.trim()
  if (t.startsWith('{"kind"')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && typeof j.kind === 'string') return ''
    } catch {
      /* ordinary text that starts with a brace */
    }
  }
  return text
}

function stateOf(t: { state?: string; resolved?: boolean }): HistoryState {
  if (t.resolved) return 'resolved'
  if (t.state === 'working') return 'working'
  if (t.state === 'blocked' || t.state === 'review_ready') return 'waiting'
  return 'idle'
}

/** Check an export (from the skill, or a file you picked) and keep only what the app shows. */
export function parseExport(raw: unknown): ProjectExport | null {
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Record<string, unknown>
  const p = x.project as Record<string, unknown> | undefined
  if (x.format !== EXPORT_FORMAT || !p || typeof p.id !== 'string' || !Array.isArray(x.threads)) return null
  const threads: ExportThread[] = []
  for (const t of x.threads as Record<string, unknown>[]) {
    if (!t || typeof t.id !== 'string' || !Array.isArray(t.messages)) continue
    const messages: HistoryMessage[] = []
    for (const m of t.messages as Record<string, unknown>[]) {
      if (!m || typeof m.text !== 'string') continue
      const text = cleanBody(m.text).slice(0, 40_000)
      const links = Array.isArray(m.links)
        ? (m.links as Record<string, unknown>[]).filter((l) => l && typeof l.title === 'string').slice(0, 20).map((l) => ({ title: str(l.title)!, url: str(l.url, 2000)?.match(/^https:\/\//) ? str(l.url, 2000) : undefined }))
        : undefined
      if (!text.trim() && !links?.length) continue
      messages.push({ role: m.role === 'user' ? 'user' : 'claude', text, at: iso(m.at), author: str(m.author, 80), links: links?.length ? links : undefined })
    }
    threads.push({
      id: t.id.slice(0, 120),
      title: str(t.title) || 'Untitled thread',
      state: str(t.state, 20),
      resolved: t.resolved === true,
      created: iso(t.created),
      updated: iso(t.updated) ?? messages.at(-1)?.at,
      url: str(t.url, 2000)?.match(/^https:\/\//) ? str(t.url, 2000) : undefined,
      messages,
    })
  }
  return {
    format: EXPORT_FORMAT,
    version: Number(x.version) || 1,
    exportedAt: iso(x.exportedAt) ?? new Date().toISOString(),
    project: {
      id: p.id.slice(0, 120),
      name: str(p.name) || 'Claude project',
      url: str(p.url, 2000)?.match(/^https:\/\//) ? str(p.url, 2000) : undefined,
      repos: Array.isArray(p.repos) ? (p.repos as unknown[]).filter((r): r is string => typeof r === 'string').slice(0, 30) : [],
    },
    threads,
  }
}

// --- Where exports live ---------------------------------------------------------------------

const SUB = 'project-threads'

/**
 * Folders an export may be in: this app's data folder, the repo's .jarvis
 * folder (where the skill writes on your PC, even for the installed app), and
 * the sync folder, so the other computer gets them too.
 */
function exportDirs(): string[] {
  const dirs = [path.join(DATA_DIR, SUB), path.join(ROOT, '.jarvis', SUB)]
  const info = readJson<{ sourceDir?: string }>(path.join(ROOT, 'dist-electron', 'build-info.json'), {})
  if (info.sourceDir) dirs.push(path.join(info.sourceDir, '.jarvis', SUB))
  const sync = syncDir()
  if (sync) dirs.push(path.join(sync, SUB))
  return [...new Set(dirs.map((d) => path.resolve(d)))]
}

const fileCache = new Map<string, { key: string; x: ProjectExport | null }>()

/** The newest export of each project, with the file it came from. */
function loadExports(): { x: ProjectExport; file: string }[] {
  const best = new Map<string, { x: ProjectExport; file: string }>()
  for (const dir of exportDirs()) {
    let names: string[]
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const n of names) {
      const file = path.join(dir, n)
      let x: ProjectExport | null = null
      try {
        const st = fs.statSync(file)
        const key = `${st.mtimeMs}:${st.size}`
        const hit = fileCache.get(file)
        if (hit?.key === key) x = hit.x
        else {
          x = parseExport(JSON.parse(fs.readFileSync(file, 'utf8')))
          fileCache.set(file, { key, x })
        }
      } catch {
        x = null
      }
      if (!x) continue
      const have = best.get(x.project.id)
      if (!have || x.exportedAt > have.x.exportedAt) best.set(x.project.id, { x, file })
    }
  }
  mirror([...best.values()])
  return [...best.values()]
}

const fileName = (x: ProjectExport) => `${slug(x.project.name) || 'project'}-${slug(x.project.id).slice(-10)}.json`

/** Copy the newest exports into the sync folder, so your other computer shows them too. */
function mirror(list: { x: ProjectExport; file: string }[]) {
  const sync = syncDir()
  if (!sync) return
  const dir = path.resolve(path.join(sync, SUB))
  for (const { x, file } of list) {
    if (path.dirname(path.resolve(file)) === dir) continue
    const to = path.join(dir, fileName(x))
    try {
      const there = fs.existsSync(to) ? parseExport(JSON.parse(fs.readFileSync(to, 'utf8'))) : null
      if (there && there.exportedAt >= x.exportedAt) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(file, to)
    } catch (e) {
      log('could not copy a thread export to the sync folder', (e as Error).message)
    }
  }
}

/** Save an export you picked in Settings. */
export function importExport(raw: unknown): ExportInfo | { error: string } {
  const x = parseExport(raw)
  if (!x) return { error: 'That isn’t a Blueprint thread export. In the Claude project, say “export threads to Blueprint”.' }
  const dir = path.join(DATA_DIR, SUB)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName(x)), JSON.stringify(x))
  return infoOf(x, [])
}

/** Forget a project's export, here and in the sync folder. */
export function removeExport(id: string) {
  for (const dir of exportDirs())
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []) {
      const file = path.join(dir, n)
      try {
        const x = parseExport(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (x?.project.id === id) fs.rmSync(file)
      } catch {
        /* not ours */
      }
    }
}

// --- Which site a project belongs to ------------------------------------------------------------

/** The sites an export's threads show under: by its repos, else by its name. */
function sitesFor(x: ProjectExport, sites: Site[]): Site[] {
  const repos = new Set((x.project.repos ?? []).map(repoKey).filter((r): r is string => !!r))
  const byRepo = sites.filter((s) => repos.has(s.repo.toLowerCase()))
  if (byRepo.length) return byRepo
  const name = slug(x.project.name)
  return sites.filter((s) => slug(s.name) === name || slug(s.repo.split('/')[1] ?? '') === name)
}

function infoOf(x: ProjectExport, sites: Site[]): ExportInfo {
  return {
    id: x.project.id,
    name: x.project.name,
    url: x.project.url,
    exportedAt: x.exportedAt,
    threads: x.threads.length,
    open: x.threads.filter((t) => !t.resolved).length,
    repos: (x.project.repos ?? []).map((r) => repoKey(r) ?? r),
    sites: sitesFor(x, sites).map((s) => s.name),
  }
}

export function listExports(sites: Site[]): ExportInfo[] {
  return loadExports()
    .map(({ x }) => infoOf(x, sites))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- Local Claude Code sessions --------------------------------------------------------------

/** sessions the app's own Claude bar started: they're threads already */
function appSessions() {
  return new Set(listConversations().map((c) => (typeof c.session === 'string' ? c.session : '')).filter(Boolean))
}

function localFor(site: Site): LocalSession[] {
  const own = appSessions()
  const key = site.repo.toLowerCase()
  const name = slug(site.repo.split('/')[1] ?? site.name)
  return scanLocalSessions(3650).filter((s) => !own.has(s.id) && (s.repo ? s.repo === key : slug(s.folder) === name))
}

const textBlocks = (content: unknown): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text').map((c) => String((c as { text?: string }).text ?? ''))
      : []

/** A local session's conversation: what you asked, and what Claude said back (its working notes folded into steps). */
function readSession(file: string): HistoryMessage[] {
  const out: HistoryMessage[] = []
  let said: string[] = []
  let at: string | undefined
  const flush = () => {
    const parts = said.map((t) => t.trim()).filter(Boolean)
    if (parts.length) out.push({ role: 'claude', text: parts.at(-1)!.slice(0, 40_000), steps: parts.length > 1 ? parts.slice(0, -1).map((t) => t.slice(0, 4000)) : undefined, at })
    said = []
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain || d.isMeta) continue
    const content = (d.message as { content?: unknown } | undefined)?.content
    if (d.type === 'user') {
      const text = textBlocks(content).join('\n').trim()
      // tool results, slash-command echoes and interruptions aren't something you wrote
      if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) continue
      flush()
      out.push({ role: 'user', text: text.slice(0, 40_000), at: iso(d.timestamp) })
    } else if (d.type === 'assistant') {
      said.push(...textBlocks(content))
      at = iso(d.timestamp) ?? at
    }
  }
  flush()
  return out.slice(-600)
}

const counts = new Map<string, { key: string; n: number }>()
function countOf(s: LocalSession) {
  const key = s.updated
  const hit = counts.get(s.file)
  if (hit?.key === key) return hit.n
  let n = 0
  try {
    const m = readSession(s.file)
    // a session with nothing you wrote in it (a one-off `claude -p`, say) isn't a conversation
    n = m.some((x) => x.role === 'user') ? m.length : 0
  } catch {
    /* unreadable */
  }
  counts.set(s.file, { key, n })
  return n
}

// --- What the app asks for ------------------------------------------------------------------------

/** Earlier threads for one site (or, for "All projects", exports that match no site). */
export function historyFor(siteId: string | null, sites: Site[]): HistoryThread[] {
  const site = sites.find((s) => s.id === siteId) ?? null
  const out: HistoryThread[] = []
  for (const { x } of loadExports()) {
    const mine = sitesFor(x, sites)
    if (site ? !mine.some((s) => s.id === site.id) : mine.length) continue
    for (const t of x.threads)
      out.push({
        id: `p:${x.project.id}:${t.id}`,
        kind: 'project',
        title: t.title,
        state: stateOf(t),
        updated: t.updated ?? x.exportedAt,
        created: t.created,
        messages: t.messages.length,
        url: t.url ?? x.project.url,
        from: x.project.name,
      })
  }
  if (site)
    for (const s of localFor(site)) {
      const n = countOf(s)
      if (!n) continue
      out.push({ id: `l:${s.id}`, kind: 'local', title: s.title, state: 'idle', updated: s.updated, created: s.started, messages: n, from: s.folder })
    }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

/** One earlier thread's messages. */
export function historyThread(id: string): HistoryMessage[] | null {
  if (id.startsWith('l:')) {
    const s = scanLocalSessions(3650).find((x) => x.id === id.slice(2))
    return s ? readSession(s.file) : null
  }
  const m = id.match(/^p:(.+?):([^:]+)$/)
  if (!m) return null
  const x = loadExports().find((e) => e.x.project.id === m[1])?.x
  return x?.threads.find((t) => t.id === m[2])?.messages ?? null
}
