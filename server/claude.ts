import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Claude Code keeps a transcript of every local session under
// ~/.claude/projects/<folder>/<session>.jsonl. We read only the title, folder,
// branch and timestamps (never the conversation itself leaves your machine),
// then match each session to a repo through the folder's git remote.

export interface LocalSession {
  id: string
  title: string
  cwd: string
  branch: string | null
  started: string
  updated: string
  /** "owner/repo", lowercased, from the folder's git remote */
  repo: string | null
  folder: string
}

const cache = new Map<string, { key: string; s: LocalSession | null }>()
const remotes = new Map<string, string | null>()

function claudeDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

function readSlice(file: string, start: number, len: number) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: string }).text) : '')).join(' ')
  return ''
}

function repoFor(cwd: string): string | null {
  if (remotes.has(cwd)) return remotes.get(cwd)!
  let dir = cwd
  let found: string | null = null
  for (let i = 0; i < 5 && dir; i++) {
    const cfg = path.join(dir, '.git', 'config')
    if (fs.existsSync(cfg)) {
      const txt = fs.readFileSync(cfg, 'utf8')
      const m = txt.match(/url\s*=\s*\S*github\.com[:/]([^/\s]+)\/([^\s]+?)(?:\.git)?\s*$/m)
      if (m) found = `${m[1]}/${m[2]}`.toLowerCase()
      break
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  remotes.set(cwd, found)
  return found
}

function parse(file: string, stat: fs.Stats): LocalSession | null {
  const head = readSlice(file, 0, Math.min(stat.size, 512 * 1024))
  const tail = stat.size > 512 * 1024 ? readSlice(file, stat.size - 96 * 1024, 96 * 1024) : ''
  let title = ''
  let custom = ''
  let cwd = ''
  let branch: string | null = null
  let started = ''
  let prompt = ''
  for (const chunk of [head, tail]) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('{')) continue
      let d: Record<string, unknown>
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') title = d.aiTitle
      else if (d.type === 'custom-title' && typeof d.customTitle === 'string') custom = d.customTitle
      else if (d.type === 'summary' && typeof d.summary === 'string' && !title) title = d.summary
      else if (d.type === 'user' && !d.isMeta && !d.isSidechain) {
        if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
        if (!branch && typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch
        if (!started && typeof d.timestamp === 'string') started = d.timestamp
        if (!prompt) {
          const t = textOf((d.message as { content?: unknown })?.content).trim()
          if (t && !t.startsWith('<')) prompt = t
        }
      }
    }
  }
  if (!cwd) return null
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  const name = clean(custom || title || prompt).slice(0, 90) || 'Claude Code session'
  return {
    id: path.basename(file, '.jsonl'),
    title: name,
    cwd,
    branch,
    started: started || stat.birthtime.toISOString(),
    updated: stat.mtime.toISOString(),
    repo: repoFor(cwd),
    folder: path.basename(cwd),
  }
}

/** Sessions touched in the last three weeks, newest first. */
export function scanLocalSessions(days = 21): LocalSession[] {
  const root = claudeDir()
  if (!fs.existsSync(root)) return []
  const out: LocalSession[] = []
  const cutoff = Date.now() - days * 86_400_000
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir)
    let files: string[]
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const file = path.join(full, f)
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (stat.mtimeMs < cutoff) continue
      const key = `${stat.mtimeMs}:${stat.size}`
      const hit = cache.get(file)
      let s = hit?.key === key ? hit.s : null
      if (hit?.key !== key) {
        try {
          s = parse(file, stat)
        } catch {
          s = null
        }
        cache.set(file, { key, s })
      }
      if (s) out.push(s)
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}
