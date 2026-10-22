import type { Change } from './types'

// The words behind "What changed" on a thread. Claude Code on this computer
// writes a short plain-English description of a push (see server/assistant.ts);
// when it isn't available, the PR's own summary or the commit messages stand in.

/** A PR body without Claude's attribution and session lines. */
export function cleanBody(body: string | null | undefined): string | null {
  if (!body) return null
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^_?requested by \*\*|generated with \[claude code\]|^https:\/\/claude\.ai\/code\/session_|^co-authored-by:|^claude-session:/i.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The first paragraph of prose in a PR body, else the commit messages. */
export function fallbackDescription(body: string | null, commits: Change['commits']): string {
  const prose = (body ?? '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .find((b) => b && !/^#/.test(b) && !/^\s*([-*]|\d+\.)\s/.test(b) && !/^\|/.test(b))
  if (prose) return clip(plain(prose))
  const msgs = [...new Set(commits.map((c) => c.message.trim()).filter(Boolean))]
  if (!msgs.length) return 'Nothing has been pushed for this yet.'
  return clip(`${msgs.slice(0, 4).join('. ').replace(/\.\./g, '.')}${msgs.length > 4 ? ', and a few smaller changes' : ''}.`)
}

function clip(s: string, max = 420) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf(' ')))}…`
}

/** What Claude is asked, to describe one push for someone who doesn't read code. */
export function changePrompt(site: string, title: string, c: Pick<Change, 'body' | 'commits' | 'files'>): string {
  return [
    `Describe what this change to the website "${site}" does, for the site's owner, who isn't a developer.`,
    'Write 2 or 3 short plain-English sentences about what a visitor would see or notice, or how the site is built or runs differently.',
    "Don't mention file names, commits, line counts or code. No headings, lists or preamble: reply with only the description. Don't use any tools.",
    '',
    `Title: ${title}`,
    c.body ? `Description:\n${c.body.slice(0, 3000)}` : '',
    c.commits.length ? `Commits:\n${c.commits.slice(0, 30).map((x) => `- ${x.message}`).join('\n')}` : '',
    c.files.length ? `Files changed:\n${c.files.slice(0, 60).map((f) => `- ${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
