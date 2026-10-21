// Self-update for the installed app. Each launch it looks at the folder the app
// was built from (dist-electron/build-info.json): it pulls new commits, and if
// the code differs from what's installed it rebuilds the installer in the
// background with `npm run dist`. When that's done it offers to restart, or
// installs quietly when the app is next closed. Everything is logged to
// update.log in the app's data folder.
const { app, dialog, Notification } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const LOCK_MS = 30 * 60_000
let logFile = null
let pending = null

function log(line) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* logging is best effort */
  }
}

/** Run a command in the source folder. Fixed arguments only, so a shell is safe for npm.cmd. */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && /\.cmd$/i.test(cmd)
    let out = ''
    const child = spawn(cmd, args, { cwd, shell, windowsHide: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => resolve({ code: -1, out: String(e) }))
    child.on('close', (code) => {
      if (out.trim()) log(`${cmd} ${args.join(' ')}\n${out.trim().slice(-4000)}`)
      resolve({ code, out: out.trim() })
    })
  })
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'ARD Blueprint', body }).show()
}

function newestInstaller(dir) {
  const rel = path.join(dir, 'release')
  if (!fs.existsSync(rel)) return null
  const hits = fs
    .readdirSync(rel)
    .filter((f) => /^ARD Blueprint Setup .*\.exe$/i.test(f))
    .map((f) => path.join(rel, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0] ?? null
}

function install(setup, relaunch) {
  log(`installing ${setup}${relaunch ? ' and relaunching' : ''}`)
  const args = relaunch ? ['/S', '--force-run'] : ['/S']
  spawn(setup, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function check(win) {
  let info
  try {
    info = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist-electron', 'build-info.json'), 'utf8'))
  } catch {
    return
  }
  const src = info.sourceDir
  if (!src || !info.commit || !fs.existsSync(path.join(src, '.git'))) return

  // one update at a time, even if the app is opened twice in a row
  const lock = path.join(app.getPath('userData'), 'update.lock')
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) return
  } catch {
    /* no lock */
  }
  fs.writeFileSync(lock, String(process.pid))
  try {
    log(`checking ${src} (installed ${info.commit.slice(0, 7)})`)
    await run('git', ['fetch', '--quiet'], src)
    const pull = await run('git', ['pull', '--ff-only', '--quiet'], src)
    if (pull.code !== 0) log('git pull failed; checking local changes only')
    const head = (await run('git', ['rev-parse', 'HEAD'], src)).out
    if (!head || head === info.commit) return log('up to date')

    const changes = (await run('git', ['log', '--format=%s', '-n', '5', `${info.commit}..${head}`], src)).out
    log(`rebuilding for ${head.slice(0, 7)}`)
    notify('Updating in the background. Keep working, it takes a few minutes.')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    if ((await run(npm, ['ci'], src)).code !== 0 || (await run(npm, ['run', 'dist'], src)).code !== 0) {
      notify(`The update didn't build. Details are in ${logFile}`)
      return log('build failed')
    }
    const setup = newestInstaller(src)
    if (!setup) return log('no installer found after the build')
    pending = setup

    const choice = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'When I close it'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: 'A new version of ARD Blueprint is ready.',
      detail: changes ? `What's new:\n• ${changes.split('\n').join('\n• ')}` : undefined,
    })
    if (choice.response === 0) {
      pending = null
      install(setup, true)
      app.quit()
    }
  } catch (e) {
    log(`update check failed: ${e && e.stack ? e.stack : e}`)
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

/** Start the background check. Only for the installed Windows app. */
function startUpdater(win) {
  if (!app.isPackaged || process.platform !== 'win32') return
  logFile = path.join(app.getPath('userData'), 'update.log')
  app.on('will-quit', () => {
    if (pending) install(pending, false)
    pending = null
  })
  setTimeout(() => check(win), 5000)
}

module.exports = { startUpdater, _check: check, _setLog: (f) => (logFile = f) }
