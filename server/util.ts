import fs from 'node:fs'
import path from 'node:path'

// Everything the dashboard remembers locally lives in .jarvis/ (gitignored):
// settings, the last project state, notifications, audits and screenshots.
// The desktop app points JARVIS_DATA_DIR at its own user-data folder instead.
export const ROOT = process.env.JARVIS_ROOT || process.cwd()
export const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(ROOT, '.jarvis')
export const SHOTS_DIR = path.join(DATA_DIR, 'shots')

export function ensureDirs() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const pending = new Map<string, NodeJS.Timeout>()

/** Debounced atomic JSON write so frequent state changes don't thrash the disk. */
export function writeJson(file: string, data: unknown, delay = 400) {
  clearTimeout(pending.get(file))
  pending.set(
    file,
    setTimeout(() => writeJsonNow(file, data), delay),
  )
}

/** Write straight away, so the next read sees it. */
export function writeJsonNow(file: string, data: unknown) {
  clearTimeout(pending.get(file))
  pending.delete(file)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch (e) {
    log('could not write', file, (e as Error).message)
  }
}

export function log(...args: unknown[]) {
  console.log('\x1b[36m[jarvis]\x1b[0m', ...args)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const now = () => new Date().toISOString()

export const ago = (iso: string | null | undefined) => (iso ? Date.now() - Date.parse(iso) : Infinity)

/** "kings-hill-dental" / "Kings-Hill-Dental" / "BAU_Drinks" -> "Kings Hill Dental", "BAU Drinks" */
export function prettyName(repo: string) {
  return repo
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Stable, pleasant accent colour from a string (used until we learn the site's theme-color). */
export function hashColor(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const hue = h % 360
  return hslToHex(hue, 62, 58)
}

function hslToHex(h: number, s: number, l: number) {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

export function normaliseUrl(u: string | null | undefined): string | null {
  if (!u) return null
  let s = u.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const url = new URL(s)
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
}
