import type { Store } from '../src/data/types.ts'
import { log, now } from './util.ts'

// A site's Shopify store, read with the Admin API. Access comes from either an
// app made in the Shopify Dev Dashboard (client ID + secret, swapped for a
// 24-hour token) or an older custom app's Admin API token (shpat_…). Either is
// kept in this computer's settings only: never synced, sent to the browser or
// passed to Claude.

/** an Admin API token, or a Dev Dashboard app's client credentials */
export type ShopifyCred = string | { id: string; secret: string }

const minted = new Map<string, { token: string; until: number }>()

/** The Admin API token for a store: the saved one, or a fresh one from the client credentials grant. */
async function accessToken(domain: string, cred: ShopifyCred): Promise<string | { error: string }> {
  if (typeof cred === 'string') return cred
  const key = `${domain}|${cred.id}`
  const hit = minted.get(key)
  if (hit && hit.until > Date.now()) return hit.token
  const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: cred.id, client_secret: cred.secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!j.access_token) {
    const why = j.error_description ?? j.error ?? `Shopify answered ${r.status}`
    return { error: /shop_not_permitted|cannot be performed on this shop/i.test(why) ? 'This app and store aren\'t in the same Shopify organisation. Install the app on the store from the Dev Dashboard, or use an Admin API token instead.' : `Shopify didn't accept the client ID and secret: ${why}` }
  }
  minted.set(key, { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 86_399) - 600) * 1000 })
  return j.access_token
}

export const API_VERSION = '2026-07'
const DAY = 86_400_000

export const isDomain = (d: string) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)

/** "Kiln-Coffee.myshopify.com/" or "https://admin.shopify.com/store/kiln-coffee" -> "kiln-coffee.myshopify.com" */
export function cleanDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const admin = raw.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/i)
  const d = admin ? `${admin[1].toLowerCase()}.myshopify.com` : s.includes('.') ? s : `${s}.myshopify.com`
  return isDomain(d) ? d : null
}

export const adminUrl = (domain: string) => (domain ? `https://admin.shopify.com/store/${domain.replace(/\.myshopify\.com$/, '')}` : 'https://admin.shopify.com')

const gid = (id: string) => id.split('/').pop() ?? id

const QUERY = `query Dashboard($orders: String!) {
  shop { name currencyCode }
  productsCount { count }
  orders(first: 250, sortKey: CREATED_AT, reverse: true, query: $orders) {
    nodes {
      id
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount } }
    }
  }
  products(first: 8, sortKey: INVENTORY_TOTAL, query: "status:active inventory_total:<5") {
    nodes { id title totalInventory tracksInventory }
  }
}`

interface Gql {
  data?: {
    shop: { name: string; currencyCode: string }
    productsCount: { count: number } | null
    orders: { nodes: { id: string; name: string; createdAt: string; displayFinancialStatus: string | null; displayFulfillmentStatus: string; totalPriceSet: { shopMoney: { amount: string } } }[] }
    products: { nodes: { id: string; title: string; totalInventory: number | null; tracksInventory: boolean }[] }
  }
  errors?: { message: string }[] | string
}

/** An empty store: found in the code (or set by hand) but not read yet. */
export function blankStore(domain: string, headless: string | null): Store {
  return { domain, headless, connected: false, error: null, name: null, currency: null, adminUrl: adminUrl(domain), ordersToday: 0, salesToday: 0, sales7: [0, 0, 0, 0, 0, 0, 0], orders: [], lowStock: [], products: null, checked: null }
}

export async function loadStore(domain: string, cred: ShopifyCred, headless: string | null): Promise<Store> {
  const base = blankStore(domain, headless)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const from = new Date(start.getTime() - 6 * DAY)
  try {
    const token = await accessToken(domain, cred)
    if (typeof token !== 'string') return { ...base, error: token.error, checked: now() }
    const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: QUERY, variables: { orders: `created_at:>='${from.toISOString()}'` } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (r.status === 401 && typeof cred !== 'string') minted.clear()
    if (r.status === 401 || r.status === 403) return { ...base, error: 'Shopify refused access. Check the app has the read_orders, read_products and read_inventory scopes and is installed on this store.', checked: now() }
    if (r.status === 404) return { ...base, error: `No store at ${domain}`, checked: now() }
    const j = (await r.json().catch(() => ({}))) as Gql
    if (!j.data) {
      const msg = typeof j.errors === 'string' ? j.errors : (j.errors?.[0]?.message ?? `Shopify answered ${r.status}`)
      return { ...base, error: msg, checked: now() }
    }
    const admin = adminUrl(domain)
    const orders = j.data.orders.nodes.map((o) => ({
      id: gid(o.id),
      name: o.name,
      total: Number(o.totalPriceSet.shopMoney.amount) || 0,
      at: o.createdAt,
      status: (o.displayFulfillmentStatus === 'FULFILLED' ? 'Fulfilled' : o.displayFinancialStatus === 'PAID' ? 'Paid' : (o.displayFinancialStatus ?? 'Open')).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
      url: `${admin}/orders/${gid(o.id)}`,
    }))
    const sales7 = Array.from({ length: 7 }, () => 0)
    for (const o of orders) {
      const day = Math.floor((Date.parse(o.at) - from.getTime()) / DAY)
      if (day >= 0 && day < 7) sales7[day] += o.total
    }
    const today = orders.filter((o) => Date.parse(o.at) >= start.getTime())
    return {
      ...base,
      connected: true,
      name: j.data.shop.name,
      currency: j.data.shop.currencyCode,
      ordersToday: today.length,
      salesToday: round(today.reduce((a, o) => a + o.total, 0)),
      sales7: sales7.map(round),
      orders: orders.slice(0, 8),
      lowStock: j.data.products.nodes
        .filter((p) => p.tracksInventory && p.totalInventory !== null && p.totalInventory < 5)
        .map((p) => ({ title: p.title, qty: p.totalInventory ?? 0, url: `${admin}/products/${gid(p.id)}` })),
      products: j.data.productsCount?.count ?? null,
      checked: now(),
    }
  } catch (e) {
    log('shopify', domain, (e as Error).message)
    return { ...base, error: `Couldn't reach ${domain}`, checked: now() }
  }
}

const round = (n: number) => Math.round(n * 100) / 100

/** A store's short summary for Claude: no token, no customer details. */
export function storeBrief(s: Store) {
  const head = `Shopify store ${s.name ?? (s.domain || 'not named in the code')}${s.domain ? ` (${s.domain})` : ''}${s.headless ? `, ${s.headless === 'Liquid theme' ? 'a Liquid theme' : `headless via ${s.headless}`}` : ''}`
  if (!s.connected) return `${head}. Not connected to the dashboard yet.`
  const low = s.lowStock.length ? ` Low stock: ${s.lowStock.map((p) => `${p.title} (${p.qty})`).join(', ')}.` : ''
  return `${head}. ${s.products ?? '?'} products. Today: ${s.ordersToday} orders, ${s.salesToday} ${s.currency}. Last 7 days: ${round(s.sales7.reduce((a, b) => a + b, 0))} ${s.currency}.${low}`
}
