import { useEffect, useState } from 'react'
import type { Change, Project, Thread } from './types'
import { useData } from './store'

// What a thread's latest push changed. Live: fetched from the local API the
// first time you open the thread (and again after a new push). Demo: made up
// from the thread so the panel has something to show.

const cache = new Map<string, Change>()
const keyOf = (p: Project, t: Thread) => `${p.id}|${t.id}|${t.pushed ?? t.updated}`

export function useChange(project: Project, thread: Thread | undefined) {
  const mode = useData((s) => s.mode)
  const key = thread ? keyOf(project, thread) : ''
  const [, bump] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!thread || cache.has(key)) return
    if (mode !== 'live') {
      cache.set(key, demoChange(project, thread))
      bump((n) => n + 1)
      return
    }
    let alive = true
    fetch(`./api/change?project=${encodeURIComponent(project.id)}&thread=${encodeURIComponent(thread.id)}`)
      .then(async (r) => {
        const x = await r.json().catch(() => null)
        if (!r.ok) throw new Error(x?.error ?? `HTTP ${r.status}`)
        return x as Change
      })
      .then((c) => {
        cache.set(key, c)
        if (alive) bump((n) => n + 1)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [key, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  return { change: cache.get(key) ?? null, loading: !!thread && !cache.has(key) && !error, error }
}

function demoChange(p: Project, t: Thread): Change {
  if (t.source === 'claude-local' && !t.branch) return { summary: 'This Claude Code session hasn’t pushed anything to GitHub yet.', by: 'pr', body: null, commits: [], files: [], additions: 0, deletions: 0, url: null }
  const page = p.pages[1]?.path.replace(/^\//, '') || 'about'
  const files: Change['files'] = [
    { path: `src/pages/${page}.astro`, status: 'modified', additions: 64, deletions: 21 },
    { path: 'src/pages/index.astro', status: 'modified', additions: 12, deletions: 4 },
    { path: 'src/components/Hero.astro', status: 'modified', additions: 30, deletions: 18 },
    { path: 'src/styles/global.css', status: 'modified', additions: 22, deletions: 6 },
    { path: `public/images/${page}-banner.webp`, status: 'added', additions: 0, deletions: 0 },
  ]
  const at = Date.parse(t.pushed ?? t.updated)
  const commits: Change['commits'] = [
    { sha: 'a1c9e42', message: `Tighten the ${page} page copy and add a banner`, date: new Date(at).toISOString(), url: t.prUrl ?? '' },
    { sha: '7f03b18', message: 'Make the hero shorter on phones', date: new Date(at - 40 * 60_000).toISOString(), url: t.prUrl ?? '' },
    { sha: '29d6c0e', message: 'Compress images and lazy-load below the fold', date: new Date(at - 95 * 60_000).toISOString(), url: t.prUrl ?? '' },
  ]
  return {
    summary: `The ${page} page has clearer wording and a new banner across the top. On phones the opening section is shorter, so visitors reach the content sooner, and images now load as you scroll, which makes the page quicker to open.`,
    by: 'claude',
    body: null,
    commits,
    files,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    url: t.prUrl ?? null,
  }
}
