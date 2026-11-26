import { useCallback, useEffect, useState } from 'react'
import type { Connections } from '../data/studio-api'
import { Icon } from './icons'
import { getJson, post, q } from './StudioUi'

// Studio's connections to other services: stock photo keys, a Google service
// account (Search Console and Analytics) and each site's Krystal cPanel. The
// keys are kept on this computer by the local server and never come back to
// the browser: the forms only learn whether one is set.

export function useConnections(projectId?: string) {
  const [conn, setConn] = useState<Connections | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    getJson<Connections>(`./api/studio/connections?${q({ project: projectId })}`)
      .then((c) => {
        setConn(c)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  }, [projectId])
  useEffect(reload, [reload])
  const save = useCallback(async (patch: Record<string, unknown>) => {
    const c = await post<Connections>('./api/studio/connections', patch)
    setConn((old) => ({ ...old, ...c }))
    return c
  }, [])
  return { conn, error, reload, save }
}

type Save = (patch: Record<string, unknown>) => Promise<Connections>

function useSaving() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: ok })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return { busy, msg, run }
}

const Msg = ({ m }: { m: { ok: boolean; text: string } | null }) => (m ? <p className={m.ok ? 'st-ok' : 'st-error'}>{m.text}</p> : null)

/** a Google Cloud service account, for Search Console and Analytics */
export function GoogleConnect({ conn, save }: { conn: Connections; save: Save }) {
  const [key, setKey] = useState('')
  const { busy, msg, run } = useSaving()
  if (conn.google)
    return (
      <div className="st-connect">
        <p>
          <Icon.check size={13} /> Connected as <code>{conn.google}</code>
        </p>
        <p className="st-tip">Each site’s Search Console and Analytics need this address added as a user (read access is enough).</p>
        <button className="st-link" disabled={busy} onClick={() => run(() => save({ google: null }), 'Disconnected.')}>
          Disconnect Google
        </button>
        <Msg m={msg} />
      </div>
    )
  return (
    <div className="st-connect">
      <ol className="st-steps">
        <li>
          In{' '}
          <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noreferrer">
            Google Cloud
          </a>
          , make a service account and download a JSON key for it.
        </li>
        <li>Turn on the Search Console API, Analytics Data API and Analytics Admin API for that project.</li>
        <li>Add the service account’s email as a user in each site’s Search Console (Restricted) and Analytics (Viewer).</li>
        <li>Paste the key file below. It stays on this computer.</li>
      </ol>
      <textarea value={key} onChange={(e) => setKey(e.target.value)} rows={4} placeholder='{ "type": "service_account", … }' spellCheck={false} className="st-code" aria-label="Service account key file" />
      <button className="st-primary" disabled={busy || !key.trim()} onClick={() => run(() => save({ google: key }).then(() => setKey('')), 'Connected.')}>
        {busy ? 'Checking…' : 'Connect Google'}
      </button>
      <Msg m={msg} />
    </div>
  )
}

/** which Search Console property and GA4 property belong to a site (found by itself when left empty) */
export function SiteGoogleIds({ conn, save, projectId }: { conn: Connections; save: Save; projectId: string }) {
  const [sc, setSc] = useState(conn.site?.searchConsole ?? '')
  const [ga, setGa] = useState(conn.site?.ga4 ?? '')
  const { busy, msg, run } = useSaving()
  useEffect(() => {
    setSc(conn.site?.searchConsole ?? '')
    setGa(conn.site?.ga4 ?? '')
  }, [conn.site?.searchConsole, conn.site?.ga4])
  return (
    <div className="st-connect">
      <label className="st-cfield">
        <span>Search Console property</span>
        <input value={sc} onChange={(e) => setSc(e.target.value)} placeholder="Found by itself, or sc-domain:example.co.uk" spellCheck={false} />
      </label>
      <label className="st-cfield">
        <span>GA4 property id</span>
        <input value={ga} onChange={(e) => setGa(e.target.value)} placeholder="Found by itself, or a number like 412345678" spellCheck={false} inputMode="numeric" />
      </label>
      <button className="st-pill" disabled={busy || (sc === (conn.site?.searchConsole ?? '') && ga === (conn.site?.ga4 ?? ''))} onClick={() => run(() => save({ site: { id: projectId, searchConsole: sc, ga4: ga } }), 'Saved.')}>
        Save
      </button>
      <Msg m={msg} />
    </div>
  )
}

