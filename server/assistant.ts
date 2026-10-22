import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import type { Project } from '../src/data/types.ts'
import { DATA_DIR } from './util.ts'

// The Claude bar: runs your own Claude Code (`claude -p`) in the selected
// project's folder and streams what it says and does back to the dashboard as
// NDJSON. Claude may read freely; anything that edits files or runs commands
// is refused by Claude Code and comes back as an "ask", which the dashboard
// turns into an Allow button. Allowing re-runs the same session with exactly
// those actions permitted.

/** Read-only tools Claude can always use. Everything else needs an Allow. */
const READ_ONLY = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git branch:*)', 'Bash(git show:*)']
const RUN_LIMIT_MS = 15 * 60_000
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Ask {
  /** permission rule, e.g. "Edit" or "Bash(npm run build)" */
  rule: string
  /** what Claude wanted to do, in plain words */
  what: string
}

export type ClaudeEvent =
  | { type: 'start'; session: string | null; folder: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; text: string }
  | { type: 'done'; session: string | null; asks: Ask[] }
  | { type: 'error'; text: string }

// --- Finding the claude command -------------------------------------------------------

let found: { at: number; path: string | null } | null = null

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null)
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      // on Windows prefer the real exe, then the npm .cmd shim
      resolve(lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0] ?? null)
    })
  })
}

