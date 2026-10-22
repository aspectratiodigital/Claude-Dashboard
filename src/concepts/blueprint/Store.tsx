import { useState } from 'react'
import type { Project } from '../../data/types'
import { useData } from '../../data/store'
import { relTime } from '../../data/derive'
import { Sparkline } from '../../shared/bits'

// The shopfront on the side of a building: the Shopify store the site is
// built on. Orders, sales and low stock come from the local API, which holds
// the store's access on this computer only.

export function money(n: number, currency: string | null) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency ?? 'GBP', maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n)
  } catch {
    return n.toFixed(2)
  }
}

export const storeLine = (p: Project) => {
  const s = p.store
  if (!s) return ''
  if (!s.connected) return s.error ? 'needs attention' : 'not connected'
  return `${s.ordersToday} order${s.ordersToday === 1 ? '' : 's'} today · ${money(s.salesToday, s.currency)}`
}

export function StorePanel({ project: p }: { project: Project }) {
  const s = p.store
  const [editing, setEditing] = useState(false)
  if (!s) return <StoreConnect project={p} />
  const week = s.sales7.reduce((a, b) => a + b, 0)
  return (
    <>
      <p className="bp-help">
        {s.name ?? (s.domain || 'Shopify')} · {s.headless === 'Liquid theme' ? 'a Liquid theme' : s.headless ? `headless, built with ${s.headless}` : 'linked by hand'}
      </p>
      {s.connected ? (
        <>
          <div className="bp-kpis">
            <figure>
              <b>{s.ordersToday}</b>
              <figcaption>Orders today</figcaption>
            </figure>
            <figure>
              <b>{money(s.salesToday, s.currency)}</b>
              <figcaption>Sales today</figcaption>
            </figure>
            <figure>
              <b>{money(week, s.currency)}</b>
              <figcaption>Last 7 days</figcaption>
            </figure>
          </div>
          <p className="bp-spark">
            <Sparkline data={s.sales7} width={240} height={34} fill />
            <span>Sales by day, oldest first</span>
          </p>
          <h4>Recent orders</h4>
          <ul className="bp-runs">
            {s.orders.map((o) => (
              <li key={o.id} data-state={o.status === 'Fulfilled' ? 'success' : 'running'}>
                <a href={o.url} target="_blank" rel="noreferrer">
                  <i />
                  <b>
                    {o.name} · {money(o.total, s.currency)}
                  </b>
                  <span>
                    {o.status} · {relTime(o.at)}
                  </span>
                </a>
              </li>
            ))}
            {!s.orders.length && <li className="bp-help">No orders in the last week.</li>}
          </ul>
          <h4>Low stock</h4>
          <ul className="bp-runs">
            {s.lowStock.map((x) => (
              <li key={x.title} data-state={x.qty <= 0 ? 'failure' : 'queued'}>
                <a href={x.url} target="_blank" rel="noreferrer">
                  <i />
                  <b>{x.title}</b>
                  <span>{x.qty <= 0 ? 'Sold out' : `${x.qty} left`}</span>
                </a>
              </li>
            ))}
            {!s.lowStock.length && <li className="bp-help">Nothing under 5 in stock{s.products !== null ? ` across ${s.products} products` : ''}.</li>}
          </ul>
          <p className="bp-help">Checked {relTime(s.checked)}. New orders and low stock also arrive as notifications.</p>
        </>
      ) : (
        <p className="bp-help">{s.error ?? (s.domain ? `This site is built on ${s.domain}. Connect it to see orders, sales and stock here.` : `This site is built on Shopify, but its code doesn't name the store. Add the store's address below to attach it.`)}</p>
      )}
      <div className="bp-actions">
        <a className="bp-open" href={s.adminUrl} target="_blank" rel="noreferrer">
          Shopify admin <span>orders, products, themes</span>
        </a>
        <button className="bp-link" onClick={() => setEditing((v) => !v)}>
          {s.connected ? 'Change access' : editing ? 'Hide' : 'Connect'}
        </button>
      </div>
      {(editing || (!s.connected && !s.error)) && <StoreConnect project={p} />}
    </>
  )
}

/** Attach a store to a site, with access from a Dev Dashboard app or an Admin API token. */
export function StoreConnect({ project: p }: { project: Project }) {
  const mode = useData((s) => s.mode)
  const [domain, setDomain] = useState(p.store?.domain ?? '')
  const [how, setHow] = useState<'app' | 'token'>('app')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (body: Record<string, string | null>) => {
    if (mode !== 'live') return setMsg('This is demo data. Connect GitHub in Settings first, then attach the real store.')
    setBusy(true)
    setMsg('')
    try {
      const r = await fetch('./api/shopify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.id, domain, ...body }) })
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      setMsg(r.ok ? (body.token === null ? 'Disconnected' : 'Connected. The shopfront will fill in a moment.') : (j.error ?? 'That didn’t work'))
      if (r.ok) {
        setToken('')
        setSecret('')
      }
    } catch {
      setMsg('Could not reach the local API')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="bp-form"
      onSubmit={(e) => {
        e.preventDefault()
        send(how === 'app' ? { clientId, secret } : { token })
      }}
    >
      <label>
        Store
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-store.myshopify.com" spellCheck={false} />
      </label>
      <div className="bp-seg" role="radiogroup" aria-label="How to connect">
        <button type="button" aria-pressed={how === 'app'} onClick={() => setHow('app')}>
          Dev Dashboard app
        </button>
        <button type="button" aria-pressed={how === 'token'} onClick={() => setHow('token')}>
          Admin API token
        </button>
      </div>
      {how === 'app' ? (
        <>
          <label>
            Client ID
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <label>
            Client secret
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
          </label>
          <p className="bp-help">
            In the <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noreferrer">Shopify Dev Dashboard</a>, create an app, give its version the <code>read_orders</code>, <code>read_products</code> and <code>read_inventory</code> scopes, install it on
            the store, then copy the Client ID and secret from App settings. This works for stores in your own Shopify organisation.
          </p>
        </>
      ) : (
        <>
          <label>
            Admin API access token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="shpat_…" autoComplete="off" />
          </label>
          <p className="bp-help">For a store that already has a custom app made in its admin (Settings › Apps › Develop apps). Shopify no longer lets you make new ones there, so use a Dev Dashboard app for new stores.</p>
        </>
      )}
      <p className="bp-help">Kept on this computer only. It isn’t synced to your other computers or shown to Claude.</p>
      <div className="bp-actions">
        <button className="bp-open" disabled={busy || !domain || (how === 'app' ? !clientId || !secret : !token)}>
          {busy ? 'Checking…' : 'Connect store'}
        </button>
        {p.store?.connected && (
          <button type="button" className="bp-link" onClick={() => send({ token: null })}>
            Disconnect
          </button>
        )}
      </div>
      {msg && <p className="bp-help" role="status">{msg}</p>}
    </form>
  )
}
