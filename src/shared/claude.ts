import { create } from 'zustand'
import { getProject, useData } from '../data/store'
import { STATUS_LABEL } from '../data/derive'
import { FONTS, useApp, type Font, type Theme } from '../store'

// Claude inside the dashboard. With the local API running and Claude Code
// installed, each message runs your own Claude Code in the project's folder
// (server/assistant.ts) and streams back what it says and does. Edits and
// commands come back as "asks" with Allow buttons. Without Claude Code (or in
// demo mode) it falls back to short canned answers from the dashboard data.
//
// Conversations ("threads") live in one store, so the notes panel, a
// building's Claude panel and the fullscreen workspace all see the same
// history, and several threads can run at once. The local API keeps them on
// disk, and each one resumes its Claude Code session, so they carry on after
// the app is closed and reopened.

export interface Ask {
  rule: string
  what: string
}

/** a file attached to a message (saved by the local API under uploads) */
export interface Attachment {
  id: string
  name: string
  /** where it's saved on the computer that uploaded it */
  path: string
  size: number
  type: string
}

/** a file Claude wrote or edited while answering */
export interface MadeFile {
  path: string
  name: string
  action: 'created' | 'edited'
}

export interface ClaudeTask {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** how it reads while it's being done, e.g. "Running the tests" */
  active?: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'claude'
  text: string
  streaming?: boolean
  /** what Claude is doing right now, as one line, e.g. "Reading index.html" */
  doing?: string
  /** what Claude said between steps while it worked, folded away under the reply */
  steps?: string[]
  /** Claude's plan while it works, shown as a checklist until it's done */
  tasks?: ClaudeTask[]
  /** actions Claude wants permission for */
  asks?: Ask[]
  answered?: 'allowed' | 'declined'
  error?: boolean
  attachments?: Attachment[]
  files?: MadeFile[]
  /** links a message from a Claude project carried (its PR, documents) */
  links?: { title: string; url?: string }[]
  /** who wrote it, when it came from a Claude project */
  author?: string
}

/** Where an earlier thread came from: a Claude project's export, or a Claude Code session on this computer. */
export interface Origin {
  kind: 'project' | 'local'
  /** the history id the local API knows it by */
  id: string
  /** the project's name, or the folder the session ran in */
  from: string
  state: ThreadState
  url?: string
}

export interface Conversation {
  id: string
  /** null: about all projects */
  projectId: string | null
  title: string
  messages: ChatMessage[]
  speaking: boolean
  /** Claude Code session to resume */
  session?: string
  /** the computer that session lives on; elsewhere the conversation is handed over as text */
  sessionHost?: string
  allowed: string[]
  created: number
  updated: number
  /** where Claude left it, from the status line at the end of its last reply (or you resolving it) */
  status?: 'waiting' | 'idle' | 'resolved'
  /** named by Claude, so the first message's text no longer stands in for a title */
  titled?: boolean
  /** an earlier thread, shown read-only: writing in it carries it on in a new thread */
  origin?: Origin
  /** carried on from an earlier thread: the first message hands Claude the conversation so far */
  handover?: boolean
}

export type ThreadState = 'working' | 'waiting' | 'idle' | 'resolved'

export const THREAD_STATES: { id: ThreadState; label: string }[] = [
  { id: 'working', label: 'Working' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'idle', label: 'Idle' },
  { id: 'resolved', label: 'Resolved' },
]

/** Where a thread stands: Claude is answering, needs you (a question, an Allow, an error), is done for now, or the work is finished. */
export function threadState(c: Conversation): ThreadState {
  if (c.speaking) return 'working'
  const last = [...c.messages].reverse().find((m) => m.role === 'claude')
  if (last?.asks?.length && !last.answered) return 'waiting'
  if (last?.error) return 'waiting'
  return c.status ?? 'idle'
}

