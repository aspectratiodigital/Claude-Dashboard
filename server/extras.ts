import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readJson } from './util.ts'
import { quoteForCmd } from './assistant.ts'

// The skills, plugins, slash commands and MCP servers your Claude Code
// already has, read from ~/.claude (and the project's own .claude folder), so
// the dashboard can list them and offer them in the "/" picker. Claude Code
// itself loads them when it runs; nothing here changes them, except adding
// one of the suggested MCP servers when you ask.

export interface Extra {
  /** what you type after "/" */
  name: string
  description: string
  kind: 'skill' | 'command'
  /** where it comes from: "You", "Account", "Project" or a plugin's name */
  source: string
}

export interface Extras {
  items: Extra[]
  plugins: { name: string; description: string; enabled: boolean; skills: number; commands: number; source: string }[]
  mcp: { name: string; type: string; scope: string }[]
  suggestions: { id: string; name: string; why: string }[]
}

const HOME = path.join(os.homedir(), '.claude')

function frontmatter(file: string): Record<string, string> {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 8000)
  } catch {
    return {}
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (!m) {
    const first = text.split('\n').find((l) => l.trim() && !l.startsWith('#'))
    if (first) out.description = first.trim()
    return out
  }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

const dirs = (p: string) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(p, d.name))
  } catch {
    return []
  }
}

/** SKILL.md files under a skills folder, a level or two down (account skills sit in skills/synced/<account>/). */
function skillsIn(root: string, depth = 3): string[] {
  const out: string[] = []
  for (const d of dirs(root)) {
    if (fs.existsSync(path.join(d, 'SKILL.md'))) out.push(path.join(d, 'SKILL.md'))
    else if (depth > 1) out.push(...skillsIn(d, depth - 1))
  }
  return out
}

function commandsIn(root: string, prefix = ''): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = []
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, d.name)
      if (d.isDirectory()) out.push(...commandsIn(p, `${prefix}${d.name}:`))
      else if (d.name.endsWith('.md')) out.push({ name: prefix + d.name.slice(0, -3), file: p })
    }
  } catch {
    /* no commands */
  }
  return out
}

/** Folders holding a plugin (.claude-plugin/plugin.json), from marketplaces and account sync. */
function pluginDirs(root: string, depth = 5): string[] {
  if (fs.existsSync(path.join(root, '.claude-plugin', 'plugin.json'))) return [root]
  if (depth <= 0) return []
  return dirs(root)
    .filter((d) => !path.basename(d).startsWith('.') || path.basename(d) === '.claude-plugin')
    .flatMap((d) => pluginDirs(d, depth - 1))
}

function mcpOf(file: string, scope: string): Extras['mcp'] {
  const j = readJson<{ mcpServers?: Record<string, { type?: string; url?: string }> }>(file, {})
  return Object.entries(j.mcpServers ?? {}).map(([name, s]) => ({ name, type: s?.type ?? (s?.url ? 'http' : 'stdio'), scope }))
}

