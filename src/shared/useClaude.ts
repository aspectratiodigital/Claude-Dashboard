import { useCallback, useEffect, useRef, useState } from 'react'
import { getProject, useData } from '../data/store'
import { STATUS_LABEL } from '../data/derive'

// The Claude bar. With the local API running and Claude Code installed, each
// message runs your own Claude Code in the project's folder (server/assistant.ts)
// and streams back what it says and does. Edits and commands come back as
// "asks" with Allow buttons. Without Claude Code (or in demo mode) it falls
// back to short canned answers drawn from the dashboard data.

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

export type ClaudeLink = 'checking' | 'live' | 'missing' | 'offline'

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

let nextId = 1

function partOfDay() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

const MISSING =
  "I'm not connected yet: Claude Code isn't installed on this computer. Open PowerShell, run npm.cmd install -g @anthropic-ai/claude-code, then run claude.cmd once to sign in. Then close and reopen the dashboard."

/** One Claude Code conversation per project ("" = no project), kept while the app is open. */
const sessions = new Map<string, { id: string; allowed: string[] }>()

let linkCache: Promise<ClaudeLink> | null = null
function checkLink(): Promise<ClaudeLink> {
  linkCache ??= fetch('./api/claude')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((r: { available: boolean }) => (r.available ? 'live' : 'missing') as ClaudeLink)
    .catch(() => 'offline' as ClaudeLink)
  return linkCache
}

export function useClaude(siteId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: nextId++, role: 'claude', text: `Good ${partOfDay()}, Dylan. Ask me anything about your sites, or pick a project and ask me to work on it.` },
  ])
  const [speaking, setSpeaking] = useState(false)
  const [link, setLink] = useState<ClaudeLink>('checking')
  /** 0..1 pulse that spikes as each chunk arrives; read it in useFrame */
  const level = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const abort = useRef<AbortController | null>(null)
  const api = useData((s) => s.api)

  useEffect(() => {
    if (!api) return setLink('offline')
    let live = true
    checkLink().then((l) => live && setLink(l))
    return () => {
      live = false
    }
  }, [api])

  useEffect(
    () => () => {
      window.clearInterval(timer.current)
      abort.current?.abort()
    },
    [],
  )

  const patch = (id: number, f: (m: ChatMessage) => Partial<ChatMessage>) => setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...f(m) } : m)))

  /** Canned fallback, streamed word by word. */
  const playback = useCallback((replyId: number, reply: string) => {
    const words = reply.split(' ')
    let i = 0
    window.setTimeout(() => {
      timer.current = window.setInterval(() => {
        i++
        level.current = 0.6 + Math.random() * 0.4
        setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, text: words.slice(0, i).join(' '), streaming: i < words.length } : x)))
        if (i >= words.length) {
          window.clearInterval(timer.current)
          setSpeaking(false)
        }
      }, 55)
    }, 420)
  }, [])

  const run = useCallback(async (replyId: number, prompt: string, allow?: string[]) => {
    const key = siteId ?? ''
    const sess = sessions.get(key)
    const ctl = new AbortController()
    abort.current = ctl
    try {
      const res = await fetch('./api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, projectId: siteId, resume: sess?.id, allow: [...(sess?.allowed ?? []), ...(allow ?? [])] }),
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
          level.current = 0.6 + Math.random() * 0.4
          if (e.type === 'text') patch(replyId, (m) => ({ text: m.text + e.text, doing: undefined }))
          else if (e.type === 'tool') patch(replyId, () => ({ doing: e.text }))
          else if (e.type === 'error') patch(replyId, (m) => ({ text: m.text ? `${m.text}\n\n${e.text}` : e.text, error: true }))
          else if (e.type === 'done') {
            if (e.session) sessions.set(key, { id: e.session, allowed: [...(sess?.allowed ?? []), ...(allow ?? [])] })
            patch(replyId, (m) => ({ streaming: false, doing: undefined, asks: e.asks?.length ? e.asks : undefined, text: m.text || (e.asks?.length ? 'I need your OK for this:' : 'Done.') }))
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') patch(replyId, (m) => ({ text: m.text || `I couldn't reach Claude Code: ${(err as Error).message}`, error: true }))
    } finally {
      patch(replyId, () => ({ streaming: false, doing: undefined }))
      setSpeaking(false)
    }
  }, [siteId])

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim()
      if (!text || speaking) return
      window.clearInterval(timer.current)
      const userId = nextId++
      const replyId = nextId++
      setMessages((m) => [
        ...m.map((x) => ({ ...x, streaming: false })),
        { id: userId, role: 'user', text },
        { id: replyId, role: 'claude', text: '', streaming: true, doing: link === 'live' ? 'Thinking' : undefined },
      ])
      setSpeaking(true)
      if (link === 'live') run(replyId, text)
      else playback(replyId, link === 'missing' ? MISSING : compose(text, siteId))
    },
    [link, run, playback, siteId, speaking],
  )

  /** Answer an Allow / No on one of Claude's asks. */
  const answer = useCallback(
    (msg: ChatMessage, ok: boolean) => {
      if (!msg.asks || msg.answered || speaking) return
      patch(msg.id, () => ({ answered: ok ? 'allowed' : 'declined' }))
      if (!ok) return
      const replyId = nextId++
      setMessages((m) => [...m, { id: replyId, role: 'claude', text: '', streaming: true, doing: 'Carrying on' }])
      setSpeaking(true)
      run(replyId, "You have permission now for what you asked. Carry on from where you stopped.", msg.asks.map((a) => a.rule))
    },
    [run, speaking],
  )

  const stop = useCallback(() => abort.current?.abort(), [])

  return { messages, send, answer, stop, speaking, level, link }
}

export const SUGGESTIONS = ['Give me a status check', "What's failing?", 'What should I work on next?', "What's waiting to ship?"]
