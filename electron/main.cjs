// Electron entry: a single window that hosts the dashboard.
// In dev it loads the Vite server (VITE_DEV_SERVER_URL). Otherwise it starts the
// bundled local API and file server (dist-electron/server.mjs) and loads that,
// so the installed app shows your live projects with nothing else running.
const { app, BrowserWindow, Menu, shell, dialog, nativeTheme, session } = require('electron')
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

// Screenshots of an app's live web build for its floors (server/shots.ts): a hidden phone-sized window,
// given a few seconds to draw its 3D scenes.
globalThis.blueprintCapture = async (url, { width, height }) => {
  const w = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  try {
    w.webContents.setAudioMuted(true)
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await w.loadURL(url)
    await new Promise((r) => setTimeout(r, 4000))
    const img = await w.webContents.capturePage()
    if (img.isEmpty()) throw new Error('The page drew nothing')
    return img.toJPEG(82)
  } finally {
    w.destroy()
  }
}

// Studio's screenshots (server/shots.ts pageShot): any size, sharp (2x) for sending to clients, and the
// whole page when asked. Chromium's own screenshot command (through the debugger) can capture past the
// bottom of the window, which capturePage can't.
globalThis.blueprintShot = async (url, { width, height, full, scale = 1, type = 'png', mobile = false }) => {
  const w = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const dbg = w.webContents.debugger
  try {
    w.webContents.setAudioMuted(true)
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    dbg.attach('1.3')
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile })
    if (mobile) await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true }).catch(() => {})
    await w.loadURL(url)
    const js = (code) => w.webContents.executeJavaScript(code, true).catch(() => null)
    // Studio's script sets __studioReady once the page's edits are in
    for (let i = 0; i < 60 && !(await js('!window.__studioOps || !!window.__studioReady')); i++) await new Promise((r) => setTimeout(r, 250))
    await js('document.fonts ? document.fonts.ready.then(() => true) : true')
    if (full) {
      // scroll through so photos that load late and reveal-on-scroll sections show
      await js(`(async () => {
        const h = () => document.documentElement.scrollHeight
        for (let y = 0; y < h() && y < 40000; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)) }
        scrollTo(0, h()); await new Promise((r) => setTimeout(r, 400)); scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300))
      })()`)
    }
    await new Promise((r) => setTimeout(r, 1200))
    const tall = full ? Math.min(Number(await js('document.documentElement.scrollHeight')) || height, 16000) : height
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: type,
      ...(type === 'jpeg' ? { quality: 85 } : {}),
      captureBeyondViewport: !!full,
      clip: { x: 0, y: 0, width, height: tall, scale: 1 },
    })
    return Buffer.from(shot.data, 'base64')
  } finally {
    try {
      dbg.detach()
    } catch {
      /* already gone */
    }
    w.destroy()
  }
}

/** Right-click in the app: spelling suggestions (British English) on words you're editing, and cut, copy and paste. */
function contextMenu(win) {
  win.webContents.on('context-menu', (_e, p) => {
    const items = []
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 6)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
      if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
      items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
    }
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' })
    else if (p.selectionText.trim()) items.push({ role: 'copy' })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
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

  // a file dropped where nothing takes it would replace the app with that file
  const noFiles = (e, u) => {
    if (/^file:/i.test(u)) e.preventDefault()
  }
  win.webContents.on('will-navigate', noFiles)
  win.webContents.on('will-frame-navigate', (e) => noFiles(e, e.url))
  contextMenu(win)

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
  // Studio checks spelling in British English as you edit a site's words
  try {
    session.defaultSession.setSpellCheckerLanguages(['en-GB'])
  } catch {
    /* macOS uses the system's own languages */
  }
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
