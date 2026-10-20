import { useCallback, useEffect, useRef, useState } from 'react'
import { siteById, SITES, totals } from '../data/mock'

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
  const site = siteById(siteId)
  if (/(status|how.*(doing|going)|overview|summary)/.test(p)) {
    const attention = SITES.filter((s) => s.status === 'attention').map((s) => s.name)
    return `${totals.live} sites are live and ${totals.building} are building. ${
      attention.length ? `${attention.join(', ')} needs a look: the timetable fix is still failing on Safari.` : 'Nothing needs your attention.'
    } Across everything you had ${totals.visitors7d.toLocaleString()} visitors this week, with ${totals.openPRs} pull requests open.`
  }
  if (/(deploy|ship|release)/.test(p)) {
    return site
      ? `I can deploy ${site.repo}@${site.branch} once checks pass. ${site.openPRs} PR${site.openPRs === 1 ? '' : 's'} open, last commit "${site.commits[0].message}". Want me to start a preview build first?`
      : 'Pick a site and I will prepare a preview deploy for it, then promote it once you approve.'
  }
  if (/(bug|fix|error|broken)/.test(p)) {
    return site
      ? `On ${site.name} I'd start with the latest change on ${site.branch}. I'll open a Claude Code session in ${site.repo}, reproduce it on localhost:${site.port} and propose a patch.`
      : 'Volt Gyms is the only site with failing checks. I can open a Claude Code session on fix/timetable-tz and reproduce the Safari bug.'
  }
  if (/(preview|mobile|localhost)/.test(p)) {
    return site
      ? `The preview panel is showing ${site.name}. Switch to mobile to check the ${site.framework} layout at 390px, or point it at localhost:${site.port} once your dev server is running.`
      : 'Select any site to open its preview. Desktop and mobile frames both work, and you can point them at a localhost port.'
  }
  if (site) {
    return `${site.name} is ${site.status === 'attention' ? 'flagged' : site.status} with a Lighthouse score of ${site.lighthouse} and ${site.visitors7d.toLocaleString()} visitors this week. I can review open PRs, run a performance pass, or draft copy for the next page. What would help?`
  }
  return "I'm connected to your repos and projects. Ask me for a status check, to fix a bug, to deploy a branch, or open a site to work on it together."
}

let nextId = 1

export function useClaude(siteId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId++,
      role: 'claude',
      text: 'Good evening, Dylan. Volt Gyms has a failing check, everything else is healthy. Ask me anything.',
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

export const SUGGESTIONS = ['Give me a status check', 'Fix the failing build', 'Deploy this branch', 'Open mobile preview']
