import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import type { Project } from '../src/data/types.ts'
import { DATA_DIR } from './util.ts'
import { storeBrief } from './shopify.ts'

// The Claude bar: runs your own Claude Code (`claude -p`) in the selected
// project's folder and streams what it says and does back to the dashboard as
// NDJSON. How much it may do without asking is the permission mode picked in
// the dashboard: Auto (Claude Code's own auto mode, the same as Claude on the
// web: it gets on with edits and commands and only stops for risky ones), Ask
// first, Allow edits or Allow everything. Anything refused comes back as an
// "ask", which the dashboard turns into an Allow button. Allowing re-runs the
// same session with exactly those actions permitted.

/** Read-only tools Claude can always use. Everything else needs an Allow. */
const READ_ONLY = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git branch:*)', 'Bash(git show:*)']
const RUN_LIMIT_MS = 15 * 60_000
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
/** the dashboard's permission choices, as Claude Code's --permission-mode values */
export const PERMISSIONS = { auto: 'auto', ask: 'default', edits: 'acceptEdits', all: 'bypassPermissions' } as const
export type Permission = keyof typeof PERMISSIONS
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Ask {
  /** permission rule, e.g. "Edit" or "Bash(npm run build)" */
  rule: string
  /** what Claude wanted to do, in plain words */
  what: string
}

/** one line of Claude's own task list (its TodoWrite / TaskCreate tools) */
export interface Task {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** how it reads while it's being done, e.g. "Running the tests" */
  active?: string
}

export type ClaudeEvent =
  | { type: 'start'; session: string | null; folder: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; text: string }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'file'; path: string; name: string; action: 'created' | 'edited' }
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
    `  repo: https://github.com/${p.repo}`,
    open.length ? `  open PRs: ${open.map((x) => `[#${x.number} ${x.title}](${x.url}) [checks ${x.checks}]`).join('; ')}` : '',
    p.issues.length ? `  open issues: ${p.issues.slice(0, 6).map((x) => `[#${x.number} ${x.title}](${x.url})`).join('; ')}` : '',
    p.store ? `  ${storeBrief(p.store)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function githubNote(github: RunOptions['github']) {
  const lines = [
    '',
    "Working on Dylan's repos: you can do everything Claude on the web can. Edit, build and test in the project's folder, and use git to commit, branch and push (pushes use this computer's git sign-in).",
  ]
  if (github?.token) {
    lines.push(
      github.cli
        ? 'GitHub: the gh CLI is installed and GH_TOKEN is set, so use gh for pull requests, issues, reviews, Actions runs and their logs (e.g. `gh run view <id> --log-failed`, `gh pr create`).'
        : 'GitHub: GH_TOKEN is set in your environment, but the gh CLI isn\'t installed, so use the REST API with curl: `curl -sL -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/OWNER/REPO/...` (a failed job\'s log is at `/actions/jobs/JOB_ID/logs`, its runs at `/actions/runs`). If Dylan would like it simpler, he can install the CLI with `winget install GitHub.cli`.',
      "If GitHub refuses a change with 403, the token is read-only: tell Dylan to open Settings, click **create a read-and-write token** under Your projects, and paste the new one in (or run `gh auth login` if the GitHub CLI is installed).",
    )
  } else lines.push("GitHub: there's no GitHub token on this computer, so you can't reach GitHub's API (pull requests, Actions logs). Tell Dylan to connect GitHub in Settings.")
  lines.push(
    'For code changes, work like Claude on the web: make a branch named after the change, commit with a clear message, push, and open a pull request with a title that says what changed. Give Dylan the link and merge only when he says so. Never push straight to the default branch unless he asks.',
  )
  return lines
}

function contextFor(projects: Project[], site: Project | null, folder: string | null, github?: RunOptions['github']) {
  const lines = [
    "You're the assistant inside Dylan's Blueprint dashboard for his web studio, Aspect Ratio Digital. It shows his sites, pulled live from GitHub.",
    '',
    'How to write replies (they are shown as Markdown):',
    '- Lead with the answer or the result in one or two plain sentences. Dylan skims, so the first line should be what he needs to know or do.',
    '- Then break the detail up: a bullet list for several items, a short `###` heading per subject when a reply covers more than one, and a blank line between paragraphs. Never one long block of text.',
    "- Keep paragraphs to two or three sentences and bullets to one line where you can. Use **bold** for the few words that matter most (a site's name, a status, a number).",
    '- Link what you mention: pull requests, issues, commits, files on GitHub, live pages and docs, as Markdown links with readable text, e.g. [#12 Fix the footer](https://github.com/owner/repo/pull/12). The links for each project are below.',
    '- When Dylan needs to decide or do something, end with a short **Your call** (or **Next step**) section: one bullet per option or action, your recommendation first.',
    '- Use a table only to compare things side by side, and code blocks only for code or commands. Write in plain English, no jargon he would have to look up.',
    '',
    'End every reply with one last line on its own, exactly one of these, which the dashboard reads to sort the thread and hides from Dylan:',
    '[[status: waiting]] when you need Dylan: a question, a decision, an Allow, or something he has to do.',
    '[[status: idle]] when your turn is done and nothing is needed from him, but the work may carry on.',
    "[[status: resolved]] when what he asked for is finished and there's nothing left to do in this thread.",
    '',
    "When Dylan asks for a file (a document, image, export or code), write it into the working folder and mention its name: the dashboard shows each file you write with Open and Download buttons.",
    "For work with three or more steps, start by setting out the plan with your task tool (TaskCreate, or TodoWrite) and mark each task in progress and done as you go: the dashboard shows it to Dylan as a checklist while you work. Anything you say between steps shows as a one-line status that's replaced by the next, so keep it to one short line, and save the detail for your final reply.",
    "If something you try is refused for permission, say in one line what you wanted to do and why. Dylan will see an Allow button for it.",
    ...githubNote(github),
    '',
    'Current state of every project:',
    ...projects.map(brief),
  ]
  if (site) {
    lines.push('', `Dylan has ${site.name} (${site.repo}) open.`)
    lines.push(
      folder
        ? `You're working in its local folder: ${folder}`
        : `There's no local copy of ${site.repo} on this computer yet. You can answer from the state above, and if the work needs its code, clone it into your working folder (\`git clone https://github.com/${site.repo}.git\`) and work in that: the dashboard uses that copy from then on.`,
    )
    const runs = site.runs.slice(0, 3).map((r) => `${r.name} on ${r.branch}: ${r.status} (${r.url})`)
    if (runs.length) lines.push(`Recent CI runs: ${runs.join('; ')}`)
    if (site.store && site.store.headless && site.store.headless !== 'Liquid theme')
      lines.push(`The site is a headless Shopify storefront (${site.store.headless}) on ${site.store.domain}. Products, carts and checkout come from the Shopify Storefront API, so keep that wiring intact, and check Shopify's docs (or the Shopify Dev MCP if it's installed) before changing API calls.`)
  }
  return lines.join('\n')
}

