import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { StudioKind } from '../src/data/types.ts'

// Reading and changing a site's source for Studio, without Claude where it's
// safe to: finding words wherever the site keeps them (HTML, templates, data
// files, Markdown) and replacing them only where they're words a visitor reads,
// never inside tags, class names, paths or code. Also the site's content files
// as forms, its photo library with what uses each photo, and a search across
// every rendered page.

export const SOURCE_EXT = /\.(html?|json|m?js|cjs|ts|tsx|jsx|astro|mdx?|ya?ml|njk|liquid|svelte|vue|txt)$/i
const STYLE_EXT = /\.(css|scss|sass|less)$/i
const SOURCE_SKIP = new Set(['node_modules', '.git', '.astro', 'dist', 'release', '.github', '.vscode', '.claude', '_archive', 'build-wix'])

/** the files a site's words and markup live in (a generated site's own HTML output is left out: its build would overwrite it) */
export function sourceFiles(dir: string, kind: StudioKind, opts: { styles?: boolean; built?: boolean } = {}): string[] {
  const out: string[] = []
  const walkSrc = (d: string, depth: number) => {
    if (depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SOURCE_SKIP.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === '_capture' && depth === 0) {
          // only the copy and data files a generated site reads from here
          for (const f of ['copy.json', 'acc-fees.json']) if (fs.existsSync(path.join(full, f))) out.push(path.join(full, f))
          continue
        }
        walkSrc(full, depth + 1)
        continue
      }
      const style = STYLE_EXT.test(e.name)
      if (!(SOURCE_EXT.test(e.name) || (opts.styles && style)) || /\.min\.|package-lock|CLAUDE\.md|README|\.d\.ts$/i.test(e.name)) continue
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (!opts.built && kind === 'generated' && /\.html?$/i.test(e.name) && !rel.startsWith('src/')) continue
      try {
        if (fs.statSync(full).size < 1_500_000) out.push(full)
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  walkSrc(dir, 0)
  return out
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const CHAR: Record<string, string> = {
  '&': '(?:&|&amp;)',
  "'": `(?:'|’|&#39;|&#039;|&rsquo;|&apos;|\\\\')`,
  '’': `(?:’|'|&#39;|&#8217;|&rsquo;|\\\\')`,
  '"': '(?:"|\\\\"|&quot;|“|”)',
  '“': '(?:“|"|&ldquo;|\\\\")',
  '”': '(?:”|"|&rdquo;|\\\\")',
  '–': '(?:–|&ndash;)',
  '—': '(?:—|&mdash;)',
  '<': '(?:<|&lt;)',
  '>': '(?:>|&gt;)',
}

/** a pattern for text as the browser shows it, matching how it's likely written in source */
export function textPattern(text: string, flags = 'g', wholeWord = false) {
  const word = (w: string) => [...w].map((c) => CHAR[c] ?? reEscape(c)).join('')
  const body = text.trim().split(/\s+/).map(word).join('(?:\\s|&nbsp;|<br\\s*/?>)+')
  const u = flags.includes('u') ? flags : `${flags}u`
  return new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, u)
}

/** the new text, written the way the place it goes into expects */
export function encodeFor(file: string, text: string, mode?: Mode | 'attr') {
  const jsEscape = (t: string) => t.replace(/\\/g, '\\\\').replace(/['"`]/g, '\\$&').replace(/\$\{/g, '\\${')
  if (mode === 'json' || (!mode && /\.json$/i.test(file))) return JSON.stringify(text).slice(1, -1)
  // a string in code: it may be shown as text or as markup, so only what JavaScript needs
  if (mode === 'string') return jsEscape(text)
  // markup inside a template literal
  if (mode === 'template') return jsEscape(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  if (mode === 'attr') return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  if (mode === 'yaml' || mode === 'md' || mode === 'text') return text
  if (mode === 'html') return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (/\.(m?js|cjs|tsx?|jsx|svelte|vue)$/i.test(file)) return jsEscape(text)
  if (/\.(html?|astro|njk|liquid|mdx?)$/i.test(file)) return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text
}

/** what kind of place an offset in a file is: readable words (with their mode), or inside a tag's attributes */
export function modeAt(file: string, body: string, index: number, length: number): Mode | 'attr' | null {
  const span = textSpans(body, file).find((x) => x.start <= index && index + length <= x.end)
  if (span) return span.mode
  return /\.(html?|astro|njk|liquid|svelte|vue)$/i.test(file) ? 'attr' : null
}

// --- Where a file's readable words are ------------------------------------------------------

/** what kind of place a span of a file is: page markup, a string in code, a data value */
export type Mode = 'html' | 'string' | 'template' | 'json' | 'md' | 'yaml' | 'text'
export interface Span {
  start: number
  end: number
  mode: Mode
}

/** markup: everything outside tags, comments, scripts and styles */
function htmlSpans(body: string, from = 0, to = body.length, mode: Mode = 'html'): Span[] {
  const out: Span[] = []
  let i = from
  let textStart = from
  const flush = (end: number) => {
    if (end > textStart) out.push({ start: textStart, end, mode })
  }
  while (i < to) {
    if (body[i] === '<') {
      const rest = body.slice(i, i + 12).toLowerCase()
      if (rest.startsWith('<!--')) {
        flush(i)
        const e = body.indexOf('-->', i + 4)
        i = e < 0 || e > to ? to : e + 3
        textStart = i
        continue
      }
      if (/^<[a-z!/]/i.test(body.slice(i, i + 2))) {
        flush(i)
        // to the end of the tag, minding quoted attribute values (which can hold >)
        let j = i + 1
        let q: string | null = null
        for (; j < to; j++) {
          const c = body[j]
          if (q) {
            if (c === q) q = null
          } else if (c === '"' || c === "'") q = c
          else if (c === '>') break
        }
        const name = body.slice(i + 1, j).match(/^([a-z][\w-]*)/i)?.[1]?.toLowerCase()
        i = j + 1
        if (name === 'script' || name === 'style' || name === 'svg' || name === 'textarea' || name === 'pre' || name === 'code') {
          const close = body.toLowerCase().indexOf(`</${name}`, i)
          if (name === 'textarea' || name === 'pre' || name === 'code') {
            // words a visitor reads, but kept exactly as written: leave them alone
          }
          i = close < 0 || close > to ? to : close
        }
        textStart = i
        continue
      }
    }
    i++
  }
  flush(Math.min(i, to))
  return out
}

/** code: the insides of its string literals (template literals as markup, minus ${…}) */
function jsSpans(body: string, from = 0, to = body.length): Span[] {
  const out: Span[] = []
  let i = from
  const looksLikeCode = (s: string) => !/\s/.test(s) && /[/.:#_=-]/.test(s) && /^[\w./:#?=&%@-]+$/.test(s)
  while (i < to) {
    const c = body[i]
    if (c === '/' && body[i + 1] === '/') {
      const e = body.indexOf('\n', i)
      i = e < 0 ? to : e
      continue
    }
    if (c === '/' && body[i + 1] === '*') {
      const e = body.indexOf('*/', i + 2)
      i = e < 0 ? to : e + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      for (; j < to && body[j] !== c && body[j] !== '\n'; j++) if (body[j] === '\\') j++
      const inner = body.slice(i + 1, j)
      // keys of import paths, class names, ids and URLs aren't words to change
      const before = body.slice(Math.max(from, i - 30), i)
      if (!looksLikeCode(inner) && !/(import|from|require\()\s*$/.test(before)) out.push({ start: i + 1, end: j, mode: 'string' })
      i = j + 1
      continue
    }
    if (c === '`') {
      // a template literal: markup, with ${…} holes
      let j = i + 1
      let segStart = j
      while (j < to && body[j] !== '`') {
        if (body[j] === '\\') {
          j += 2
          continue
        }
        if (body[j] === '$' && body[j + 1] === '{') {
          out.push(...htmlSpans(body, segStart, j, 'template'))
          // skip the expression, counting braces (strings inside it are code)
          let depth = 1
          j += 2
          const exprStart = j
          while (j < to && depth > 0) {
            const ch = body[j]
            if (ch === '{') depth++
            else if (ch === '}') depth--
            else if (ch === '`') {
              // a nested template literal: jump over it
              let k = j + 1
              while (k < to && body[k] !== '`') k += body[k] === '\\' ? 2 : 1
              j = k
            }
            j++
          }
          out.push(...jsSpans(body, exprStart, j - 1))
          segStart = j
          continue
        }
        j++
      }
      out.push(...htmlSpans(body, segStart, j, 'template'))
      i = j + 1
      continue
    }
    i++
  }
  return out
}

const URLISH_KEY = /^(slug|href|url|uri|src|srcset|image|img|icon|logo|photo|thumbnail|id|key|class|classname|path|file|link|type|layout|template|component|lang|locale|date|time|color|colour)$/i

/** JSON: string values (not keys), leaving out addresses, ids and the like */
function jsonSpans(body: string): Span[] {
  const out: Span[] = []
  const re = /"((?:[^"\\]|\\.)*)"(\s*:)?/g
  let lastKey = ''
  for (const m of body.matchAll(re)) {
    if (m[2]) {
      lastKey = m[1]
      continue
    }
    if (URLISH_KEY.test(lastKey) || /^[\w./:#?=&%@-]+$/.test(m[1]) && /[/.:#_]/.test(m[1])) continue
    out.push({ start: m.index! + 1, end: m.index! + 1 + m[1].length, mode: 'json' })
  }
  return out
}

/** YAML (front matter or data files): values after "key:" or "- " */
function yamlSpans(body: string, from = 0, to = body.length): Span[] {
  const out: Span[] = []
  let pos = from
  for (const lineRaw of body.slice(from, to).split('\n')) {
    const line = lineRaw
    const m = line.match(/^(\s*(?:-\s+)?(?:([\w-]+)\s*:\s*)?)(.*)$/)
    if (m && m[3] && !m[3].startsWith('#') && !(m[2] && URLISH_KEY.test(m[2]))) {
      let s = pos + m[1].length
      let e = pos + line.length
      const v = m[3]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        s++
        e--
      }
      if (e > s && !/^[|>][-+]?$/.test(v.trim())) out.push({ start: s, end: e, mode: 'yaml' })
    }
    pos += line.length + 1
  }
  return out
}

/** Markdown: the body outside code, plus front matter values */
function mdSpans(body: string): Span[] {
  const out: Span[] = []
  let start = 0
  const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (fm) {
    out.push(...yamlSpans(body, 4, fm[0].length - 4))
    start = fm[0].length
  }
  // skip fenced code and inline HTML tags
  const rest = body.slice(start)
  let i = 0
  for (const m of rest.matchAll(/```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|\]\([^)]*\)/g)) {
    if (m.index! > i) out.push({ start: start + i, end: start + m.index!, mode: 'md' })
    i = m.index! + m[0].length
  }
  if (i < rest.length) out.push({ start: start + i, end: body.length, mode: 'md' })
  return out
}

export function textSpans(body: string, file: string): Span[] {
  const ext = path.extname(file).toLowerCase()
  if (['.html', '.htm', '.njk', '.liquid'].includes(ext)) return htmlSpans(body)
  if (ext === '.astro' || ext === '.svelte' || ext === '.vue') {
    const fm = ext === '.astro' ? body.match(/^---\r?\n[\s\S]*?\r?\n---/) : null
    if (fm) return [...jsSpans(body, 3, fm[0].length - 3), ...htmlSpans(body, fm[0].length)]
    return htmlSpans(body)
  }
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return jsSpans(body)
  if (ext === '.json') return jsonSpans(body)
  if (ext === '.md' || ext === '.mdx') return mdSpans(body)
  if (ext === '.yml' || ext === '.yaml') return yamlSpans(body)
  if (ext === '.txt') return [{ start: 0, end: body.length, mode: 'text' }]
  return []
}

export interface Hit {
  file: string
  index: number
  length: number
  mode: Mode
}

/** every place a pattern matches inside readable words */
export function findInText(files: string[], re: RegExp, limit = 2000): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    let body: string
    try {
      body = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    re.lastIndex = 0
    if (!re.test(body)) continue
    const spans = textSpans(body, file)
    re.lastIndex = 0
    for (const m of body.matchAll(re)) {
      const s = m.index!
      const e = s + m[0].length
      const span = spans.find((x) => x.start <= s && e <= x.end)
      if (span) hits.push({ file, index: s, length: m[0].length, mode: span.mode })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** write replacements in, last first so earlier offsets stay right */
export function replaceHits(hits: Hit[], text: (h: Hit) => string): string[] {
  const byFile = new Map<string, Hit[]>()
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h])
  for (const [file, list] of byFile) {
    let body = fs.readFileSync(file, 'utf8')
    for (const h of list.sort((a, b) => b.index - a.index)) body = body.slice(0, h.index) + text(h) + body.slice(h.index + h.length)
    fs.writeFileSync(file, body)
  }
  return [...byFile.keys()]
}

/**
 * With Match case off, the new words follow the case of each match: all small
 * mid-sentence, all capitals in a shouting heading, a capital first letter at
 * the start of a sentence. Acronyms (NHS, GP) keep their capitals.
 * (The canvas does the same in studio-overlay.ts fitCase.)
 */
export function fitCase(match: string, replacement: string): string {
  const letters = (t: string) => t.replace(/[^\p{L}]/gu, '')
  const m = letters(match.replace(/<[^>]*>|&[#\w]+;/g, ' '))
  if (!m || !letters(replacement)) return replacement
  if (m.length > 1 && m === m.toUpperCase() && m !== m.toLowerCase()) return replacement.toUpperCase()
  if (m === m.toLowerCase() && m !== m.toUpperCase()) return replacement.replace(/\p{L}+/gu, (w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
  const first = m[0]
  if (first === first.toUpperCase()) return replacement.replace(/\p{L}/u, (c) => c.toUpperCase())
  return replacement
}

/** a find-and-replace pattern from what you typed */
export function findPattern(find: string, matchCase: boolean, wholeWord: boolean) {
  return textPattern(find, matchCase ? 'g' : 'gi', wholeWord)
}

// --- Searching the rendered pages ------------------------------------------------------------

function get(port: number, p: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout, headers: { Accept: 'text/html' } }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        res.resume()
        return resolve('')
      }
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => (req.destroy(), resolve('')))
  })
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', copy: '©', pound: '£' }
export const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })

/** a page's visible words, from its HTML */
export function visibleText(html: string) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html
  return decodeEntities(
    body
      .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?(span|a|strong|em|b|i|small|sup|sub|u|mark|abbr|time)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SearchHit {
  path: string
  title: string
  count: number
  snippets: string[]
}

/** search every page as it's shown, through the site's preview */
export async function searchPages(port: number, pages: string[], find: string, matchCase: boolean, wholeWord: boolean): Promise<SearchHit[]> {
  const esc = reEscape(find.trim()).replace(/\s+/g, '\\s+')
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, `g${matchCase ? '' : 'i'}u`)
  const out: SearchHit[] = []
  const queue = pages.slice(0, 200)
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        const html = await get(port, p)
        if (!html) continue
        const text = visibleText(html)
        const matches = [...text.matchAll(re)]
        if (!matches.length) continue
        const title = decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '')
        const around = (t: string, m: RegExpMatchArray) => {
          const s = Math.max(0, m.index! - 50)
          const e = Math.min(t.length, m.index! + m[0].length + 50)
          return `${s > 0 ? '…' : ''}${t.slice(s, e).trim()}${e < t.length ? '…' : ''}`
        }
        // the page's own words first: the menu and footer say the same on every page
        const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1]
        const mainText = main ? visibleText(`<body>${main}</body>`) : ''
        const snippets = [...new Set([...[...mainText.matchAll(re)].map((m) => around(mainText, m)), ...matches.map((m) => around(text, m))])].slice(0, 3)
        out.push({ path: p, title, count: matches.length, snippets })
      }
    }),
  )
  return out.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)))
}

// --- Content files as forms ------------------------------------------------------------------

export interface ContentFile {
  path: string
  /** "Gigs", "Site copy" */
  group: string
  label: string
  type: 'json' | 'md' | 'yaml'
  size: number
}

const NOT_CONTENT = /(^|\/)(package(-lock)?|tsconfig[\w.-]*|jsconfig|composer|manifest|site\.webmanifest|vercel|netlify|firebase|renovate|lighthouserc|\.?eslintrc|\.?prettierrc|babel\.config|components|deno|bun|turbo|nx|project|launch|settings|extensions|google-reviews-raw)\.json$|\.config\.json$/i

const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()

/** the files a site keeps its words and listings in: Astro collections, data folders, copy files */
export function contentFiles(dir: string, kind: StudioKind): ContentFile[] {
  const out: ContentFile[] = []
  const add = (full: string, group: string) => {
    const rel = path.relative(dir, full).split(path.sep).join('/')
    const ext = path.extname(full).toLowerCase()
    const type = ext === '.json' ? 'json' : ext === '.md' || ext === '.mdx' ? 'md' : ext === '.yaml' || ext === '.yml' ? 'yaml' : null
    if (!type || NOT_CONTENT.test(rel) || out.some((f) => f.path === rel)) return
    let size = 0
    try {
      size = fs.statSync(full).size
    } catch {
      return
    }
    if (size > 2_000_000 || size < 2) return
    out.push({ path: rel, group, label: titleCase(path.basename(full, ext)), type, size })
  }
  const walkIn = (d: string, group: (rel: string) => string, depth = 0) => {
    if (depth > 4 || !fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SOURCE_SKIP.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walkIn(full, group, depth + 1)
      else add(full, group(path.relative(dir, full).split(path.sep).join('/')))
    }
  }
  if (kind === 'astro') {
    walkIn(path.join(dir, 'src', 'content'), (rel) => titleCase(rel.split('/')[2]?.includes('.') ? 'Site' : (rel.split('/')[2] ?? 'Content')))
    walkIn(path.join(dir, 'src', 'data'), () => 'Data')
  }
  for (const d of ['data', 'content', '_data', 'src/data', 'src/content']) if (kind !== 'astro' || !d.startsWith('src')) walkIn(path.join(dir, d), (rel) => titleCase(rel.split('/').slice(-2, -1)[0] ?? 'Data'))
  // copy and data files next to a generator script, or at the top of the repo
  for (const d of ['', 'build-v2', '_capture', 'src']) {
    const full = path.join(dir, d)
    if (!fs.existsSync(full)) continue
    for (const e of fs.readdirSync(full, { withFileTypes: true })) if (e.isFile() && /\.json$/i.test(e.name)) add(path.join(full, e.name), d ? titleCase(d.replace(/^_/, '')) : 'Site')
  }
  return out.slice(0, 600)
}

/** A path inside the repo from the browser, or null if it points anywhere else. */
export function inRepo(dir: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null
  const full = path.resolve(dir, rel)
  if (!full.startsWith(path.resolve(dir) + path.sep)) return null
  if (rel.split(/[\\/]/).some((s) => s.startsWith('.') || s === 'node_modules')) return null
  return full
}

export type FrontValue = string | number | boolean | string[] | null
export interface ContentData {
  type: 'json' | 'md' | 'yaml'
  /** a JSON file's data */
  data?: unknown
  /** a Markdown file's front matter: simple values you can edit, and the rest shown as written */
  front?: Record<string, FrontValue>
  complex?: Record<string, string>
  body?: string
  /** a YAML data file, as text */
  text?: string
}

function yamlScalar(v: string): FrontValue {
  const t = v.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true' || t === 'false') return t === 'true'
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return Number(t)
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t)
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function yamlQuote(v: FrontValue): string {
  if (v === null) return ''
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return '' // written as a block below
  const s = String(v)
  if (s === '' || /^[\s#&*!|>'"%@`{[\]-]|:\s|\s#|^(true|false|null|yes|no|~)$|^-?\d+(\.\d+)?$|\n|\s$/i.test(s)) return JSON.stringify(s)
  return s
}

/** parse simple front matter: one level of key: value, and lists of plain values */
function parseFront(src: string): { front: Record<string, FrontValue>; complex: Record<string, string> } {
  const front: Record<string, FrontValue> = {}
  const complex: Record<string, string> = {}
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, rest] = m
    if (rest.trim() && !/^[|>]/.test(rest.trim())) {
      if (rest.trim().startsWith('[') && rest.trim().endsWith(']')) {
        const inner = rest.trim().slice(1, -1).trim()
        front[key] = inner ? inner.split(/\s*,\s*/).map((x) => String(yamlScalar(x) ?? '')) : []
      } else if (rest.trim().startsWith('{')) complex[key] = rest.trim()
      else front[key] = yamlScalar(rest)
      continue
    }
    // a block: a list of plain values, or something nested
    const block: string[] = []
    let j = i + 1
    for (; j < lines.length && (/^\s+\S/.test(lines[j]) || /^\s*$/.test(lines[j]) || /^-\s/.test(lines[j])); j++) block.push(lines[j])
    while (block.length && !block[block.length - 1].trim()) block.pop()
    if (block.length && block.every((l) => /^\s*-\s+[^:]*$/.test(l) || !l.trim()) && !/^[|>]/.test(rest.trim())) front[key] = block.filter((l) => l.trim()).map((l) => String(yamlScalar(l.replace(/^\s*-\s+/, '')) ?? ''))
    else complex[key] = [rest.trim(), ...block].join('\n')
    i = j - 1
  }
  return { front, complex }
}

export function readContent(dir: string, rel: string): ContentData | { error: string } {
  const full = inRepo(dir, rel)
  if (!full || !fs.existsSync(full)) return { error: 'That file isn’t in the site' }
  const text = fs.readFileSync(full, 'utf8')
  const ext = path.extname(full).toLowerCase()
  if (ext === '.json') {
    try {
      return { type: 'json', data: JSON.parse(text) }
    } catch {
      return { error: 'This JSON file has a mistake in it, so it can’t be shown as a form' }
    }
  }
  if (ext === '.md' || ext === '.mdx') {
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    const { front, complex } = fm ? parseFront(fm[1].replace(/\r/g, '')) : { front: {}, complex: {} }
    return { type: 'md', front, complex, body: fm ? text.slice(fm[0].length) : text }
  }
  return { type: 'yaml', text }
}

/** write a content file back, keeping its layout: JSON's indent, untouched front matter lines */
export function writeContent(dir: string, rel: string, update: { data?: unknown; front?: Record<string, FrontValue>; body?: string; text?: string }): { ok: true; changed: boolean } | { error: string } {
  const full = inRepo(dir, rel)
  if (!full || !fs.existsSync(full)) return { error: 'That file isn’t in the site' }
  const was = fs.readFileSync(full, 'utf8')
  const ext = path.extname(full).toLowerCase()
  let next = was
  if (ext === '.json') {
    if (update.data === undefined) return { error: 'Nothing to save' }
    const indent = was.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
    next = JSON.stringify(update.data, null, indent.includes('\t') ? '\t' : indent.length) + (was.endsWith('\n') ? '\n' : '')
  } else if (ext === '.md' || ext === '.mdx') {
    const fm = was.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    let front = fm ? fm[1] : ''
    if (update.front) {
      const lines = front.split('\n')
      for (const [key, value] of Object.entries(update.front)) {
        if (!/^[\w-]+$/.test(key)) continue
        const at = lines.findIndex((l) => l.match(/^([\w-]+)\s*:/)?.[1] === key)
        // the lines a block list takes after its key
        let end = at + 1
        if (at >= 0) while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^-\s/.test(lines[end]))) end++
        const written = Array.isArray(value) ? [`${key}:`, ...value.map((v) => `  - ${yamlQuote(v)}`)] : [`${key}: ${yamlQuote(value)}`.trimEnd()]
        if (at >= 0) lines.splice(at, end - at, ...written)
        else lines.push(...written)
      }
      front = lines.join('\n')
    }
    const body = typeof update.body === 'string' ? update.body : fm ? was.slice(fm[0].length) : was
    next = fm || update.front ? `---\n${front}\n---\n${body}` : body
  } else {
    if (typeof update.text !== 'string') return { error: 'Nothing to save' }
    next = update.text
  }
  if (next === was) return { ok: true, changed: false }
  fs.writeFileSync(full, next)
  return { ok: true, changed: true }
}

// --- The photo library ----------------------------------------------------------------------

export interface LibraryPhoto {
  /** where it is in the repo */
  path: string
  /** the address the preview serves it at */
  url: string
  group: string
  bytes: number
  width: number | null
  height: number | null
  /** how many files mention it (pages, templates, styles, data); -1 when code builds names like it, so it may be used */
  uses: number
}

const IMG = /\.(jpe?g|png|webp|avif|gif|svg)$/i

/** the folders a site's own image script reads its original photos from (they're used by the build) */
export function sourcePhotoFolders(dir: string): Set<string> {
  const out = new Set<string>()
  const script = path.join(dir, 'build-v2', 'images.js')
  if (!fs.existsSync(script)) return out
  const body = fs.readFileSync(script, 'utf8')
  for (const m of body.matchAll(/['"]([^'"/\n]+)\/[^'"\n]+\.(?:jpe?g|png|webp|svg|gif|avif)['"]/gi)) out.add(m[1])
  for (const m of body.matchAll(/join\(\s*ROOT\s*,\s*['"]([^'"]+)['"]\s*\)/g)) if (!/\./.test(m[1]) && m[1] !== 'img') out.add(m[1])
  return out
}

/** width and height from an image file's first bytes (PNG, JPEG, GIF, WebP, SVG) */
export function imageSize(file: string): { width: number; height: number } | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const b = Buffer.alloc(65536)
    const n = fs.readSync(fd, b, 0, b.length, 0)
    const buf = b.subarray(0, n)
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
    }
    if (/\.svg$/i.test(file)) {
      const t = buf.toString('utf8')
      const vb = t.match(/viewBox=["'][\d.\s-]*?([\d.]+)[\s,]+([\d.]+)["']/)
      const w = t.match(/<svg[^>]*\swidth=["']([\d.]+)/)?.[1]
      const h = t.match(/<svg[^>]*\sheight=["']([\d.]+)/)?.[1]
      if (w && h) return { width: Math.round(Number(w)), height: Math.round(Number(h)) }
      if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) }
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** all of a site's text (source, styles, and a generated or static site's pages), for "what uses this photo" */
function referenceText(dir: string, kind: StudioKind): { file: string; body: string }[] {
  const files = new Set(sourceFiles(dir, kind, { styles: true, built: true }))
  const out: { file: string; body: string }[] = []
  for (const f of files) {
    try {
      out.push({ file: f, body: fs.readFileSync(f, 'utf8') })
    } catch {
      /* gone */
    }
  }
  return out
}

/** how a photo's name shows up when something uses it: with its extension, or bare in code (heroPicture('hero-general')) */
const usePattern = (file: string) => {
  const base = path.basename(file, path.extname(file))
  return new RegExp(`(^|[/"'\`(\\s=])${reEscape(base)}(\\.(?:jpe?g|png|webp|avif|gif|svg)|-\\d{3,4}\\.|["'\`)])`, 'i')
}

export function photoLibrary(dir: string, kind: StudioKind, root: string, devFs: boolean): LibraryPhoto[] {
  const skip = new Set([...SOURCE_SKIP, '_capture', 'release', 'build-v2', 'scripts', 'tools', ...sourcePhotoFolders(dir)])
  const places: { base: string; urlOf: (full: string) => string }[] = []
  if (kind === 'astro') {
    places.push({ base: path.join(dir, 'public'), urlOf: (f) => '/' + path.relative(path.join(dir, 'public'), f).split(path.sep).join('/') })
    // Astro's dev server serves any project file at /@fs/<path>
    if (devFs) places.push({ base: path.join(dir, 'src'), urlOf: (f) => `/@fs/${f.split(path.sep).join('/').replace(/^\//, '')}` })
  } else places.push({ base: root, urlOf: (f) => '/' + path.relative(root, f).split(path.sep).join('/') })
  const found: { full: string; url: string; group: string }[] = []
  for (const p of places) {
    const walkImg = (d: string, depth: number) => {
      if (depth > 7 || !fs.existsSync(d) || found.length > 3000) return
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || skip.has(e.name)) continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walkImg(full, depth + 1)
        else if (IMG.test(e.name)) found.push({ full, url: p.urlOf(full), group: path.relative(dir, d).split(path.sep).join('/') || 'Top folder' })
      }
    }
    walkImg(p.base, 0)
  }
  const refs = referenceText(dir, kind)
  // names built in code ('logo-' + slug, `hero-${name}`): a photo starting that way may well be used
  const built = new Set<string>()
  for (const r of refs) {
    for (const m of r.body.matchAll(/['"`]([\w./-]*?[\w]-)['"`]\s*\+/g)) built.add(path.basename(m[1]))
    for (const m of r.body.matchAll(/([\w./-]*?[\w]-)\$\{/g)) built.add(path.basename(m[1]))
  }
  return found.map((f) => {
    const re = usePattern(f.full)
    const self = f.full
    const base = path.basename(f.full)
    const named = [...built].some((b) => b.length >= 3 && base.startsWith(b))
    const uses = refs.filter((r) => r.file !== self && re.test(r.body)).length || (named ? -1 : 0)
    const size = imageSize(f.full)
    let bytes = 0
    try {
      bytes = fs.statSync(f.full).size
    } catch {
      /* gone */
    }
    return { path: path.relative(dir, f.full).split(path.sep).join('/'), url: f.url, group: f.group, bytes, width: size?.width ?? null, height: size?.height ?? null, uses }
  })
}

/** the pages (generated or static sites) or source files (Astro) that use a photo served at `url` */
export function photoUses(dir: string, kind: StudioKind, root: string, url: string): string[] {
  let file: string
  try {
    file = decodeURIComponent(new URL(url, 'http://x').pathname)
  } catch {
    return []
  }
  const re = usePattern(file)
  if (kind === 'astro') return sourceFiles(dir, kind).filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(dir, f).split(path.sep).join('/'))
  const pages: string[] = []
  const walkHtml = (d: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SOURCE_SKIP.has(e.name) || e.name === '_capture') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walkHtml(full, depth + 1)
      else if (/\.html$/i.test(e.name) && !/404\.html$/i.test(e.name)) {
        const body = fs.readFileSync(full, 'utf8')
        if (re.test(body)) pages.push('/' + path.relative(root, full).split(path.sep).join('/').replace(/(^|\/)index\.html$/, '$1'))
      }
    }
  }
  walkHtml(root, 0)
  return pages
}
