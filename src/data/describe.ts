import type { Change } from './types'

// Turns a push's raw GitHub data (commits and changed files) into a few
// plain-English sentences, so you can see what a thread did to a site without
// reading a diff. Shared by the local API and the demo data.

type File = Change['files'][number]

const AREAS: [string, RegExp][] = [
  ['test', /(^|\/)(__tests__|tests?|e2e|cypress|playwright)\/|\.(test|spec)\.[a-z]+$/i],
  ['setup', /(^|\/)(\.github|\.vscode|\.husky)\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|\.gitignore|\.gitattributes|\.env[^/]*|vercel\.json|netlify\.toml|wrangler\.toml|dockerfile|[^/]*\.config\.[a-z]+|[^/]*rc(\.[a-z]+)?)$/i],
  ['image', /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|woff2?|ttf|otf)$/i],
  ['style', /\.(css|scss|sass|less|styl)$|(^|\/)(styles?|tailwind)[^/]*\//i],
  ['component', /(^|\/)(components?|ui|widgets|sections|layouts?|partials)\//i],
  ['page', /(^|\/)(pages|routes|views|app)\/|(^|\/)page\.[jt]sx?$|\.(html?|astro|liquid|hbs|php)$/i],
  ['content', /(^|\/)(content|posts|blog|data|locales|i18n)\/|\.(mdx?|ya?ml|csv)$/i],
  ['server', /(^|\/)(api|server|functions|lambda|backend|netlify\/functions)\//i],
  ['docs', /(^|\/)(readme|changelog|license|contributing)[^/]*$|(^|\/)docs\//i],
]

const areaOf = (path: string) => AREAS.find(([, re]) => re.test(path))?.[0] ?? 'code'

const NOUN: Record<string, [string, string]> = {
  page: ['page', 'pages'],
  component: ['component', 'components'],
  style: ['stylesheet', 'stylesheets'],
  image: ['image or media file', 'images and media files'],
  content: ['content file', 'content files'],
  server: ['server or API file', 'server and API files'],
  setup: ['setup or build file', 'setup and build files'],
  test: ['test', 'tests'],
  docs: ['docs file', 'docs files'],
  code: ['code file', 'other code files'],
}

/** "about", "services/web-design", "home" from a page file path. */
function pageName(path: string) {
  const parts = path
    .replace(/\.[a-z0-9]+$/i, '')
    .split('/')
    .filter((x) => x && !/^(src|app|pages|routes|views|public|\(.*\))$/i.test(x))
  while (parts.length > 1 && /^(index|page|\+page|layout)$/i.test(parts.at(-1)!)) parts.pop()
  const name = parts.join('/') || 'home'
  return /^(index|page|\+page)$/i.test(name) ? 'home' : name
}

const fileName = (path: string) => path.split('/').pop() ?? path

function list(items: string[], max = 4) {
  const shown = items.slice(0, max)
  const more = items.length - shown.length
  if (more > 0) shown.push(`${more} more`)
  if (shown.length < 2) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function describeChange(files: File[], commits: Change['commits']): string[] {
  const out: string[] = []
  if (!files.length) {
    out.push(commits.length ? `${plural(commits.length, 'commit')}, but GitHub didn't list any changed files.` : 'Nothing has been pushed for this yet.')
    return out
  }
  const add = files.reduce((a, f) => a + f.additions, 0)
  const del = files.reduce((a, f) => a + f.deletions, 0)
  out.push(`${plural(commits.length || 1, 'commit')} touching ${plural(files.length, 'file')}: ${add.toLocaleString()} line${add === 1 ? '' : 's'} added and ${del.toLocaleString()} removed.`)

  // what kind of things changed, biggest first
  const groups = new Map<string, File[]>()
  for (const f of files) {
    const a = areaOf(f.path)
    groups.set(a, [...(groups.get(a) ?? []), f])
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].reduce((n, f) => n + f.additions + f.deletions + 1, 0) - a[1].reduce((n, f) => n + f.additions + f.deletions + 1, 0))
  const parts = ranked.map(([area, fs]) => {
    const [one, many] = NOUN[area]
    if (area === 'page') return `${fs.length === 1 ? 'one' : fs.length} ${fs.length === 1 ? one : many} (${list([...new Set(fs.map((f) => pageName(f.path)))], 3)})`
    if (area === 'component') return `${fs.length === 1 ? 'one' : fs.length} ${fs.length === 1 ? one : many} (${list(fs.map((f) => fileName(f.path).replace(/\.[a-z]+$/i, '')), 3)})`
    return `${fs.length === 1 ? 'one' : fs.length} ${fs.length === 1 ? one : many}`
  })
  out.push(`Mostly ${list(parts, 5)}.`)

  const added = files.filter((f) => f.status === 'added')
  const removed = files.filter((f) => f.status === 'removed')
  if (added.length) out.push(`New: ${list(added.map((f) => fileName(f.path)), 5)}.`)
  if (removed.length) out.push(`Deleted: ${list(removed.map((f) => fileName(f.path)), 5)}.`)
  return out
}

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
