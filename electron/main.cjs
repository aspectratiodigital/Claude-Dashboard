// Electron entry: a single window that hosts the dashboard.
// In dev it loads the Vite server (VITE_DEV_SERVER_URL). Otherwise it starts the
// bundled local API and file server (dist-electron/server.mjs) and loads that,
// so the installed app shows your live projects with nothing else running.
const { app, BrowserWindow, shell, dialog } = require('electron')
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
    shell.openExternal(url)
    return { action: 'deny' }
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
