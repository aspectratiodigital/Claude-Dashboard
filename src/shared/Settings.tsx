import { useEffect, useState } from 'react'
import { useData } from '../data/store'
import { useApp, type Quality } from '../store'
import { detectTier, resolveTier, TIERS } from './quality'
import { Icon } from './icons'

// Settings: connect GitHub, per-project URLs and ports, rendering quality.
// Secrets go to the local API, which keeps them in .jarvis/settings.json on
// this computer (that folder is gitignored).

interface Remote {
  owner: string
  github: 'token' | 'gh' | 'none'
  login: string | null
  hasToken: boolean
  psi: boolean
  projects: Record<string, { name?: string; url?: string; previewUrl?: string; localPort?: number; folder?: string; hidden?: boolean }>
}

const PERMS = ['contents', 'metadata', 'pull_requests', 'issues', 'actions', 'deployments', 'statuses'].map((p) => `${p}=read`).join('&')

export function tokenLink(owner: string) {
  const q = `name=Jarvis+Dashboard&description=${encodeURIComponent('Read-only access for the Aspect Ratio Digital dashboard')}&target_name=${encodeURIComponent(owner)}&expires_in=366&${PERMS}`
  return `https://github.com/settings/personal-access-tokens/new?${q}`
}

export function Settings() {
  const open = useApp((s) => s.settingsOpen)
  const setOpen = useApp((s) => s.setSettings)
  const quality = useApp((s) => s.quality)
  const setQuality = useApp((s) => s.setQuality)
  const showFps = useApp((s) => s.showFps)
  const toggleFps = useApp((s) => s.toggleFps)
  const { api, mode, projects, setup, rate, errors } = useData()
  const save = useData((s) => s.saveSettings)
  const refresh = useData((s) => s.refresh)
  const [remote, setRemote] = useState<Remote | null>(null)
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [psi, setPsi] = useState('')
  const [rows, setRows] = useState<Remote['projects']>({})
  const [saved, setSaved] = useState('')

  useEffect(() => {
    if (!open || !api) return
    fetch('./api/settings')
      .then((r) => r.json())
      .then((r: Remote) => {
        setRemote(r)
        setOwner(r.owner)
        setRows(r.projects ?? {})
      })
      .catch(() => {})
  }, [open, api, setup?.github])

  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, setOpen])

  if (!open) return null
  const gpu = detectTier()
  const tier = resolveTier(quality)
  const repoName = (repo: string) => repo.split('/')[1]
  const flash = (m: string) => {
    setSaved(m)
    window.setTimeout(() => setSaved(''), 2500)
  }

  const saveGithub = async () => {
    const ok = await save({ githubToken: token, owner })
    setToken('')
    flash(ok ? 'Saved. Loading your projects…' : 'Could not reach the local API')
  }
  const saveProjects = async () => {
    const ok = await save({ projects: rows })
    flash(ok ? 'Project settings saved' : 'Could not reach the local API')
  }
  const row = (name: string) => rows[name] ?? {}
  const setRow = (name: string, patch: Remote['projects'][string]) => setRows((r) => ({ ...r, [name]: { ...r[name], ...patch } }))

  return (
    <div className="modal-scrim" onMouseDown={() => setOpen(false)}>
      <div className="modal settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          {saved && <span className="settings-saved">{saved}</span>}
          <button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
            <Icon.close size={16} />
          </button>
        </header>

        <div className="settings-body">
          <section>
            <h3>
              <Icon.github size={16} /> Your projects
            </h3>
            {!api ? (
              <p className="settings-note">
                The local API isn't running, so you're seeing demo data. Start the dashboard with <code>npm run dev</code> (or <code>npm start</code>) and open it at <code>http://localhost:5173</code>.
              </p>
            ) : (
              <>
                <p className="settings-status" data-ok={setup?.github !== 'none'}>
                  {setup?.github === 'none'
                    ? 'Not connected: showing demo projects.'
                    : `Connected as ${setup?.login ?? 'you'}${setup?.github === 'gh' ? ' through the GitHub CLI' : ''}. ${projects.length} project${projects.length === 1 ? '' : 's'} from ${setup?.owner}.`}
                  {rate && mode === 'live' ? ` API budget ${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()}.` : ''}
                </p>
                {errors.map((e) => (
                  <p key={e} className="settings-error">
                    {e}
                  </p>
                ))}
                <p className="settings-note">
                  claude.ai doesn't offer an API for Projects yet, so the dashboard reads the GitHub repos your projects work in. It picks out Claude's branches and pull requests, links each thread back to its Claude project, and adds any Claude Code sessions on this computer.
                </p>
                <ol className="settings-steps">
                  <li>
                    <a href={tokenLink(owner || setup?.owner || 'aspectratiodigital')} target="_blank" rel="noreferrer">
                      Create a read-only GitHub token <Icon.external size={12} />
                    </a>{' '}
                    (the permissions are filled in for you).
                  </li>
                  <li>
                    Under <b>Repository access</b>, choose <b>All repositories</b>, then generate it.
                  </li>
                  <li>Paste it here. It stays on this computer.</li>
                </ol>
                <div className="settings-row">
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={remote?.hasToken ? 'Token saved. Paste a new one to replace it' : 'github_pat_…'} aria-label="GitHub token" />
                  <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="GitHub owner" aria-label="GitHub owner" className="settings-owner" />
                  <button className="settings-btn" onClick={saveGithub} disabled={!token && owner === remote?.owner}>
                    Connect
                  </button>
                </div>
                <p className="settings-note">Signed in to the GitHub CLI? Run <code>gh auth login</code> once and the dashboard uses it, no token needed.</p>
              </>
            )}
          </section>

          {api && mode === 'live' && projects.length > 0 && (
            <section>
              <h3>
                <Icon.layers size={16} /> Project links
              </h3>
              <p className="settings-note">Found automatically from each repo's website field, its deploys and its framework. Override anything here.</p>
              <div className="settings-table">
                <div className="settings-th">
                  <span>Project</span>
                  <span>Live URL</span>
                  <span>Preview URL</span>
                  <span>Local port</span>
                  <span>Folder</span>
                  <span>Show</span>
                </div>
                {projects.map((p) => {
                  const name = repoName(p.repo)
                  const r = row(name)
                  return (
                    <div key={p.id} className="settings-tr">
                      <span title={p.repo}>
                        <i style={{ background: p.accent }} />
                        {p.name}
                      </span>
                      <input value={r.url ?? ''} placeholder={p.url ?? 'https://'} onChange={(e) => setRow(name, { url: e.target.value })} aria-label={`${p.name} live URL`} />
                      <input value={r.previewUrl ?? ''} placeholder={p.previewUrl ?? 'https://'} onChange={(e) => setRow(name, { previewUrl: e.target.value })} aria-label={`${p.name} preview URL`} />
                      <input
                        value={r.localPort ?? ''}
                        placeholder={p.localPort ? String(p.localPort) : '–'}
                        inputMode="numeric"
                        onChange={(e) => setRow(name, { localPort: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined })}
                        aria-label={`${p.name} local port`}
                      />
                      <input value={r.folder ?? ''} placeholder={'D:\\...'} onChange={(e) => setRow(name, { folder: e.target.value || undefined })} aria-label={`${p.name} folder on this computer`} title="Where this project lives on this computer, for the Claude bar" />
                      <input type="checkbox" checked={!r.hidden} onChange={(e) => setRow(name, { hidden: !e.target.checked })} aria-label={`Show ${p.name}`} />
                    </div>
                  )
                })}
              </div>
              <div className="settings-actions">
                <button className="settings-btn" onClick={saveProjects}>
                  Save project links
                </button>
                <button className="settings-btn ghost" onClick={refresh}>
                  <Icon.refresh size={14} /> Refresh now
                </button>
              </div>
            </section>
          )}

          <section>
            <h3>
              <Icon.speed size={16} /> Performance
            </h3>
            <div className="settings-quality" role="radiogroup" aria-label="Rendering quality">
              {(['auto', 'high', 'balanced', 'battery'] as Quality[]).map((q) => (
                <button key={q} role="radio" aria-checked={quality === q} onClick={() => setQuality(q)}>
                  <b>{q === 'auto' ? `Auto (${TIERS[gpu.tier].label})` : TIERS[q].label}</b>
                  <small>
                    {q === 'auto'
                      ? gpu.gpu
                        ? gpu.gpu.replace(/^ANGLE \(|\)$/g, '').slice(0, 48)
                        : 'Picks from your graphics chip'
                      : q === 'high'
                        ? 'Full resolution and effects'
                        : q === 'balanced'
                          ? 'Best for laptops'
                          : 'Lowest power use'}
                  </small>
                </button>
              ))}
            </div>
            <label className="settings-check">
              <input type="checkbox" checked={showFps} onChange={toggleFps} /> Show frame rate (F)
            </label>
            <p className="settings-note">
              Running at {TIERS[tier].label.toLowerCase()}. Scenes pause behind fullscreen previews and drop to 30fps after 20 seconds without input on laptop settings.
            </p>
          </section>

          {api && (
            <section>
              <h3>
                <Icon.pulse size={16} /> Site checks
              </h3>
              <p className="settings-note">
                Every few minutes the dashboard loads each live site once to time it and read its SEO tags. That's free and needs nothing. For full Lighthouse scores, paste a free PageSpeed Insights key (optional).
              </p>
              <div className="settings-row">
                <input type="password" value={psi} onChange={(e) => setPsi(e.target.value)} placeholder={remote?.psi ? 'Key saved' : 'Optional PageSpeed API key'} aria-label="PageSpeed key" />
                <button
                  className="settings-btn"
                  disabled={!psi}
                  onClick={async () => {
                    const ok = await save({ psiKey: psi })
                    setPsi('')
                    flash(ok ? 'Key saved' : 'Could not reach the local API')
                  }}
                >
                  Save
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