// The status line Claude ends each reply with (server/assistant.ts asks for it). It is read, then hidden.
/** The first line of what Claude said, as plain text, for the working line. */
const oneLine = (t: string) =>
  (t.split('\n').find((l) => l.trim()) ?? '')
    .replace(/[*_`#>[\]]/g, '')
    .replace(/^\s*([-+]|\d+\.)\s+/, '')
    .trim()

/** what a reply says when it's only asking for an Allow; once answered, the whole message goes */
export const ASK_TEXT = 'I need your OK for this:'

/**
 * Claude moved on to a step: what it said before it ("Let me check the build")
 * becomes the one working line and is folded away, rather than piling up in the
 * reply, so only the answer stays.
 */
const stepped = (m: ChatMessage, doing: string | undefined): Partial<ChatMessage> => {
  const said = cleanReply(m.text).trim()
  return said ? { text: '', steps: [...(m.steps ?? []), said], doing: oneLine(said) || doing } : { doing }
}

const STATUS_LINE = /\s*\[\[\s*status:\s*(waiting|idle|resolved)\s*\]\]\s*$/i
/** A reply without its status line (and, while it's still arriving, without a half-written one). */
export const cleanReply = (text: string, streaming = false) => {
  const t = text.replace(STATUS_LINE, '')
  return streaming ? t.replace(/\s*\[\[[^\]\n]{0,24}\]?$/, '') : t
}

export type ClaudeLink = 'checking' | 'live' | 'missing' | 'offline'

export const MODELS = [
  { id: '', label: 'Default', note: 'Whatever Claude Code is set to' },
  { id: 'fable', label: 'Fable', note: 'Most capable' },
  { id: 'opus', label: 'Opus', note: 'Deep work' },
  { id: 'sonnet', label: 'Sonnet', note: 'Fast and capable' },
  { id: 'haiku', label: 'Haiku', note: 'Quickest' },
] as const
export const PERMISSIONS = [
  { id: 'auto', label: 'Auto', note: 'Like Claude on the web: gets on with edits and commands, and only asks before anything risky' },
  { id: 'ask', label: 'Ask first', note: 'Asks before every edit or command' },
  { id: 'edits', label: 'Allow edits', note: 'Edits files without asking, asks before commands' },
  { id: 'all', label: 'Allow everything', note: 'Never asks. Only for projects you trust it with completely' },
] as const
export const EFFORTS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
] as const

interface ClaudeState {
  convs: Conversation[]
  /** the conversation each project ("" = all projects) last had open */
  current: Record<string, string>
  link: ClaudeLink
  model: string
  effort: string
  /** how much Claude may do without asking (see PERMISSIONS) */
  permission: string
  /** the fullscreen workspace, and which project it's showing ("" = all) */
  full: boolean
  fullProject: string
  setModel: (m: string) => void
  setEffort: (e: string) => void
  setPermission: (p: string) => void
  openFull: (projectId?: string | null) => void
  closeFull: () => void
  setFullProject: (id: string) => void
  /** the open conversation for a project, starting one if there's none */
  ensure: (projectId: string | null) => string
  /** start a new conversation for a project and make it current */
  start: (projectId: string | null) => string
  pick: (convId: string) => void
  /** forget a conversation (here and on disk) */
  remove: (convId: string) => void
  send: (convId: string, text: string, attachments?: Attachment[]) => void
  /** ask again for the last reply */
  retry: (convId: string) => void
  answer: (convId: string, msgId: number, ok: boolean) => void
  stop: (convId: string) => void
  /** mark a thread finished, or open it again */
  resolve: (convId: string, done: boolean) => void
}

function load(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* storage unavailable */
  }
}

let nextId = 1
let nextConv = 1
const aborts = new Map<string, AbortController>()
const timers = new Map<string, number>()

const keyOf = (projectId: string | null) => projectId ?? ''

function partOfDay() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

function greeting(projectId: string | null): ChatMessage {
  const p = getProject(projectId)
  return {
    id: nextId++,
    role: 'claude',
    text: p ? `What would you like to do on ${p.name}? I can look at the code, explain what's changed, or make changes for you.` : `Good ${partOfDay()}, Dylan. Ask me anything about your sites, or pick a project and ask me to work on it.`,
  }
}

const MISSING =
  "I'm not connected yet: Claude Code isn't installed on this computer. Open PowerShell, run npm.cmd install -g @anthropic-ai/claude-code, then run claude.cmd once to sign in. Then close and reopen the dashboard."

