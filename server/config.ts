import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { DATA_DIR, ROOT, readJson, writeJsonNow } from './util.ts'

// jarvis.config.json (committed) holds safe defaults. Anything personal, like
// your GitHub token or per-project overrides, is saved to .jarvis/settings.json
// on your machine only.

export interface ProjectOverride {
  name?: string
  url?: string
  previewUrl?: string
  localPort?: number
  /** the project's folder on this computer, where the Claude bar works */
  folder?: string
  hidden?: boolean
  /** the site's Shopify store (xxx.myshopify.com), when the code doesn't name it */
  shopify?: string
  /** website or app, when set on the building */
  kind?: 'site' | 'app'
}

export interface Config {
  owner: string
  /** only show these repos (empty = every repo the token can see under owner) */
  include: string[]
  exclude: string[]
  pollSeconds: number
  auditHours: number
  auditPages: number
  uptimeMinutes: number
  projects: Record<string, ProjectOverride>
}

export interface Settings {
  githubToken?: string
  psiKey?: string
  owner?: string
  /** full path to the claude command, if it isn't on PATH */
  claudePath?: string
  projects?: Record<string, ProjectOverride>
  /** a folder (e.g. in OneDrive) shared with your other computers: chats, theme and site links sync through it */
  syncDir?: string
  /** Shopify access by store domain (an Admin API token, or a Dev Dashboard app's client ID + secret): this computer only, never synced */
  shopifyTokens?: Record<string, string | { id: string; secret: string } | null>
}

const DEFAULTS: Config = {
  owner: 'aspectratiodigital',
  include: [],
  exclude: [],
  pollSeconds: 60,
  auditHours: 12,
  auditPages: 8,
  uptimeMinutes: 5,
  projects: {},
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

export function loadConfig(): Config {
  const file = readJson<Partial<Config>>(path.join(ROOT, 'jarvis.config.json'), {})
  const settings = loadSettings()
  const projects: Record<string, ProjectOverride> = { ...(file.projects ?? {}) }
  for (const [k, v] of Object.entries(projectSettings(settings))) projects[k] = { ...projects[k], ...v }
  const include = process.env.JARVIS_INCLUDE ? process.env.JARVIS_INCLUDE.split(',').map((s) => s.trim()) : (file.include ?? [])
  return { ...DEFAULTS, ...file, include, owner: settings.owner || file.owner || DEFAULTS.owner, projects }
}

export function loadSettings(): Settings {
  return readJson<Settings>(SETTINGS_FILE, {})
}

/**
 * This computer's project overrides with the ones shared through the sync
 * folder on top: the last site links saved on any computer win, but the
 * project folder always comes from this computer, since paths differ.
 */
export function projectSettings(settings = loadSettings()): Record<string, ProjectOverride> {
  const out: Record<string, ProjectOverride> = { ...(settings.projects ?? {}) }
  const shared = settings.syncDir ? readJson<{ projects?: Record<string, ProjectOverride> }>(path.join(settings.syncDir, 'shared.json'), {}).projects : undefined
  for (const [k, { folder: _, ...v }] of Object.entries(shared ?? {})) out[k] = { ...out[k], ...v }
  return out
}

export function saveSettings(patch: Settings) {
  const cur = loadSettings()
  const next: Settings = { ...cur, ...patch }
  if (patch.shopifyTokens) {
    next.shopifyTokens = { ...(cur.shopifyTokens ?? {}), ...patch.shopifyTokens }
    for (const [k, v] of Object.entries(next.shopifyTokens)) if (!v) delete next.shopifyTokens[k]
  }
  if (patch.projects) {
    next.projects = { ...(cur.projects ?? {}) }
    for (const [k, v] of Object.entries(patch.projects)) next.projects[k] = { ...next.projects[k], ...v }
  }
  // empty strings clear a value
  for (const k of ['githubToken', 'psiKey', 'owner', 'syncDir'] as const) if (next[k] === '') delete next[k]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  writeJsonNow(SETTINGS_FILE, next)
  return next
}

let ghCache: { token: string | null; at: number } | null = null

/** GitHub CLI fallback: if `gh` is installed and signed in, borrow its token. */
export function ghToken(): Promise<string | null> {
  if (ghCache && Date.now() - ghCache.at < 10 * 60_000) return Promise.resolve(ghCache.token)
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 4000, windowsHide: true }, (err, out) => {
      const token = err ? null : out.trim() || null
      ghCache = { token, at: Date.now() }
      resolve(token)
    })
  })
}

let ghHere: Promise<boolean> | null = null
/** Whether the GitHub CLI is installed here, so Claude can use it for pull requests and Actions logs. */
export function ghInstalled(): Promise<boolean> {
  ghHere ??= new Promise((resolve) => execFile('gh', ['--version'], { timeout: 4000, windowsHide: true }, (err) => resolve(!err)))
  return ghHere
}

export async function githubAuth(): Promise<{ token: string | null; source: 'token' | 'gh' | 'none' }> {
  const s = loadSettings()
  if (s.githubToken) return { token: s.githubToken, source: 'token' }
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'token' }
  const gh = await ghToken()
  if (gh) return { token: gh, source: 'gh' }
  return { token: null, source: 'none' }
}

export function psiKey() {
  return loadSettings().psiKey || process.env.PAGESPEED_API_KEY || null
}