/** a site's Krystal cPanel, for the deploy button */
export function KrystalConnect({ conn, save, projectId, onDone }: { conn: Connections; save: Save; projectId: string; onDone?: () => void }) {
  const k = conn.site?.krystal
  const [host, setHost] = useState(k?.host ?? '')
  const [user, setUser] = useState(k?.user ?? '')
  const [token, setToken] = useState('')
  const [repoRoot, setRepoRoot] = useState(k?.repoRoot ?? '')
  const [branch, setBranch] = useState(k?.branch ?? '')
  const { busy, msg, run } = useSaving()
  return (
    <div className="st-connect">
      <p className="st-tip">
        In cPanel: <b>Manage API Tokens</b> makes a token, and <b>Git Version Control</b> shows the repository’s path. Studio checks them with cPanel before saving.
      </p>
      <label className="st-cfield">
        <span>cPanel server</span>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="e.g. uk-yourserver.krystal.uk" spellCheck={false} />
      </label>
      <label className="st-cfield">
        <span>cPanel username</span>
        <input value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="st-cfield">
        <span>API token</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={k?.token ? 'Saved (type a new one to change it)' : ''} autoComplete="new-password" />
      </label>
      <label className="st-cfield">
        <span>Repository path</span>
        <input value={repoRoot} onChange={(e) => setRepoRoot(e.target.value)} placeholder="/home/username/repositories/site" spellCheck={false} />
      </label>
      <label className="st-cfield">
        <span>Branch (optional)</span>
        <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="The site’s default branch" spellCheck={false} />
      </label>
      <div className="st-row">
        <button
          className="st-primary"
          disabled={busy || !host.trim() || !user.trim() || !repoRoot.trim() || (!token.trim() && !k?.token)}
          onClick={() =>
            run(async () => {
              await save({ site: { id: projectId, krystal: { host, user, repoRoot, branch, ...(token.trim() ? { token } : {}) } } })
              setToken('')
              onDone?.()
            }, 'Connected to cPanel.')
          }
        >
          {busy ? 'Checking with cPanel…' : k ? 'Save' : 'Connect'}
        </button>
        {k && (
          <button className="st-link" disabled={busy} onClick={() => run(() => save({ site: { id: projectId, krystal: null } }).then(() => onDone?.()), 'Disconnected.')}>
            Disconnect
          </button>
        )}
      </div>
      <Msg m={msg} />
    </div>
  )
}

/** keys for the stock photo libraries (Openverse needs none) */
export function StockKeys({ conn, save }: { conn: Connections; save: Save }) {
  const [unsplash, setUnsplash] = useState('')
  const [pexels, setPexels] = useState('')
  const { busy, msg, run } = useSaving()
  return (
    <div className="st-connect">
      <p className="st-tip">
        Openverse works with no key. Free keys from{' '}
        <a href="https://unsplash.com/oauth/applications" target="_blank" rel="noreferrer">
          Unsplash
        </a>{' '}
        and{' '}
        <a href="https://www.pexels.com/api/" target="_blank" rel="noreferrer">
          Pexels
        </a>{' '}
        add their photos too.
      </p>
      <label className="st-cfield">
        <span>Unsplash access key {conn.unsplash && <em className="st-ok-tag">saved</em>}</span>
        <input type="password" value={unsplash} onChange={(e) => setUnsplash(e.target.value)} placeholder={conn.unsplash ? 'Saved (type a new one to change it)' : 'Optional'} autoComplete="off" />
      </label>
      <label className="st-cfield">
        <span>Pexels API key {conn.pexels && <em className="st-ok-tag">saved</em>}</span>
        <input type="password" value={pexels} onChange={(e) => setPexels(e.target.value)} placeholder={conn.pexels ? 'Saved (type a new one to change it)' : 'Optional'} autoComplete="off" />
      </label>
      <div className="st-row">
        <button
          className="st-pill"
          disabled={busy || (!unsplash.trim() && !pexels.trim())}
          onClick={() =>
            run(async () => {
              await save({ ...(unsplash.trim() ? { unsplashKey: unsplash } : {}), ...(pexels.trim() ? { pexelsKey: pexels } : {}) })
              setUnsplash('')
              setPexels('')
            }, 'Saved.')
          }
        >
          Save keys
        </button>
        {(conn.unsplash || conn.pexels) && (
          <button className="st-link" disabled={busy} onClick={() => run(() => save({ unsplashKey: '', pexelsKey: '' }), 'Keys removed.')}>
            Remove keys
          </button>
        )}
      </div>
      <Msg m={msg} />
    </div>
  )
}