// --- Running Claude Code ---------------------------------------------------------------------------

export function quoteForCmd(arg: string) {
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

const modeCache = new Map<string, Promise<string>>()

/** The help text of this Claude Code, to see which permission modes it knows (auto came in 2026). */
function helpOf(exe: string): Promise<string> {
  let hit = modeCache.get(exe)
  if (!hit) {
    hit = new Promise((resolve) => {
      const shim = /\.(cmd|bat)$/i.test(exe)
      const done = (_e: unknown, out: string | Buffer) => resolve(String(out ?? ''))
      if (shim) execFile('cmd.exe', ['/d', '/s', '/c', `${quoteForCmd(exe)} --help`], { timeout: 15_000, windowsHide: true }, done)
      else execFile(exe, ['--help'], { timeout: 15_000, windowsHide: true }, done)
    })
    modeCache.set(exe, hit)
  }
  return hit
}

/** Claude Code's --permission-mode for a choice; Auto falls back to Allow edits on a Claude Code too old to have it. */
let autoBroken = false

export async function permissionMode(exe: string, p: string | undefined): Promise<string> {
  const choice: Permission = p && p in PERMISSIONS ? (p as Permission) : 'auto'
  if (choice !== 'auto') return PERMISSIONS[choice]
  return !autoBroken && /["']auto["']/.test(await helpOf(exe)) ? 'auto' : 'acceptEdits'
}

export interface RunOptions {
  exe: string
  /** Claude Code's --permission-mode, from permissionMode() */
  mode: string
  /** set when this is a second go in a safer mode, on the same response */
  again?: boolean
  prompt: string
  projects: Project[]
  site: Project | null
  folder: string | null
  resume?: string
  allow?: string[]
  /** a model alias; unset uses whatever Claude Code is set to */
  model?: string
  effort?: string
  /** the conversation so far, when its Claude Code session lives on another computer */
  history?: string
  /** files attached to this message (already checked to be uploads) */
  files?: string[]
  /** project instructions and knowledge folders */
  knowledge?: { text: string; dirs: string[] }
  /** the dashboard's GitHub token, handed to Claude so it can use GitHub like Claude on the web */
  github?: { token: string | null; cli: boolean }
}

/**
 * Claude's environment: the dashboard's GitHub token as GH_TOKEN (which the gh
 * CLI and curl calls use) and as a last-resort git sign-in, so pushes work even
 * where git has no saved login. A saved one (Git Credential Manager) still wins.
 */
function envFor(token: string | null | undefined): NodeJS.ProcessEnv {
  if (!token) return process.env
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
  }
}

const running = new Set<ChildProcess>()

export function stopAll() {
  for (const c of running) c.kill()
}

/** Run one Claude Code turn and stream ClaudeEvents to `res` as NDJSON. */
export function runClaude(o: RunOptions, res: ServerResponse) {
  const send = (e: ClaudeEvent) => res.write(JSON.stringify(e) + '\n')
  if (!o.again) res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })

  const work = o.folder && fs.existsSync(o.folder) ? o.folder : path.join(DATA_DIR, 'claude-workspace')
  fs.mkdirSync(work, { recursive: true })
  const allow = [...READ_ONLY, ...(o.allow ?? []).filter((r) => typeof r === 'string' && r.length < 2000)]
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const settings = path.join(DATA_DIR, `claude-settings-${stamp}.json`)
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow } }))
  // the dashboard's context goes in as a system prompt, so the message itself stays
  // exactly what Dylan typed (which is what lets /skills and /commands work)
  const earlier = !o.resume && o.history ? `\n\nEarlier in this conversation (on Dylan's other computer, so you can't see it in your own history):\n${o.history}` : ''
  const know = o.knowledge?.text ? `\n\n${o.knowledge.text}` : ''
  const system = path.join(DATA_DIR, `claude-context-${stamp}.md`)
  fs.writeFileSync(system, `${contextFor(o.projects, o.site, o.folder, o.github)}${know}${earlier}`)

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', o.mode, '--settings', settings, '--append-system-prompt-file', system]
  const extra = [...new Set([...(o.files ?? []).map((f) => path.dirname(path.dirname(f))), ...(o.knowledge?.dirs ?? [])])].filter((d) => fs.existsSync(d))
  if (extra.length) args.push('--add-dir', ...extra)
  if (o.resume && UUID.test(o.resume)) args.push('--resume', o.resume)
  if (o.model && (MODELS as readonly string[]).includes(o.model)) args.push('--model', o.model)
  if (o.effort && (EFFORTS as readonly string[]).includes(o.effort)) args.push('--effort', o.effort)
  const attached = o.files?.length ? `\n\nAttached files (read them with the Read tool):\n${o.files.map((f) => `- ${f}`).join('\n')}` : ''
  const prompt = `${o.prompt}${attached}`
  const cleanup = () => {
    fs.rmSync(settings, { force: true })
    fs.rmSync(system, { force: true })
  }

  const shim = /\.(cmd|bat)$/i.test(o.exe)
  let child: ChildProcess
  try {
    child = shim
      ? spawn([o.exe, ...args].map(quoteForCmd).join(' '), { cwd: work, shell: true, windowsHide: true, env: envFor(o.github?.token) })
      : spawn(o.exe, args, { cwd: work, windowsHide: true, env: envFor(o.github?.token) })
  } catch (e) {
    cleanup()
    send({ type: 'error', text: (e as Error).message })
    return res.end()
  }
  running.add(child)
  child.stdin?.end(prompt)

  let session: string | null = o.resume ?? null
  let buf = ''
  let streamed = false
  /** text already sent, so a later message's text starts on a new paragraph rather than running on */
  let wrote = false
  let gap = false
  const text = (t: string) => {
    if (!t) return
    if (gap && wrote) send({ type: 'text', text: '\n\n' })
    gap = false
    wrote = true
    send({ type: 'text', text: t })
  }
  let errText = ''
  let finished = false
  const asks: Ask[] = []
  /** file-writing tool calls waiting for their result: tool_use id -> file */
  const writes = new Map<string, { file: string; action: 'created' | 'edited' }>()
  const sent = new Set<string>()
  /** Claude's task list as it plans and works: shown as a checklist while it runs */
  let tasks: (Task & { id: string })[] = []
  const sendTasks = () => send({ type: 'tasks', tasks: tasks.map(({ text, status, active }) => ({ text, status, active })) })
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const statusOf = (v: unknown): Task['status'] => (v === 'in_progress' || v === 'completed' ? v : 'pending')
  if (!o.again) send({ type: 'start', session, folder: o.folder && fs.existsSync(o.folder) ? o.folder : '' })

  const finish = (e?: ClaudeEvent) => {
    if (finished) return
    finished = true
    clearTimeout(limit)
    running.delete(child)
    cleanup()
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
      text(d.event.delta.text)
    } else if (d.type === 'stream_event' && d.event?.type === 'message_start') {
      streamed = false
      gap = true
    } else if (d.type === 'stream_event' && d.event?.type === 'content_block_start' && d.event.content_block?.type === 'text') {
      gap = true
    } else if (d.type === 'assistant') {
      for (const c of d.message?.content ?? []) {
        if (c.type === 'tool_use' && c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
          tasks = c.input.todos.flatMap((t: Record<string, unknown>, i: number) => (str(t.content) ? [{ id: String(i), text: str(t.content)!, status: statusOf(t.status), active: str(t.activeForm) }] : []))
          sendTasks()
        } else if (c.type === 'tool_use' && c.name === 'TaskCreate' && str(c.input?.subject)) {
          // its number comes back in the tool's result; until then it goes by the call's id
          tasks.push({ id: c.id, text: str(c.input.subject)!, status: 'pending', active: str(c.input.activeForm) })
          sendTasks()
        } else if (c.type === 'tool_use' && c.name === 'TaskUpdate') {
          const t = tasks.find((x) => x.id === String(c.input?.taskId ?? ''))
          if (t && c.input.status === 'deleted') tasks = tasks.filter((x) => x !== t)
          else if (t) {
            if (c.input.status) t.status = statusOf(c.input.status)
            t.text = str(c.input.subject) ?? t.text
            t.active = str(c.input.activeForm) ?? t.active
          }
          if (t) sendTasks()
        } else if (c.type === 'tool_use' && /^Task(List|Get)$/.test(c.name)) {
          // reading its own list: nothing to show
        } else if (c.type === 'tool_use') {
          send({ type: 'tool', text: toolLine(c.name, c.input ?? {}) })
          const file = c.input?.file_path ?? c.input?.notebook_path
          if (typeof file === 'string' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) writes.set(c.id, { file: path.resolve(work, file), action: c.name === 'Write' && !fs.existsSync(path.resolve(work, file)) ? 'created' : 'edited' })
        }
        else if (c.type === 'text' && !streamed && c.text) {
          gap = true
          text(c.text)
        }
      }
    } else if (d.type === 'user') {
      // a file Claude wrote or edited: offer it to open or download
      for (const c of d.message?.content ?? []) {
        const made = c.type === 'tool_result' ? tasks.find((t) => t.id === c.tool_use_id) : undefined
        if (made) {
          const said = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? '').join(' ') : ''
          const n = /#?(\d+)/.exec(said)?.[1]
          if (n) made.id = n
        }
        const w = c.type === 'tool_result' && !c.is_error ? writes.get(c.tool_use_id) : undefined
        if (!w || sent.has(w.file)) continue
        sent.add(w.file)
        send({ type: 'file', path: w.file, name: path.basename(w.file), action: w.action })
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
    // auto mode isn't available on every plan or version: go again with Allow edits, which still asks before commands
    if (code && o.mode === 'auto' && !wrote && !finished && /auto/i.test(errText)) {
      finished = true
      clearTimeout(limit)
      running.delete(child)
      cleanup()
      autoBroken = true
      return runClaude({ ...o, mode: 'acceptEdits', again: true }, res)
    }
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

/** A two-to-five word title for a new thread, from its first message and reply, like "Shopify order alerts". */
export async function titleFor(exe: string, prompt: string, reply: string): Promise<string | null> {
  const words = await ask(
    exe,
    `Name this conversation for a list of threads: two to five plain words saying what it is about, in sentence case, no quotes, no full stop, no verb like "fix" or "add" at the start. Answer with the title only.\n\nDylan asked:\n${prompt.slice(0, 1500)}\n\nClaude answered:\n${reply.slice(0, 1500)}`,
  )
  const t = words?.split('\n')[0].replace(/^["'*#\s]+|["'*.\s]+$/g, '').trim()
  return t && t.length <= 60 ? t : null
}
