import { create } from 'zustand'
import { getProject, useData } from '../data/store'
import { STATUS_LABEL } from '../data/derive'

// Claude inside the dashboard. With the local API running and Claude Code
// installed, each message runs your own Claude Code in the project's folder
// (server/assistant.ts) and streams back what it says and does. Edits and
// commands come back as "asks" with Allow buttons. Without Claude Code (or in
// demo mode) it falls back to short canned answers from the dashboard data.
//
// Conversations ("threads") live in one store for as long as the app is open,
// so the notes panel, a building's Claude panel and the fullscreen workspace
// all see the same history, and several threads can run at once.

export interface Ask {
  rule: string
  what: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'claude'
  text: string
  streaming?: boolean
  /** what Claude is doing right now, e.g. "Reading index.html" */
  doing?: string
  /** actions Claude wants permission for */
  asks?: Ask[]
  answered?: 'allowed' | 'declined'
  error?: boolean
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
  allowed: string[]
  created: number
  updated: number
}

export type ClaudeLink = 'checking' | 'live' | 'missing' | 'offline'

export const MODELS = [
  { id: '', label: 'Default', note: 'Whatever Claude Code is set to' },
  { id: 'fable', label: 'Fable', note: 'Most capable' },
  { id: 'opus', label: 'Opus', note: 'Deep work' },
  { id: 'sonnet', label: 'Sonnet', note: 'Fast and capable' },
  { id: 'haiku', label: 'Haiku', note: 'Quickest' },
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
  /** the fullscreen workspace, and which project it's showing ("" = all) */
  full: boolean
  fullProject: string
  setModel: (m: string) => void
  setEffort: (e: string) => void
  openFull: (projectId?: string | null) => void
  closeFull: () => void
  setFullProject: (id: string) => void
  /** the open conversation for a project, starting one if there's none */
  ensure: (projectId: string | null) => string
  /** start a new conversation for a project and make it current */
  start: (projectId: string | null) => string
  pick: (convId: string) => void
  send: (convId: string, text: string) => void
  answer: (convId: string, msgId: number, ok: boolean) => void
  stop: (convId: string) => void
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

let linkChecked = false
function checkLink() {
  if (linkChecked) return
  linkChecked = true
  fetch('./api/claude')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((r: { available: boolean }) => useClaude.setState({ link: r.available ? 'live' : 'missing' }))
    .catch(() => useClaude.setState({ link: 'offline' }))
}
// the link depends on the local API, which the data store finds first
useData.subscribe((s, prev) => {
  if (s.api && !prev.api) checkLink()
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

  const run = async (convId: string, replyId: number, prompt: string, allow?: string[]) => {
    const c = conv(convId)
    if (!c) return
    const ctl = new AbortController()
    aborts.set(convId, ctl)
    const allowed = [...c.allowed, ...(allow ?? [])]
    try {
      const res = await fetch('./api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, projectId: c.projectId, resume: c.session, allow: allowed, model: get().model || undefined, effort: get().effort || undefined }),
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
          if (e.type === 'text') patchMsg(convId, replyId, (m) => ({ text: m.text + e.text, doing: undefined }))
          else if (e.type === 'tool') patchMsg(convId, replyId, () => ({ doing: e.text }))
          else if (e.type === 'error') patchMsg(convId, replyId, (m) => ({ text: m.text ? `${m.text}\n\n${e.text}` : e.text, error: true }))
          else if (e.type === 'done') {
            if (e.session) patchConv(convId, () => ({ session: e.session, allowed }))
            patchMsg(convId, replyId, (m) => ({ streaming: false, doing: undefined, asks: e.asks?.length ? e.asks : undefined, text: m.text || (e.asks?.length ? 'I need your OK for this:' : 'Done.') }))
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') patchMsg(convId, replyId, (m) => ({ text: m.text || `I couldn't reach Claude Code: ${(err as Error).message}`, error: true }))
    } finally {
      aborts.delete(convId)
      patchMsg(convId, replyId, () => ({ streaming: false, doing: undefined }))
      patchConv(convId, () => ({ speaking: false }))
    }
  }

  return {
    convs: [],
    current: {},
    link: 'checking',
    model: load('ard.claude.model'),
    effort: load('ard.claude.effort'),
    full: false,
    fullProject: '',
    setModel: (model) => {
      save('ard.claude.model', model)
      set({ model })
    },
    setEffort: (effort) => {
      save('ard.claude.effort', effort)
      set({ effort })
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
        .convs.filter((c) => keyOf(c.projectId) === key)
        .sort((a, b) => b.updated - a.updated)[0]
      if (latest) {
        set((s) => ({ current: { ...s.current, [key]: latest.id } }))
        return latest.id
      }
      return get().start(projectId)
    },
    start: (projectId) => {
      const id = `c${nextConv++}`
      const now = Date.now()
      const c: Conversation = { id, projectId, title: 'New thread', messages: [greeting(projectId)], speaking: false, allowed: [], created: now, updated: now }
      set((s) => ({ convs: [...s.convs, c], current: { ...s.current, [keyOf(projectId)]: id } }))
      return id
    },
    pick: (convId) => {
      const c = conv(convId)
      if (c) set((s) => ({ current: { ...s.current, [keyOf(c.projectId)]: convId } }))
    },
    send: (convId, prompt) => {
      const text = prompt.trim()
      const c = conv(convId)
      if (!text || !c || c.speaking) return
      window.clearInterval(timers.get(convId))
      const userId = nextId++
      const replyId = nextId++
      const live = get().link === 'live'
      patchConv(convId, (x) => ({
        speaking: true,
        title: x.messages.some((m) => m.role === 'user') ? x.title : text.length > 60 ? `${text.slice(0, 57)}…` : text,
        messages: [
          ...x.messages.map((m) => ({ ...m, streaming: false })),
          { id: userId, role: 'user', text },
          { id: replyId, role: 'claude', text: '', streaming: true, doing: live ? 'Thinking' : undefined },
        ],
      }))
      if (live) run(convId, replyId, text)
      else playback(convId, replyId, get().link === 'missing' ? MISSING : compose(text, c.projectId))
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
export const convsFor = (convs: Conversation[], projectId: string | null) => convs.filter((c) => keyOf(c.projectId) === keyOf(projectId)).sort((a, b) => b.updated - a.updated)

/** Conversations someone actually wrote in (the greeting alone doesn't count). */
export const hasTalk = (c: Conversation) => c.messages.some((m) => m.role === 'user')