function compose(prompt: string, siteId: string | null): string {
  const p = prompt.toLowerCase()
  const all = useData.getState().projects
  const site = getProject(siteId)
  const broken = all.filter((x) => x.status === 'broken')
  const busy = all.filter((x) => x.status === 'building' || x.status === 'deploying')
  if (/(status|how.*(doing|going)|overview|summary)/.test(p)) {
    return `${all.length} projects: ${all.filter((x) => x.status === 'live').length} live, ${busy.length} building or deploying. ${
      broken.length ? `${broken.map((x) => `${x.name} (${x.reason.toLowerCase()})`).join(', ')} needs a look.` : 'Nothing is broken.'
    } ${all.reduce((a, x) => a + x.pulls.filter((q) => q.state === 'open').length, 0)} pull requests are open.`
  }
  if (/(deploy|ship|release)/.test(p)) {
    return site
      ? `${site.name} deploys through ${site.host ?? 'its host'} from ${site.defaultBranch}. Last change: "${site.commits[0]?.message ?? 'none yet'}". Merging an open PR will trigger the next deploy.`
      : 'Pick a project and I will tell you what is waiting to ship.'
  }
  if (/(bug|fix|error|broken|fail)/.test(p)) {
    if (site) return site.status === 'broken' ? `${site.name}: ${site.reason}.` : `${site.name} looks healthy: ${site.reason.toLowerCase()}.`
    return broken.length ? `${broken.map((x) => `${x.name}: ${x.reason}`).join('. ')}.` : 'Nothing is failing right now.'
  }
  if (site) {
    return `${site.name} is ${STATUS_LABEL[site.status].toLowerCase()}: ${site.reason}. ${site.threads.length} Claude thread${site.threads.length === 1 ? '' : 's'}, ${site.commitsWeek} commits this week.`
  }
  return 'Ask me for a status check, what is failing, or pick a project to talk about it.'
}

/** this computer's name, from the local API */
let localHost = ''

let linkChecked = false
function checkLink() {
  if (linkChecked) return
  linkChecked = true
  fetch('./api/claude')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((r: { available: boolean; host?: string }) => {
      localHost = r.host ?? ''
      useClaude.setState({ link: r.available ? 'live' : 'missing' })
    })
    .catch(() => useClaude.setState({ link: 'offline' }))
}
// the link depends on the local API, which the data store finds first
useData.subscribe((s, prev) => {
  if (s.api && !prev.api) {
    checkLink()
    pull(true)
    window.setInterval(() => pull(false), 15_000)
  }
  if (s.mode === 'demo' && !s.api) useClaude.setState({ link: 'offline' })
})

