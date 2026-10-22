import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './util.ts'
import { safeName } from './files.ts'
import { syncDir } from './sync.ts'

// Project knowledge, like a Claude project's: instructions Claude follows for
// one site (or for everything, under "_all") and files it can read. Kept in
// the sync folder when there is one, so both computers share them.

export interface Knowledge {
  instructions: string
  files: { name: string; size: number; updated: string }[]
}

const keyOk = (key: string) => key === '_all' || /^[a-z0-9][a-z0-9-]{0,80}$/.test(key)

export function knowledgeDir(key: string): string | null {
  if (!keyOk(key)) return null
  return path.join(syncDir() ?? DATA_DIR, 'knowledge', key)
}

export function readKnowledge(key: string): Knowledge {
  const dir = knowledgeDir(key)
  if (!dir) return { instructions: '', files: [] }
  let instructions = ''
  try {
    instructions = fs.readFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'utf8')
  } catch {
    /* none yet */
  }
  let files: Knowledge['files'] = []
  try {
    files = fs
      .readdirSync(path.join(dir, 'files'))
      .map((name) => {
        const st = fs.statSync(path.join(dir, 'files', name))
        return { name, size: st.size, updated: st.mtime.toISOString() }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    /* none yet */
  }
  return { instructions, files }
}

export function saveInstructions(key: string, text: string) {
  const dir = knowledgeDir(key)
  if (!dir) return false
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), text.slice(0, 40_000))
  return true
}

export function addKnowledgeFile(key: string, name: string, data: Buffer) {
  const dir = knowledgeDir(key)
  if (!dir) return null
  const file = safeName(name)
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'files', file), data)
  return file
}

export function removeKnowledgeFile(key: string, name: string) {
  const dir = knowledgeDir(key)
  if (!dir) return false
  fs.rmSync(path.join(dir, 'files', safeName(name)), { force: true })
  return true
}

/** What Claude is told about a project's knowledge, and the folders it may read. */
export function knowledgeFor(projectId: string | null): { text: string; dirs: string[] } {
  const out: string[] = []
  const dirs: string[] = []
  for (const key of projectId ? ['_all', projectId] : ['_all']) {
    const k = readKnowledge(key)
    const dir = knowledgeDir(key)!
    const scope = key === '_all' ? 'for all of Dylan’s work' : 'for this project'
    if (k.instructions.trim()) out.push(`Dylan's instructions ${scope}:\n${k.instructions.trim()}`)
    if (k.files.length) {
      dirs.push(path.join(dir, 'files'))
      out.push(`Knowledge files ${scope} (read the ones that help with the request):\n${k.files.map((f) => `- ${path.join(dir, 'files', f.name)}`).join('\n')}`)
    }
  }
  return { text: out.join('\n\n'), dirs }
}
