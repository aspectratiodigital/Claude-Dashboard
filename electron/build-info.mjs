// Records where and from which commit the desktop app was built, so the
// installed app can find its source folder and rebuild itself when it changes
// (see electron/updater.cjs).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

let commit = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  /* not a git checkout: the app just won't self-update */
}
fs.mkdirSync('dist-electron', { recursive: true })
fs.writeFileSync('dist-electron/build-info.json', JSON.stringify({ sourceDir: process.cwd(), commit, builtAt: new Date().toISOString() }, null, 2))