export function listExtras(folder: string | null): Extras {
  const items: Extra[] = []
  const seen = new Set<string>()
  const add = (e: Extra) => {
    if (seen.has(e.name)) return
    seen.add(e.name)
    items.push(e)
  }
  const skill = (file: string, source: string, prefix = '') => {
    const fm = frontmatter(file)
    add({ name: prefix + (fm.name || path.basename(path.dirname(file))), description: fm.description ?? '', kind: 'skill', source })
  }

  if (folder) {
    for (const f of skillsIn(path.join(folder, '.claude', 'skills'), 1)) skill(f, 'Project')
    for (const c of commandsIn(path.join(folder, '.claude', 'commands'))) add({ name: c.name, description: frontmatter(c.file).description ?? '', kind: 'command', source: 'Project' })
  }
  for (const f of skillsIn(path.join(HOME, 'skills'))) skill(f, f.includes(`${path.sep}synced${path.sep}`) ? 'Account' : 'You')
  for (const c of commandsIn(path.join(HOME, 'commands'))) add({ name: c.name, description: frontmatter(c.file).description ?? '', kind: 'command', source: 'You' })

  const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(HOME, 'settings.json'), {})
  const enabled = settings.enabledPlugins ?? {}
  const plugins: Extras['plugins'] = []
  const pluginNames = new Set<string>()
  for (const dir of pluginDirs(path.join(HOME, 'plugins'))) {
    const meta = readJson<{ name?: string; description?: string }>(path.join(dir, '.claude-plugin', 'plugin.json'), {})
    const name = meta.name ?? path.basename(dir)
    if (pluginNames.has(name)) continue
    pluginNames.add(name)
    const synced = dir.includes(`${path.sep}synced${path.sep}`)
    const on = synced || Object.entries(enabled).some(([k, v]) => v && k.split('@')[0] === name)
    const sk = skillsIn(path.join(dir, 'skills'), 1)
    const cmds = commandsIn(path.join(dir, 'commands'))
    plugins.push({ name, description: meta.description ?? '', enabled: on, skills: sk.length, commands: cmds.length, source: synced ? 'Account' : 'Marketplace' })
    if (!on) continue
    for (const f of sk) skill(f, name, `${name}:`)
    for (const c of cmds) add({ name: `${name}:${c.name}`, description: frontmatter(c.file).description ?? '', kind: 'command', source: name })
  }

  const user = readJson<{ mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }>(path.join(os.homedir(), '.claude.json'), {})
  const mcp: Extras['mcp'] = Object.entries(user.mcpServers ?? {}).map(([name, s]) => ({ name, type: (s as { type?: string })?.type ?? 'stdio', scope: 'You' }))
  if (folder) {
    const local = Object.entries(user.projects ?? {}).find(([k]) => path.resolve(k).toLowerCase() === path.resolve(folder).toLowerCase())?.[1]
    mcp.push(...Object.entries(local?.mcpServers ?? {}).map(([name, s]) => ({ name, type: (s as { type?: string })?.type ?? 'stdio', scope: 'This computer' })))
    mcp.push(...mcpOf(path.join(folder, '.mcp.json'), 'Project'))
  }

  const has = (re: RegExp) => mcp.some((m) => re.test(m.name)) || plugins.some((p) => p.enabled && re.test(p.name))
  const suggestions = SUGGESTED.filter((s) => !has(s.match)).map(({ id, name, why }) => ({ id, name, why }))
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { items, plugins, mcp, suggestions }
}

/** MCP servers worth having for this kind of work, added on request with `claude mcp add`. */
const SUGGESTED = [
  {
    id: 'shopify-dev',
    name: 'Shopify Dev MCP',
    why: "Shopify's docs and API schemas, so Claude writes correct Hydrogen and Storefront API code.",
    match: /shopify/i,
    args: ['mcp', 'add', '--scope', 'user', 'shopify-dev-mcp', '--', 'npx', '-y', '@shopify/dev-mcp@latest'],
  },
]

export function addSuggested(exe: string, id: string): Promise<{ ok: boolean; output: string }> {
  const s = SUGGESTED.find((x) => x.id === id)
  if (!s) return Promise.resolve({ ok: false, output: 'Unknown server' })
  return new Promise((resolve) => {
    const shim = /\.(cmd|bat)$/i.test(exe)
    const child = shim ? spawn([exe, ...s.args].map(quoteForCmd).join(' '), { shell: true, windowsHide: true }) : spawn(exe, s.args, { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (b: Buffer) => (out += b))
    child.stderr?.on('data', (b: Buffer) => (out += b))
    const t = setTimeout(() => child.kill(), 30_000)
    child.on('error', (e) => resolve({ ok: false, output: e.message }))
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ ok: code === 0, output: out.trim().slice(-600) })
    })
  })
}
