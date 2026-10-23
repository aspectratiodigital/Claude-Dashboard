import { useMemo, useState } from 'react'
import type { Project, Store, StoreCatalog, StoreProduct } from '../../data/types'
import { useData } from '../../data/store'
import { relTime } from '../../data/derive'
import { useCatalog, useProductDetail } from '../../data/catalog'
import { Sparkline } from '../../shared/bits'

// The shopfront in front of a building: the Shopify store the site is built
// on. Orders, sales, products and stock come from the local API, which holds
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
  if (!s.connected) return s.error ? 'needs attention' : s.linked ? 'connecting…' : 'not connected'
  return `${s.ordersToday} order${s.ordersToday === 1 ? '' : 's'} today · ${money(s.salesToday, s.currency)}`
}

type StoreView = 'overview' | 'products' | 'apps'

export function StorePanel({ project: p }: { project: Project }) {
  const s = p.store
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<StoreView>('overview')
  if (!s) return <StoreConnect project={p} />
  const week = s.sales7.reduce((a, b) => a + b, 0)
  return (
    <>
      <p className="bp-help">
        {s.name ?? (s.domain || 'Shopify')} · {s.headless === 'Liquid theme' ? 'a Liquid theme' : s.headless ? `headless, built with ${s.headless}` : 'linked by hand'}
      </p>
      {s.connected && (
        <div className="bp-seg" role="tablist" aria-label="Store">
          {(
            [
              ['overview', 'Overview'],
              ['products', `Products${s.products !== null ? ` (${s.products})` : ''}`],
              ['apps', 'Apps'],
            ] as [StoreView, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-pressed={view === k} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {s.connected && view === 'products' ? (
        <Products project={p} />
      ) : s.connected && view === 'apps' ? (
        <Apps store={s} />
      ) : s.connected ? (
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
        <p className="bp-help">{s.error ?? (s.linked ? `Connected on this computer. Reading ${s.domain}…` : s.domain ? `This site is built on ${s.domain}. Connect it to see orders, sales and stock here.` : `This site is built on Shopify, but its code doesn't name the store. Add the store's address below to attach it.`)}</p>
      )}
      <div className="bp-actions">
        <a className="bp-open" href={s.adminUrl} target="_blank" rel="noreferrer">
          Shopify admin <span>orders, products, themes</span>
        </a>
        <button className="bp-link" onClick={() => setEditing((v) => !v)}>
          {s.connected || s.linked ? (editing ? 'Hide' : 'Change access') : editing ? 'Hide' : 'Connect'}
        </button>
      </div>
      {(editing || (!s.connected && !s.error && !s.linked)) && <StoreConnect project={p} />}
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

// --- Products ---------------------------------------------------------------------------

type Filter = 'all' | 'bundles' | 'low' | 'best'
const LOW = 5

const stockText = (n: number | null) => (n === null ? 'not tracked' : n <= 0 ? 'sold out' : `${n} in stock`)
const priceText = (p: StoreProduct, c: string) => (p.minPrice === p.maxPrice ? money(p.minPrice, c) : `${money(p.minPrice, c)}–${money(p.maxPrice, c)}`)

/** Every product in the store; click one to see its colours, sizes, stock and sales. */
function Products({ project }: { project: Project }) {
  const { catalog, error, loading, refresh } = useCatalog(project)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const list = useMemo(() => {
    if (!catalog) return []
    const words = q.trim().toLowerCase()
    const xs = catalog.products.filter(
      (p) => (!words || `${p.title} ${p.type}`.toLowerCase().includes(words)) && (filter !== 'bundles' || p.bundle) && (filter !== 'low' || (p.stock !== null && p.stock < LOW)),
    )
    return filter === 'best' ? [...xs].sort((a, b) => b.revenue - a.revenue || b.sold - a.sold) : xs
  }, [catalog, q, filter])

  if (!catalog) return <p className="bp-help">{error ? `Couldn’t load the products: ${error}` : 'Reading the products and last month’s orders…'}</p>
  const product = open ? catalog.products.find((p) => p.id === open) : null
  if (product) return <ProductView project={project} catalog={catalog} product={product} onBack={() => setOpen(null)} onOpen={setOpen} />

  const bundles = catalog.products.filter((p) => p.bundle).length
  return (
    <>
      <div className="bp-shop-tools">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${catalog.products.length} products`} aria-label="Search products" spellCheck={false} />
        <div className="bp-seg" role="radiogroup" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['bundles', `Bundles (${bundles})`],
              ['low', 'Low stock'],
              ['best', 'Best sellers'],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="bp-products">
        {list.map((p) => (
          <li key={p.id}>
            <button onClick={() => setOpen(p.id)}>
              <Thumb product={p} />
              <span className="bp-product-name">
                <b>{p.title}</b>
                <span>
                  {priceText(p, catalog.currency)} · {p.variants} variant{p.variants === 1 ? '' : 's'} · <em data-low={p.stock !== null && p.stock < LOW}>{stockText(p.stock)}</em>
                </span>
              </span>
              <span className="bp-product-sales">
                <b>{p.sold} sold</b>
                <span>{money(p.revenue, catalog.currency)}</span>
              </span>
              {(p.bundle || p.status !== 'ACTIVE') && <i className="bp-badges">{[p.bundle && 'Bundle', p.status !== 'ACTIVE' && p.status.toLowerCase()].filter(Boolean).join(' · ')}</i>}
            </button>
          </li>
        ))}
        {!list.length && <li className="bp-help">No products match.</li>}
      </ul>
      <p className="bp-help">
        Sales are the last 30 days, from {catalog.orders} order{catalog.orders === 1 ? '' : 's'}
        {catalog.partial ? ' (the most recent ones; older orders weren’t read)' : ''}. Checked {relTime(catalog.checked)}.{' '}
        <button className="bp-link" onClick={refresh} disabled={loading}>
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </p>
      {error && <p className="bp-help">Couldn’t refresh: {error}</p>}
    </>
  )
}

function Thumb({ product: p, big = false }: { product: StoreProduct; big?: boolean }) {
  return p.image ? <img className="bp-thumb" data-big={big} src={p.image} alt="" loading="lazy" /> : <span className="bp-thumb" data-big={big} aria-hidden>{p.title.slice(0, 1)}</span>
}

/** One product opened up: stock by colour and size, sales, and its bundles. */
function ProductView({ project, catalog, product: p, onBack, onOpen }: { project: Project; catalog: StoreCatalog; product: StoreProduct; onBack: () => void; onOpen: (id: string) => void }) {
  const { detail: d, error } = useProductDetail(project, p)
  const c = catalog.currency
  const known = (id: string) => catalog.products.some((x) => x.id === id)
  return (
    <>
      <button className="bp-link" onClick={onBack}>
        ← All products
      </button>
      <header className="bp-product-head">
        <Thumb product={p} big />
        <div>
          <h4>{p.title}</h4>
          <p className="bp-help">
            {[p.type, priceText(p, c), p.status !== 'ACTIVE' && p.status.toLowerCase(), p.bundle && 'bundle'].filter(Boolean).join(' · ')}
          </p>
        </div>
      </header>
      <div className="bp-kpis">
        <figure>
          <b>{p.stock === null ? '–' : p.stock}</b>
          <figcaption>{p.stock === null ? 'Stock not tracked' : 'In stock'}</figcaption>
        </figure>
        <figure>
          <b>{p.sold}</b>
          <figcaption>Sold, 30 days{p.inBundles ? ` (${p.inBundles} in bundles)` : ''}</figcaption>
        </figure>
        <figure>
          <b>{money(p.revenue, c)}</b>
          <figcaption>Revenue, 30 days</figcaption>
        </figure>
      </div>
      <p className="bp-spark">
        <Sparkline data={p.daily} width={240} height={30} fill />
        <span>Revenue by day over the last 30 days{p.inBundles && !p.bundle ? '; bundle sales count towards the bundle' : ''}</span>
      </p>
      {!d ? (
        <p className="bp-help">{error ? `Couldn’t load this product: ${error}` : 'Reading variants…'}</p>
      ) : (
        <>
          {d.options.map((o) => (
            <div key={o.name} className="bp-chips">
              <h4>{o.name}</h4>
              <p>
                {o.values.map((v) => (
                  <span key={v}>{v}</span>
                ))}
              </p>
            </div>
          ))}
          {d.components.length > 0 && (
            <>
              <h4>In this bundle</h4>
              <ul className="bp-floors">
                {d.components.map((x) => (
                  <li key={x.id}>
                    <button onClick={() => known(x.id) && onOpen(x.id)} disabled={!known(x.id)}>
                      <b>
                        {x.qty} × {x.title}
                      </b>
                      <span>{stockText(x.stock)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Stock{d.options.length ? ` by ${d.options.map((o) => o.name.toLowerCase()).join(' and ')}` : ''}</h4>
          <StockGrid detail={d} />
          {d.bundles.length > 0 && (
            <>
              <h4>Part of {d.bundles.length === 1 ? 'a bundle' : `${d.bundles.length} bundles`}</h4>
              <ul className="bp-floors">
                {d.bundles.map((b) => (
                  <li key={b.id}>
                    <button onClick={() => known(b.id) && onOpen(b.id)} disabled={!known(b.id)}>
                      <b>{b.title}</b>
                      <span>{catalog.products.find((x) => x.id === b.id)?.sold ?? 0} sold in 30 days</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.description && <p className="bp-help">{d.description}</p>}
        </>
      )}
      <div className="bp-actions">
        <a className="bp-open" href={p.url} target="_blank" rel="noreferrer">
          Edit in Shopify <span>{p.bundle ? 'bundle, variants, stock' : 'variants, stock, media'}</span>
        </a>
        {d?.storeUrl && (
          <a className="bp-link" href={d.storeUrl} target="_blank" rel="noreferrer">
            View in the shop
          </a>
        )}
      </div>
    </>
  )
}

/** Stock (and units sold) for each variant: a grid when there are two options, a list otherwise. */
function StockGrid({ detail: d }: { detail: NonNullable<ReturnType<typeof useProductDetail>['detail']> }) {
  const [all, setAll] = useState(false)
  const cell = (key: string, n: number | null, sold: number) => (
    <td key={key} data-low={n !== null && n <= 0 ? 'out' : n !== null && n < LOW ? 'low' : undefined} title={`${sold} sold in 30 days`}>
      {n === null ? '–' : n}
      {sold > 0 && <small> · {sold} sold</small>}
    </td>
  )
  if (d.options.length === 2) {
    const [rows, cols] = d.options
    const at = (r: string, c: string) => d.variants.find((v) => v.options[rows.name] === r && v.options[cols.name] === c)
    return (
      <table className="bp-stock">
        <thead>
          <tr>
            <th />
            {cols.values.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.values.map((r) => (
            <tr key={r}>
              <th>{r}</th>
              {cols.values.map((c) => {
                const v = at(r, c)
                return v ? cell(c, v.stock, v.sold) : <td key={c}>·</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  const shown = all ? d.variants : d.variants.slice(0, 24)
  return (
    <>
      <table className="bp-stock" data-list>
        <tbody>
          {shown.map((v) => (
            <tr key={v.id}>
              <th>{v.title === 'Default Title' ? 'Stock' : v.title}</th>
              {cell('n', v.stock, v.sold)}
            </tr>
          ))}
        </tbody>
      </table>
      {(d.variants.length > shown.length || d.moreVariants > 0) && (
        <p className="bp-help">
          {d.variants.length > shown.length && (
            <button className="bp-link" onClick={() => setAll(true)}>
              Show all {d.variants.length} variants
            </button>
          )}
          {d.moreVariants > 0 && ` ${d.moreVariants} more variants aren’t shown here; see them in Shopify.`}
        </p>
      )}
    </>
  )
}

// --- Apps -------------------------------------------------------------------------------

type AppLink = { name: string; url: string }
const appsKey = (domain: string) => `ard.shopApps.${domain}`

function loadApps(domain: string): AppLink[] {
  try {
    const v = JSON.parse(localStorage.getItem(appsKey(domain)) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x?.name === 'string' && typeof x?.url === 'string') : []
  } catch {
    return []
  }
}

/**
 * Shortcuts to the apps on a store. Shopify doesn't let one app list the others
 * installed on a store, so these are pinned by hand (kept in this browser).
 */
function Apps({ store: s }: { store: Store }) {
  const [apps, setApps] = useState(() => loadApps(s.domain))
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const save = (next: AppLink[]) => {
    setApps(next)
    try {
      localStorage.setItem(appsKey(s.domain), JSON.stringify(next))
    } catch {
      /* storage unavailable */
    }
  }
  const valid = /^https:\/\/[^\s]+$/.test(url.trim())
  return (
    <>
      <p className="bp-help">
        Bundles made with Shopify Bundles, or any bundles app built on Shopify’s bundles API, are real products, so they’re already in Products with their parts and stock. For anything else, pin
        the app’s page from your Shopify admin here.
      </p>
      <ul className="bp-floors">
        <li>
          <a className="bp-app" href={`${s.adminUrl}/apps`} target="_blank" rel="noreferrer">
            <b>All apps</b>
            <span>every app installed on {s.name ?? s.domain}</span>
          </a>
        </li>
        {apps.map((a, k) => (
          <li key={a.url + k} className="bp-app-row">
            <a className="bp-app" href={a.url} target="_blank" rel="noreferrer">
              <b>{a.name}</b>
              <span>{a.url.replace(/^https:\/\//, '')}</span>
            </a>
            <button className="bp-link" onClick={() => save(apps.filter((_, j) => j !== k))} aria-label={`Unpin ${a.name}`}>
              Unpin
            </button>
          </li>
        ))}
      </ul>
      <form
        className="bp-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim() || !valid) return
          save([...apps, { name: name.trim(), url: url.trim() }])
          setName('')
          setUrl('')
        }}
      >
        <label>
          App name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bundles" />
        </label>
        <label>
          Its page in Shopify admin
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`${s.adminUrl}/apps/…`} spellCheck={false} />
        </label>
        <div className="bp-actions">
          <button className="bp-open" disabled={!name.trim() || !valid}>
            Pin app
          </button>
        </div>
      </form>
    </>
  )
}
