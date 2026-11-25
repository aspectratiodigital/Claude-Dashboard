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
  /** Studio's connections: stock photo keys, a Google service account, and per-site hosting and analytics */
  studio?: StudioSettings
}

export interface StudioKrystal {
  /** the cPanel server, e.g. uk1.krystal.uk */
  host: string
  user: string
  /** a cPanel API token (Manage API Tokens in cPanel) */
  token: string
  /** the repository's folder in cPanel's Git Version Control, e.g. /home/user/repositories/site */
  repoRoot: string
  /** the branch cPanel deploys (the site's default branch when empty) */
  branch?: string
}

export interface StudioSiteSettings {
  /** the Search Console property: sc-domain:example.com or https://www.example.com/ */
  searchConsole?: string
  /** the GA4 property id (numbers) */
  ga4?: string
  krystal?: StudioKrystal
}

export interface StudioSettings {
  unsplashKey?: string
  pexelsKey?: string
  /** a Google Cloud service account's key file (JSON), for Search Console and Analytics */
  google?: { client_email: string; private_key: string; project_id?: string }
  sites?: Record<string, StudioSiteSettings>
}

/** Studio's settings with every secret left out, for the browser */
export function studioPublic(projectId?: string) {
  const s = loadSettings().studio ?? {}
  const site = projectId ? s.sites?.[projectId] : undefined
  return {
    unsplash: !!s.unsplashKey,
    pexels: !!s.pexelsKey,
    google: s.google ? s.google.client_email : null,
    site: site
      ? {
          searchConsole: site.searchConsole ?? '',
          ga4: site.ga4 ?? '',
          krystal: site.krystal ? { host: site.krystal.host, user: site.krystal.user, repoRoot: site.krystal.repoRoot, branch: site.krystal.branch ?? '', token: !!site.krystal.token } : null,
        }
      : null,
  }
}

/** merge a change into Studio's settings: empty strings clear a value, null removes a site's Krystal connection */
export function saveStudioSettings(patch: { unsplashKey?: string; pexelsKey?: string; google?: StudioSettings['google'] | null; site?: { id: string; searchConsole?: string; ga4?: string; krystal?: Partial<StudioKrystal> | null } }) {
  const cur = loadSettings().studio ?? {}
  const next: StudioSettings = { ...cur, sites: { ...(cur.sites ?? {}) } }
  for (const k of ['unsplashKey', 'pexelsKey'] as const) {
    if (typeof patch[k] === 'string') {
      if (patch[k]) next[k] = patch[k]
      else delete next[k]
    }
  }
  if (patch.google === null) delete next.google
  else if (patch.google) next.google = patch.google
  if (patch.site) {
    const { id, krystal, ...rest } = patch.site
    const site: StudioSiteSettings = { ...(next.sites![id] ?? {}) }
    for (const [k, v] of Object.entries(rest) as [keyof typeof rest, string | undefined][]) {
      if (typeof v !== 'string') continue
      if (v) site[k] = v
      else delete site[k]
    }
    if (krystal === null) delete site.krystal
    else if (krystal) {
      const was = site.krystal
      // the token stays as it was unless a new one is given
      site.krystal = { host: krystal.host ?? was?.host ?? '', user: krystal.user ?? was?.user ?? '', token: krystal.token || was?.token || '', repoRoot: krystal.repoRoot ?? was?.repoRoot ?? '', branch: krystal.branch ?? was?.branch }
    }
    next.sites![id] = site
  }
  saveSettings({ studio: next })
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