export const useClaude = create<ClaudeState>((set, get) => {
  const patchConv = (id: string, f: (c: Conversation) => Partial<Conversation>) =>
    set((s) => ({ convs: s.convs.map((c) => (c.id === id ? { ...c, ...f(c), updated: Date.now() } : c)) }))
  const patchMsg = (convId: string, msgId: number, f: (m: ChatMessage) => Partial<ChatMessage>) =>
    patchConv(convId, (c) => ({ messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...f(m) } : m)) }))
  const conv = (id: string) => get().convs.find((c) => c.id === id)

  /** Canned fallback, streamed word by word. */
  const playback = (convId: string, replyId: number, reply: string) => {
    const words = reply.split(' ')
    let i = 0
    window.setTimeout(() => {
      const t = window.setInterval(() => {
        i++
        patchMsg(convId, replyId, () => ({ text: words.slice(0, i).join(' '), streaming: i < words.length }))
        if (i >= words.length) {
          window.clearInterval(t)
          timers.delete(convId)
          patchConv(convId, () => ({ speaking: false }))
        }
      }, 55)
      timers.set(convId, t)
    }, 420)
  }

  const run = async (convId: string, replyId: number, prompt: string, allow?: string[], files?: string[]) => {
    const c = conv(convId)
    if (!c) return
    const ctl = new AbortController()
    aborts.set(convId, ctl)
    const allowed = [...c.allowed, ...(allow ?? [])]
    // a session started on the other computer can't be resumed here: hand Claude the conversation instead
    const here = !c.handover && (!c.session || !c.sessionHost || !localHost || c.sessionHost === localHost)
    try {
      const res = await fetch('./api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          projectId: c.projectId,
          resume: here ? c.session : undefined,
          history: here ? undefined : transcript(c),
          allow: allowed,
          model: get().model || undefined,
          effort: get().effort || undefined,
          permission: get().permission,
          files: files?.length ? files : undefined,
        }),
        signal: ctl.signal,
      })
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!raw.trim()) continue
          const e = JSON.parse(raw)
          if (e.type === 'text')
            patchMsg(convId, replyId, (m) => {
              const t = m.text ? e.text : e.text.replace(/^\s+/, '')
              return t ? { text: m.text + t, doing: undefined } : {}
            })
          else if (e.type === 'tool') patchMsg(convId, replyId, (m) => stepped(m, e.text))
          else if (e.type === 'tasks')
            patchMsg(convId, replyId, (m) => {
              const now = (e.tasks as ClaudeTask[]).find((t) => t.status === 'in_progress')
              return { ...stepped(m, m.doing), tasks: e.tasks, ...(now && { doing: now.active || now.text }) }
            })
          else if (e.type === 'file') patchMsg(convId, replyId, (m) => ({ files: [...(m.files ?? []).filter((f) => f.path !== e.path), { path: e.path, name: e.name, action: e.action }] }))
          else if (e.type === 'error') patchMsg(convId, replyId, (m) => ({ text: m.text ? `${m.text}\n\n${e.text}` : e.text, error: true }))
          else if (e.type === 'done') {
            if (e.session) patchConv(convId, () => ({ session: e.session, sessionHost: localHost || undefined, allowed, handover: undefined }))
            const said = conv(convId)?.messages.find((m) => m.id === replyId)?.text ?? ''
            const status = (STATUS_LINE.exec(said)?.[1]?.toLowerCase() ?? 'idle') as Conversation['status']
            patchMsg(convId, replyId, (m) => {
              // the answer came before its last step: bring it back out
              const steps = m.steps ?? []
              const back = !cleanReply(m.text).trim() && !e.asks?.length && steps.length ? steps.at(-1)! : ''
              return { streaming: false, doing: undefined, tasks: undefined, asks: e.asks?.length ? e.asks : undefined, steps: back ? steps.slice(0, -1) : m.steps, text: cleanReply(back || m.text) || (e.asks?.length ? ASK_TEXT : 'Done.') }
            })
            patchConv(convId, () => ({ status: e.asks?.length ? 'waiting' : status }))
            name(convId)
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') patchMsg(convId, replyId, (m) => ({ text: m.text || `I couldn't reach Claude Code: ${(err as Error).message}`, error: true }))
    } finally {
      aborts.delete(convId)
      patchMsg(convId, replyId, (m) => ({ streaming: false, doing: undefined, tasks: undefined, text: cleanReply(m.text) }))
      patchConv(convId, () => ({ speaking: false }))
    }
  }

  /** Once a thread has its first reply, Claude names it in a few words. */
  const name = (convId: string) => {
    const c = conv(convId)
    if (!c || c.titled || get().link !== 'live') return
    const ask = c.messages.find((m) => m.role === 'user')
    const reply = c.messages.find((m, i) => m.role === 'claude' && i > c.messages.indexOf(ask!) && m.text)
    if (!ask || !reply) return
    patchConv(convId, () => ({ titled: true }))
    fetch('./api/claude/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: ask.text, reply: reply.text }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { title?: string } | null) => j?.title && patchConv(convId, () => ({ title: j.title! })))
      .catch(() => {})
  }

  return {
    convs: [],
    current: {},
    link: 'checking',
    model: load('ard.claude.model'),
    effort: load('ard.claude.effort'),
    permission: PERMISSIONS.some((x) => x.id === load('ard.claude.permission')) ? load('ard.claude.permission') : 'auto',
    full: false,
    fullProject: '',
    setModel: (model) => {
      save('ard.claude.model', model)
      set({ model })
      pushPrefs()
    },
    setEffort: (effort) => {
      save('ard.claude.effort', effort)
      set({ effort })
      pushPrefs()
    },
    setPermission: (permission) => {
      save('ard.claude.permission', permission)
      set({ permission })
      pushPrefs()
    },
    openFull: (projectId) => {
      const key = projectId === undefined ? '' : keyOf(projectId)
      get().ensure(key || null)
      set({ full: true, fullProject: key })
    },
    closeFull: () => set({ full: false }),
    setFullProject: (fullProject) => {
      get().ensure(fullProject || null)
      set({ fullProject })
    },
    ensure: (projectId) => {
      const key = keyOf(projectId)
      const cur = get().current[key]
      if (cur && conv(cur)) return cur
      const latest = get()
        .convs.filter((c) => keyOf(c.projectId) === key && !c.origin)
        .sort((a, b) => b.updated - a.updated)[0]
      if (latest) {
        set((s) => ({ current: { ...s.current, [key]: latest.id } }))
        return latest.id
      }
      return get().start(projectId)
    },
    start: (projectId) => {
      const id = `c${Date.now().toString(36)}${(nextConv++).toString(36)}`
      const now = Date.now()
      const c: Conversation = { id, projectId, title: 'New thread', messages: [greeting(projectId)], speaking: false, allowed: [], created: now, updated: now }
      set((s) => ({ convs: [...s.convs, c], current: { ...s.current, [keyOf(projectId)]: id } }))
      return id
    },
    remove: (convId) => {
      const c = conv(convId)
      if (!c) return
      get().stop(convId)
      const key = keyOf(c.projectId)
      set((s) => {
        const current = { ...s.current }
        if (current[key] === convId) delete current[key]
        return { convs: s.convs.filter((x) => x.id !== convId), current }
      })
      persist(c, true)
    },
    pick: (convId) => {
      const c = conv(convId)
      if (c) set((s) => ({ current: { ...s.current, [keyOf(c.projectId)]: convId } }))
    },
    send: (convId, prompt, attachments) => {
      const files = attachments?.length ? attachments : undefined
      const text = prompt.trim() || (files ? `Have a look at ${files.length === 1 ? files[0].name : 'these files'}.` : '')
      const c = conv(convId)
      if (!text || !c || c.speaking) return
      if (c.origin) {
        // an earlier thread stays as it was: carry it on in a new thread that starts with its conversation
        const id = get().start(c.projectId)
        patchConv(id, () => ({ title: c.title, titled: true, handover: true, messages: c.messages.map((m) => ({ ...m, id: nextId++ })) }))
        return get().send(id, text, files)
      }
      window.clearInterval(timers.get(convId))
      const userId = nextId++
      const replyId = nextId++
      const live = get().link === 'live'
      patchConv(convId, (x) => ({
        speaking: true,
        status: x.status === 'resolved' ? 'idle' : x.status,
        title: x.messages.some((m) => m.role === 'user') ? x.title : text.length > 60 ? `${text.slice(0, 57)}…` : text,
        messages: [
          ...x.messages.map((m) => ({ ...m, streaming: false })),
          { id: userId, role: 'user', text, attachments: files },
          { id: replyId, role: 'claude', text: '', streaming: true, doing: live ? 'Thinking' : undefined },
        ],
      }))
      if (live) run(convId, replyId, text, undefined, files?.map((f) => f.id))
      else playback(convId, replyId, get().link === 'missing' ? MISSING : compose(text, c.projectId))
    },
    retry: (convId) => {
      const c = conv(convId)
      if (!c || c.speaking) return
      let at = c.messages.length - 1
      while (at >= 0 && c.messages[at].role !== 'user') at--
      if (at < 0) return
      const ask = c.messages[at]
      patchConv(convId, (x) => ({ messages: x.messages.slice(0, at) }))
      get().send(convId, ask.text, ask.attachments)
    },
    answer: (convId, msgId, ok) => {
      const c = conv(convId)
      const msg = c?.messages.find((m) => m.id === msgId)
      if (!c || !msg?.asks || msg.answered || c.speaking) return
      patchMsg(convId, msgId, () => ({ answered: ok ? 'allowed' : 'declined' }))
      if (!ok) return
      const replyId = nextId++
      patchConv(convId, (x) => ({ speaking: true, messages: [...x.messages, { id: replyId, role: 'claude', text: '', streaming: true, doing: 'Carrying on' }] }))
      run(convId, replyId, 'You have permission now for what you asked. Carry on from where you stopped.', msg.asks.map((a) => a.rule))
    },
    resolve: (convId, done) => patchConv(convId, () => ({ status: done ? 'resolved' : 'idle' })),
    stop: (convId) => {
      aborts.get(convId)?.abort()
      const t = timers.get(convId)
      if (t) {
        window.clearInterval(t)
        timers.delete(convId)
        patchConv(convId, (x) => ({ speaking: false, messages: x.messages.map((m) => ({ ...m, streaming: false })) }))
      }
    },
  }
})

/** All conversations about one project ("" or null = all projects), newest first. */
export const convsFor = (convs: Conversation[], projectId: string | null) => convs.filter((c) => keyOf(c.projectId) === keyOf(projectId) && !c.origin).sort((a, b) => b.updated - a.updated)

/** Conversations someone actually wrote in (the greeting alone doesn't count). */
export const hasTalk = (c: Conversation) => c.messages.some((m) => m.role === 'user')

// --- Keeping conversations between launches ---------------------------------------------------

const saveTimers = new Map<string, number>()
const saved = new Map<string, number>()

/** Save one conversation through the local API (or delete it). */
function persist(c: Conversation, remove = false) {
  if (!useData.getState().api) return
  window.clearTimeout(saveTimers.get(c.id))
  saveTimers.delete(c.id)
  const conversation = { ...c, speaking: false, messages: c.messages.map((m) => ({ ...m, streaming: undefined, doing: undefined, tasks: undefined })) }
  fetch('./api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation, delete: remove || undefined }) }).catch(() => {})
}

/** The conversation so far as plain text, for Claude on a computer that doesn't have its session. */
function transcript(c: Conversation) {
  const msgs = c.messages.slice(0, -2) // leave out the new message and the reply being written
  const first = msgs.findIndex((m) => m.role === 'user')
  return msgs
    .slice(first < 0 ? msgs.length : first)
    .filter((m) => m.text.trim())
    .map((m) => `${m.author ?? (m.role === 'user' ? 'Dylan' : 'Claude')}: ${m.text.trim()}${m.links?.length ? ` [links: ${m.links.map((l) => (l.url ? `${l.title} (${l.url})` : l.title)).join(', ')}]` : ''}${m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.name).join(', ')}]` : ''}${m.files?.length ? ` [wrote: ${m.files.map((f) => f.path).join(', ')}]` : ''}`)
    .join('\n\n')
}

