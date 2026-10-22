import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DATA_DIR, log } from './util.ts'

// Files in and out of Claude: what you attach to a message is saved under
// .jarvis/uploads (outside your project, so it never ends up in a commit)
// and handed to Claude Code with --add-dir. What Claude writes can be opened,
// shown in its folder or downloaded, but only from folders the dashboard
// knows about: project folders, Claude's workspace, uploads and knowledge.

export const UPLOADS = path.join(DATA_DIR, 'uploads')
export const WORKSPACE = path.join(DATA_DIR, 'claude-workspace')
export const MAX_UPLOAD = 25 * 1024 * 1024
const KEEP_DAYS = 30

export interface Upload {
  id: string
  name: string
  path: string
  size: number
  type: string
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
}
export const typeOf = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/** Files that run something when opened: these only get "Show in folder". */
const RUNS = /\.(exe|msi|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|scr|pif|reg|cpl|jar|sh|command|app|url)$/i
export const opensSafely = (file: string) => !RUNS.test(file)

/** A file name that's safe on every OS, keeping its extension. */
export function safeName(name: string) {
  const base = path.basename(name.replace(/\\/g, '/')).normalize('NFC')
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').slice(-120)
  return clean || 'file'
}

export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        resolve(null)
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', () => resolve(null))
  })
}

export function saveUpload(name: string, data: Buffer): Upload {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const file = safeName(name)
  fs.mkdirSync(path.join(UPLOADS, id), { recursive: true })
  fs.writeFileSync(path.join(UPLOADS, id, file), data)
  tidyUploads()
  return { id, name: file, path: path.join(UPLOADS, id, file), size: data.length, type: typeOf(file) }
}

/** The file behind an upload id, or null. */
export function uploadPath(id: string): string | null {
  if (!/^[a-z0-9]{6,24}$/.test(id)) return null
  try {
    const dir = path.join(UPLOADS, id)
    const name = fs.readdirSync(dir)[0]
    return name ? path.join(dir, name) : null
  } catch {
    return null
  }
}

let tidied = 0
function tidyUploads() {
  if (Date.now() - tidied < 6 * 3_600_000) return
  tidied = Date.now()
  try {
    for (const d of fs.readdirSync(UPLOADS)) {
      const p = path.join(UPLOADS, d)
      if (Date.now() - fs.statSync(p).mtimeMs > KEEP_DAYS * 86_400_000) fs.rmSync(p, { recursive: true, force: true })
    }
  } catch {
    /* nothing to tidy */
  }
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** The real path of `file` when it sits inside one of `roots`, else null. */
export function within(file: string, roots: string[]): string | null {
  if (!file || !path.isAbsolute(file)) return null
  let real: string
  try {
    real = fs.realpathSync(file)
  } catch {
    return null
  }
  for (const r of roots) {
    let root: string
    try {
      root = fs.realpathSync(r)
    } catch {
      continue
    }
    const rel = path.relative(norm(root), norm(real))
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real
  }
  return null
}

/** Send a file: inline for previews, or as a download. */
export function sendFile(res: ServerResponse, file: string, download: boolean) {
  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    res.statusCode = 404
    return res.end()
  }
  const type = typeOf(file)
  res.statusCode = 200
  // never render HTML or SVG from here: a page Claude wrote shouldn't run inside the dashboard
  const risky = /html|svg|javascript/.test(type)
  res.setHeader('Content-Type', risky && !download ? 'text/plain; charset=utf-8' : type)
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`)
  fs.createReadStream(file).pipe(res)
}

/** Open a file with its usual app, or show it in Explorer / Finder. */
export function openOnDesktop(file: string, reveal: boolean): boolean {
  if (!reveal && !opensSafely(file)) return false
  const run = (cmd: string, args: string[]) => {
    try {
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false })
      c.on('error', (e) => log('open failed', e.message))
      c.unref()
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') return reveal ? run('explorer.exe', ['/select,', file]) : run('explorer.exe', [file])
  if (process.platform === 'darwin') return run('open', reveal ? ['-R', file] : [file])
  return run('xdg-open', [reveal ? path.dirname(file) : file])
}