function candidates(): string[] {
  const home = os.homedir()
  if (process.platform !== 'win32') return [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd'), path.join(home, '.claude', 'local', 'claude.exe')]
}

/** Where `claude` lives on this computer, or null. `override` comes from Settings. */
export async function findClaude(override?: string): Promise<string | null> {
  if (override && fs.existsSync(override)) return override
  if (found && Date.now() - found.at < 60_000) return found.path
  const hit = (await which('claude')) ?? candidates().find((c) => fs.existsSync(c)) ?? null
  found = { at: Date.now(), path: hit }
  return hit
}

// --- Context for Claude ----------------------------------------------------------------------

function brief(p: Project) {
  const open = p.pulls.filter((x) => x.state === 'open')
  return [
    `- ${p.name} (${p.repo}): ${p.status}, ${p.reason}`,
    p.url ? `  live: ${p.url}` : '',
    open.length ? `  open PRs: ${open.map((x) => `#${x.number} ${x.title} [checks ${x.checks}]`).join('; ')}` : '',
    p.issues.length ? `  open issues: ${p.issues.slice(0, 6).map((x) => `#${x.number} ${x.title}`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function contextFor(projects: Project[], site: Project | null, folder: string | null) {
  const lines = [
    "You're the assistant inside Dylan's Blueprint dashboard for his web studio, Aspect Ratio Digital. It shows his sites, pulled live from GitHub.",
    'Reply in plain, friendly sentences and keep it short: the reply appears in a small panel. No headings or tables.',
    "If something you try is refused for permission, say in one line what you wanted to do and why. Dylan will see an Allow button for it.",
    '',
    'Current state of every project:',
    ...projects.map(brief),
  ]
  if (site) {
    lines.push('', `Dylan has ${site.name} (${site.repo}) open.`)
    lines.push(folder ? `You're working in its local folder: ${folder}` : `There's no local copy of ${site.repo} on this computer yet. You can still answer from the state above.`)
    const runs = site.runs.slice(0, 3).map((r) => `${r.name} on ${r.branch}: ${r.status} (${r.url})`)
    if (runs.length) lines.push(`Recent CI runs: ${runs.join('; ')}`)
  }
  return lines.join('\n')
}

// --- Running Claude Code ---------------------------------------------------------------------------

function quoteForCmd(arg: string) {
  if (/["%^&|<>!\r\n]/.test(arg)) throw new Error(`unsafe character in argument: ${arg}`)
  return /\s/.test(arg) ? `"${arg}"` : arg
}

function describe(tool: string, input: Record<string, unknown>): Ask {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (tool === 'Bash' && typeof input.command === 'string') return { rule: `Bash(${input.command})`, what: `Run \`${input.command}\`` }
  if (file && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return { rule: tool, what: `${tool === 'Write' ? 'Write' : 'Edit'} ${path.basename(file)}` }
  return { rule: tool, what: `Use ${tool}` }
}

function toolLine(name: string, input: Record<string, unknown>) {
  const f = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Read':
      return `Reading ${path.basename(f('file_path'))}`
    case 'Glob':
    case 'Grep':
      return `Searching for ${f('pattern')}`
    case 'Bash':
      return `Running ${f('command').slice(0, 80)}`
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Editing ${path.basename(f('file_path'))}`
    case 'WebFetch':
      return `Opening ${f('url')}`
    case 'WebSearch':
      return `Searching the web for ${f('query')}`
    default:
      return name
  }
}

export interface RunOptions {
  exe: string
  prompt: string
  projects: Project[]
  site: Project | null
  folder: string | null
  resume?: string
  allow?: string[]
  /** a model alias; unset uses whatever Claude Code is set to */
  model?: string
  effort?: string
}

const running = new Set<ChildProcess>()

export function stopAll() {
  for (const c of running) c.kill()
}

/** Run one Claude Code turn and stream ClaudeEvents to `res` as NDJSON. */
export function runClaude(o: RunOptions, res: ServerResponse) {
  const send = (e: ClaudeEvent) => res.write(JSON.stringify(e) + '\n')
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })

  const work = o.folder && fs.existsSync(o.folder) ? o.folder : path.join(DATA_DIR, 'claude-workspace')
  fs.mkdirSync(work, { recursive: true })
  const allow = [...READ_ONLY, ...(o.allow ?? []).filter((r) => typeof r === 'string' && r.length < 2000)]
  const settings = path.join(DATA_DIR, `claude-settings-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow } }))

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'default', '--settings', settings]
  if (o.resume && UUID.test(o.resume)) args.push('--resume', o.resume)
  if (o.model && (MODELS as readonly string[]).includes(o.model)) args.push('--model', o.model)
  if (o.effort && (EFFORTS as readonly string[]).includes(o.effort)) args.push('--effort', o.effort)
  const prompt = o.resume ? o.prompt : `${contextFor(o.projects, o.site, o.folder)}\n\nDylan asks: ${o.prompt}`

  const shim = /\.(cmd|bat)$/i.test(o.exe)
  let child: ChildProcess
  try {
    child = shim
      ? spawn([o.exe, ...args].map(quoteForCmd).join(' '), { cwd: work, shell: true, windowsHide: true })
      : spawn(o.exe, args, { cwd: work, windowsHide: true })
  } catch (e) {
    fs.rmSync(settings, { force: true })
    send({ type: 'error', text: (e as Error).message })
    return res.end()
  }
  running.add(child)
  child.stdin?.end(prompt)

  let session: string | null = o.resume ?? null
  let buf = ''
  let streamed = false
  let errText = ''
  let finished = false
  const asks: Ask[] = []
  send({ type: 'start', session, folder: o.folder && fs.existsSync(o.folder) ? o.folder : '' })

  const finish = (e?: ClaudeEvent) => {
    if (finished) return
    finished = true
    clearTimeout(limit)
    running.delete(child)
    fs.rmSync(settings, { force: true })
    if (e) send(e)
    send({ type: 'done', session, asks })
    res.end()
  }
  const limit = setTimeout(() => {
    child.kill()
    finish({ type: 'error', text: 'Stopped after 15 minutes.' })
  }, RUN_LIMIT_MS)

  const line = (raw: string) => {
    if (!raw.trim()) return
    let d: Record<string, any>
    try {
      d = JSON.parse(raw)
    } catch {
      return
    }
    if (d.session_id) session = d.session_id
    if (d.type === 'stream_event' && d.event?.type === 'content_block_delta' && d.event.delta?.type === 'text_delta') {
      streamed = true
      send({ type: 'text', text: d.event.delta.text })
    } else if (d.type === 'stream_event' && d.event?.type === 'message_start') {
      streamed = false
    } else if (d.type === 'assistant') {
      for (const c of d.message?.content ?? []) {
        if (c.type === 'tool_use') send({ type: 'tool', text: toolLine(c.name, c.input ?? {}) })
        else if (c.type === 'text' && !streamed && c.text) send({ type: 'text', text: c.text })
      }
    } else if (d.type === 'result') {
      for (const den of d.permission_denials ?? []) {
        const a = describe(den.tool_name, den.tool_input ?? {})
        if (!asks.some((x) => x.rule === a.rule)) asks.push(a)
      }
      if (d.is_error && d.result) errText = String(d.result)
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      line(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => (errText = (errText + chunk.toString('utf8')).slice(-2000)))
  child.on('error', (e) => finish({ type: 'error', text: e.message }))
  child.on('close', (code) => {
    line(buf)
    if (code && code !== 0) finish({ type: 'error', text: friendly(errText) || `Claude Code stopped (exit ${code}).` })
    else finish()
  })
  res.on('close', () => {
    if (!finished) child.kill()
  })
}

function friendly(err: string) {
  if (/log ?in|authenticat|\/login|not logged/i.test(err)) return 'Claude Code needs you to sign in once: open a terminal, run claude, and follow the sign-in steps. Then ask again.'
  return err.trim().split('\n').slice(-3).join(' ').slice(0, 400)
}

/**
 * One short, tool-free answer from Claude Code, as plain text: used to describe
 * a push in plain English. Resolves to null if Claude Code isn't there or fails.
 */
export function ask(exe: string, prompt: string, model = 'haiku'): Promise<string | null> {
  const work = path.join(DATA_DIR, 'claude-workspace')
  fs.mkdirSync(work, { recursive: true })
  const args = ['-p', '--output-format', 'text', '--model', model, '--no-session-persistence', '--permission-mode', 'default']
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = /\.(cmd|bat)$/i.test(exe)
        ? spawn([exe, ...args].map(quoteForCmd).join(' '), { cwd: work, shell: true, windowsHide: true })
        : spawn(exe, args, { cwd: work, windowsHide: true })
    } catch {
      return resolve(null)
    }
    running.add(child)
    let out = ''
    const done = (v: string | null) => {
      clearTimeout(limit)
      running.delete(child)
      resolve(v)
    }
    const limit = setTimeout(() => {
      child.kill()
      done(null)
    }, 90_000)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 && out.trim() ? out.trim() : null))
    child.stdin?.end(prompt)
  })
}