const tidy = (c: Conversation): Conversation => ({
  ...c,
  speaking: false,
  messages: c.messages.map((m) => (m.role === 'claude' && !m.text ? { ...m, text: '(Stopped when the app closed.)' } : { ...m, streaming: undefined, doing: undefined, tasks: undefined })),
})

/** ids the local API has told us about, so a thread deleted on the other computer can be dropped here */
const known = new Set<string>()
let pulling = false

/**
 * Bring in saved conversations and shared preferences: on launch, then every
 * 15 seconds, which is how threads from your other computer arrive.
 */
/** Check the sync folder now (Settings calls this after you pick one). */
export const syncNow = () => pull(true)

function pull(first: boolean) {
  if (pulling) return
  pulling = true
  fetch('./api/sync')
    .then((r) => (r.ok ? r.json() : null))
    .then((r: { conversations: Conversation[]; prefs: Prefs | null; host: string; syncing: boolean } | null) => {
      if (!r) return
      if (r.host) localHost ||= r.host
      if (r.prefs) applyPrefs(r.prefs)
      else if (r.syncing) pushPrefs() // a new sync folder starts with this computer's choices
      const list = (Array.isArray(r.conversations) ? r.conversations : []).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
      const s = useClaude.getState()
      const byId = new Map(s.convs.map((c) => [c.id, c]))
      const remote = new Set(list.map((c) => c.id))
      let convs = s.convs
      const current = { ...s.current }
      let changed = false
      for (const c of list) {
        for (const m of c.messages) nextId = Math.max(nextId, (Number(m.id) || 0) + 1)
        known.add(c.id)
        const mine = byId.get(c.id)
        if (mine && (mine.speaking || mine.updated >= c.updated)) continue
        saved.set(c.id, c.updated)
        convs = mine ? convs.map((x) => (x.id === c.id ? tidy(c) : x)) : [...convs, tidy(c)]
        changed = true
      }
      // deleted on the other computer
      const gone = convs.filter((c) => known.has(c.id) && !remote.has(c.id) && !c.speaking).map((c) => c.id)
      if (gone.length) {
        convs = convs.filter((c) => !gone.includes(c.id))
        for (const id of gone) known.delete(id)
        for (const [k, v] of Object.entries(current)) if (gone.includes(v)) delete current[k]
        changed = true
      }
      if (first) {
        // a project that only has an empty, just-opened thread switches to its latest saved one
        const empty = new Set(convs.filter((c) => !hasTalk(c)).map((c) => c.id))
        const drop = new Set<string>()
        for (const c of [...convs].filter((x) => remote.has(x.id)).sort((a, b) => a.updated - b.updated)) {
          const key = keyOf(c.projectId)
          if (!current[key] || empty.has(current[key])) {
            if (current[key]) drop.add(current[key])
            current[key] = c.id
            changed = true
          }
        }
        convs = convs.filter((c) => !drop.has(c.id))
      }
      if (changed) useClaude.setState({ convs, current })
    })
    .catch(() => {})
    .finally(() => (pulling = false))
}

