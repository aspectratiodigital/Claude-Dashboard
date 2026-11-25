// Electron entry: a single window that hosts the dashboard.
// In dev it loads the Vite server (VITE_DEV_SERVER_URL). Otherwise it starts the
// bundled local API and file server (dist-electron/server.mjs) and loads that,
// so the installed app shows your live projects with nothing else running.
const { app, BrowserWindow, shell, dialog, nativeTheme, session } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const { startUpdater } = require('./updater.cjs')

// Keep the GPU path fast for the 3D scene.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// Fixed port so the window's saved preferences (quality, layout) stick between launches.
const PORT = 47173
const ROOT = path.join(__dirname, '..')
let server = null

if (!app.requestSingleInstanceLock()) app.quit()
// lets Windows show the app's notifications (update progress) under its own name
if (process.platform === 'win32') app.setAppUserModelId('digital.aspectratio.blueprint')

// Live previews (an app's floors, a site's phone and desktop frames) show your sites inside the
// dashboard. Many sites send X-Frame-Options or a CSP frame-ancestors rule that would leave those
// frames blank, so they're dropped from pages loaded *as frames in this window*. Top-level pages and
// everything else keep their headers. server/frames.ts reads the flag so it doesn't warn about them.
globalThis.blueprintFramesAllowed = true
function allowFraming() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (d, done) => {
    if (d.resourceType !== 'subFrame' || !d.responseHeaders) return done({})
    const headers = {}
    for (const [k, v] of Object.entries(d.responseHeaders)) {
      const n = k.toLowerCase()
      if (n === 'x-frame-options') continue
      if (n === 'content-security-policy') {
        const kept = v.map((p) => p.split(';').filter((x) => !/^\s*frame-ancestors\b/i.test(x)).join(';')).filter((p) => p.trim())
        if (kept.length) headers[k] = kept
        continue
      }
      headers[k] = v
    }
    done({ responseHeaders: headers })
  })
}

async function startServer() {
  // Settings, token and notifications live in the app's own data folder.
  process.env.JARVIS_DATA_DIR = path.join(app.getPath('userData'), 'data')
  process.env.JARVIS_ROOT = ROOT
  const { serve } = await import(pathToFileURL(path.join(ROOT, 'dist-electron', 'server.mjs')).href)
  server = await serve({ dist: path.join(ROOT, 'dist'), port: PORT })
  return server.url
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#164a86',
    autoHideMenuBar: true,
    title: 'Aspect Ratio Digital · Blueprint',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // External links open in the default browser, not inside the dashboard.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // The title bar follows the dashboard's theme: black on Dark, white on Light, Windows' own on Blueprint.
  // The page announces its theme as <meta name="theme-color">.
  win.webContents.on('did-change-theme-color', (_e, color) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(color || '')
    if (!m) return (nativeTheme.themeSource = 'system')
    const n = parseInt(m[1], 16)
    const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    nativeTheme.themeSource = lum > 0.8 ? 'light' : lum < 0.15 ? 'dark' : 'system'
    win.setBackgroundColor(`#${m[1]}`)
  })

  win.loadURL(url)
  return win
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  allowFraming()
  let url = process.env.VITE_DEV_SERVER_URL
  if (!url) {
    try {
      url = await startServer()
    } catch (e) {
      dialog.showErrorBox('Blueprint could not start', String(e && e.stack ? e.stack : e))
      app.quit()
      return
    }
  }
  const win = createWindow(url)
  if (!process.env.VITE_DEV_SERVER_URL) startUpdater(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url)
  })
})

app.on('window-all-closed', () => {
  if (server) server.close()
  if (process.platform !== 'darwin') app.quit()
})
