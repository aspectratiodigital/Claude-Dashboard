import { useEffect, type CSSProperties } from 'react'
import { FONTS, useApp } from './store'
import { useData } from './data/store'
import Blueprint from './concepts/blueprint/Blueprint'
import { CommandPalette } from './shared/CommandPalette'
import { FpsMeter } from './shared/FpsMeter'
import { NotesDrawer, Toasts, Tray } from './shared/Notifications'
import { Settings } from './shared/Settings'
import { Stage } from './shared/Preview'
import { useTier } from './shared/quality'
import './app.css'
import './shared/shell.css'

export default function App() {
  const setPalette = useApp((s) => s.setPalette)
  const toggleFps = useApp((s) => s.toggleFps)
  const selectedId = useApp((s) => s.selectedId)
  const theme = useApp((s) => s.theme)
  const fontId = useApp((s) => s.font)
  const font = FONTS.find((f) => f.id === fontId) ?? FONTS[0]
  useTier()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!useApp.getState().paletteOpen)
        return
      }
      if (e.key === 'Escape') {
        const s = useApp.getState()
        if (s.stage) s.closeStage()
        else if (s.settingsOpen) s.setSettings(false)
        else if (s.notesOpen) s.setNotes(false)
        else s.select(null)
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || useApp.getState().stage) return
      if (e.key === 'f' || e.key === 'F') toggleFps()
      if (e.key === 'n' || e.key === 'N') useApp.getState().setNotes(!useApp.getState().notesOpen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPalette, toggleFps])

  return (
    <div className="app" data-selected={!!selectedId} data-theme={theme} style={{ '--ui-font': font.text, '--ui-display': font.display } as CSSProperties}>
      <Blueprint />

      <Tray />
      <Toasts />
      <Banner />
      <NotesDrawer />

      <Settings />
      <CommandPalette />
      <Stage />
      <FpsMeter />
    </div>
  )
}

/** Tells you when you're looking at demo data, and how to get your real projects in. */
function Banner() {
  const mode = useData((s) => s.mode)
  const api = useData((s) => s.api)
  const setup = useData((s) => s.setup)
  const setSettings = useApp((s) => s.setSettings)
  if (mode === 'live') return null
  if (mode === 'loading' && setup?.github !== 'none' && api)
    return (
      <div className="banner" data-mode="loading">
        <i /> Loading your projects from GitHub…
      </div>
    )
  if (mode !== 'demo') return null
  return (
    <div className="banner">
      <i />
      {api ? 'Demo data. Connect GitHub to see your real projects' : 'Demo data. Run npm run dev to load your projects'}
      <button onClick={() => setSettings(true)}>{api ? 'Connect' : 'How'}</button>
    </div>
  )
}