// --- Shared preferences: theme, font, cars, model and effort follow you between computers -------------------

interface Prefs {
  theme?: string
  font?: string
  cars?: boolean
  model?: string
  effort?: string
  permission?: string
  at: number
}

let prefsAt = Number(load('ard.prefs.at')) || 0
let applying = false

function pushPrefs() {
  if (applying || !useData.getState().api) return
  prefsAt = Date.now()
  save('ard.prefs.at', String(prefsAt))
  const { model, effort, permission } = useClaude.getState()
  fetch('./api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: useApp.getState().theme, font: useApp.getState().font, cars: useApp.getState().cars, model, effort, permission, at: prefsAt }) }).catch(() => {})
}

function applyPrefs(p: Prefs) {
  if (!p.at || p.at <= prefsAt) return
  applying = true
  prefsAt = p.at
  save('ard.prefs.at', String(prefsAt))
  if (p.theme && ['blueprint', 'light', 'dark'].includes(p.theme)) useApp.getState().setTheme(p.theme as Theme)
  if (p.font && FONTS.some((f) => f.id === p.font)) useApp.getState().setFont(p.font as Font)
  if (typeof p.cars === 'boolean') useApp.getState().setCars(p.cars)
  if (typeof p.model === 'string' && MODELS.some((m) => m.id === p.model)) useClaude.getState().setModel(p.model)
  if (typeof p.effort === 'string' && EFFORTS.some((m) => m.id === p.effort)) useClaude.getState().setEffort(p.effort)
  if (typeof p.permission === 'string' && PERMISSIONS.some((m) => m.id === p.permission)) useClaude.getState().setPermission(p.permission)
  applying = false
}

useApp.subscribe((s, prev) => {
  if (s.theme !== prev.theme || s.font !== prev.font || s.cars !== prev.cars) pushPrefs()
})

// save a conversation a moment after it changes, once someone has written in it
useClaude.subscribe((s, prev) => {
  if (s.convs === prev.convs) return
  for (const c of s.convs) {
    if (!hasTalk(c) || c.origin || saved.get(c.id) === c.updated) continue
    saved.set(c.id, c.updated)
    window.clearTimeout(saveTimers.get(c.id))
    // while Claude is answering, save every few seconds rather than on every word
    saveTimers.set(c.id, window.setTimeout(() => persist(useClaude.getState().convs.find((x) => x.id === c.id) ?? c), c.speaking ? 3000 : 600))
  }
})

// --- Files ---------------------------------------------------------------------------------------

/** Save a file for the next message through the local API. */
export async function uploadFile(file: File): Promise<Attachment> {
  const r = await fetch(`./api/upload?name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`)
  return j as Attachment
}

export const fileUrl = (path: string, download = false) => `./api/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`

/** Open a file with its usual app (or show it in its folder). */
export async function openFile(path: string, reveal = false): Promise<string | null> {
  try {
    const r = await fetch('./api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, reveal }) })
    const j = await r.json().catch(() => ({}))
    return r.ok ? null : (j.error ?? 'Could not open it')
  } catch {
    return 'Could not reach the local API'
  }
}

// --- Earlier threads: from Claude projects, and Claude Code sessions on this computer ----------------

export interface HistoryThread {
  id: string
  kind: 'project' | 'local'
  title: string
  state: ThreadState
  updated: string
  created?: string
  messages: number
  url?: string
  from: string
}

interface HistoryMessage {
  role: 'user' | 'claude'
  text: string
  at?: string
  author?: string
  steps?: string[]
  links?: { title: string; url?: string }[]
}

interface HistoryState {
  /** earlier threads per project ("" = all projects), once asked for */
  lists: Record<string, { threads: HistoryThread[]; at: number }>
  opening: string
  error: string
  /** fetch a project's earlier threads (again, if it's been a while) */
  load: (projectId: string | null, force?: boolean) => void
  /** show an earlier thread in the chat */
  open: (projectId: string | null, t: HistoryThread) => Promise<void>
}

/** the conversation id an earlier thread shows under (per project, since one Claude project can cover several sites) */
export const historyConvId = (projectId: string | null, t: HistoryThread) => `h-${keyOf(projectId)}-${t.id.replace(/[^\w-]+/g, '_')}`

export const useHistory = create<HistoryState>((set, get) => ({
  lists: {},
  opening: '',
  error: '',
  load: (projectId, force) => {
    const key = keyOf(projectId)
    const have = get().lists[key]
    if (!useData.getState().api || (!force && have && Date.now() - have.at < 30_000)) return
    // mark it straight away so several panels asking at once only fetch it once
    set((s) => ({ lists: { ...s.lists, [key]: { threads: have?.threads ?? [], at: Date.now() } } }))
    fetch(`./api/history?project=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r: { threads: HistoryThread[] } | null) => r && set((s) => ({ lists: { ...s.lists, [key]: { threads: r.threads, at: Date.now() } } })))
      .catch(() => {})
  },
  open: async (projectId, t) => {
    const id = historyConvId(projectId, t)
    const key = keyOf(projectId)
    const s = useClaude.getState()
    if (s.convs.some((c) => c.id === id)) return void useClaude.setState((x) => ({ current: { ...x.current, [key]: id } }))
    set({ opening: t.id, error: '' })
    try {
      const r = await fetch(`./api/history/thread?id=${encodeURIComponent(t.id)}`)
      const j = (await r.json()) as { messages?: HistoryMessage[]; error?: string }
      if (!r.ok || !j.messages) throw new Error(j.error ?? `HTTP ${r.status}`)
      const at = (m: HistoryMessage) => (m.at ? Date.parse(m.at) : 0)
      const conv: Conversation = {
        id,
        projectId,
        title: t.title,
        messages: j.messages.map((m) => ({ id: nextId++, role: m.role, text: m.text, steps: m.steps, links: m.links, author: m.author })),
        speaking: false,
        allowed: [],
        created: (t.created ? Date.parse(t.created) : 0) || at(j.messages[0] ?? { role: 'user', text: '' }) || Date.parse(t.updated),
        updated: Date.parse(t.updated),
        titled: true,
        origin: { kind: t.kind, id: t.id, from: t.from, state: t.state, url: t.url },
      }
      useClaude.setState((x) => ({ convs: [...x.convs.filter((c) => c.id !== id), conv], current: { ...x.current, [key]: id } }))
      set({ opening: '' })
    } catch (e) {
      set({ opening: '', error: `Couldn’t open “${t.title}”: ${(e as Error).message}` })
    }
  },
}))
