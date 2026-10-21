import { useCallback, useEffect, useRef, useState } from 'react'
import { getProject, useData } from '../data/store'
import { STATUS_LABEL } from '../data/derive'

// Mock Claude session. Replies are canned but context-aware and stream in
// word by word so every concept can animate "speaking". Replace `compose`
// with a call to the Claude Agent SDK (via Electron IPC) to make it real.

export interface ChatMessage {
  id: number
  role: 'user' | 'claude'
  text: string
  streaming?: boolean
}

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
    if (site) return site.status === 'broken' ? `${site.name}: ${site.reason}. Open the failing run from the activity list, then start a Claude thread on it with the logs.` : `${site.name} looks healthy: ${site.reason.toLowerCase()}.`
    return broken.length ? `${broken.map((x) => `${x.name}: ${x.reason}`).join('. ')}.` : 'Nothing is failing right now.'
  }
  if (/(preview|mobile|localhost)/.test(p)) {
    return site
      ? `Click the desktop or phone frame to open ${site.name} fullscreen in that size. ${site.localPort ? `Its dev server usually runs on localhost:${site.localPort}.` : ''}`
      : 'Select any project to see it big in desktop and mobile frames, then click one to go fullscreen.'
  }
  if (site) {
    return `${site.name} is ${STATUS_LABEL[site.status].toLowerCase()}: ${site.reason}. ${site.threads.length} Claude thread${site.threads.length === 1 ? '' : 's'}, ${site.commitsWeek} commits this week.`
  }
  return 'Ask me for a status check, what is failing, or open a project to talk about it.'
}

let nextId = 1

function partOfDay() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

export function useClaude(siteId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId++,
      role: 'claude',
      text: `Good ${partOfDay()}, Dylan. Ask me for a status check, or open a project.`,
    },
  ])
  const [speaking, setSpeaking] = useState(false)
  /** 0..1 pulse that spikes as each word arrives; read it in useFrame */
  const level = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearInterval(timer.current), [])

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim()
      if (!text) return
      window.clearInterval(timer.current)
      const reply = compose(text, siteId)
      const words = reply.split(' ')
      const replyId = nextId + 1
      setMessages((m) => [
        ...m.map((x) => ({ ...x, streaming: false })),
        { id: nextId++, role: 'user', text },
        { id: nextId++, role: 'claude', text: '', streaming: true },
      ])
      setSpeaking(true)
      let i = 0
      // small "thinking" delay before the first word
      window.setTimeout(() => {
        timer.current = window.setInterval(() => {
          i++
          level.current = 0.6 + Math.random() * 0.4
          setMessages((m) =>
            m.map((x) => (x.id === replyId ? { ...x, text: words.slice(0, i).join(' '), streaming: i < words.length } : x)),
          )
          if (i >= words.length) {
            window.clearInterval(timer.current)
            setSpeaking(false)
          }
        }, 55)
      }, 420)
    },
    [siteId],
  )

  return { messages, send, speaking, level }
}

export const SUGGESTIONS = ['Give me a status check', "What's failing?", "What's waiting to ship?", 'Show me the mobile view']
