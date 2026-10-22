import type { Store, StoreCatalog, StoreProduct, StoreProductDetail } from '../src/data/types.ts'
import { log, now, sleep } from './util.ts'

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

// --- Products: the catalogue, each product's variants, and sales per item -----------------

type GqlResult<T> = { data?: T; error?: string; available?: number; restore?: number }

/** One Admin API call, with the throttle state Shopify sends back so paging can wait its turn. */
async function gql<T>(domain: string, cred: ShopifyCred, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
  const token = await accessToken(domain, cred)
  if (typeof token !== 'string') return { error: token.error }
  const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  })
  if (r.status === 401 && typeof cred !== 'string') minted.clear()
  if (r.status === 401 || r.status === 403) return { error: 'Shopify refused access. Check the app has the read_orders and read_products scopes.' }
  const j = (await r.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] | string; extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } } }
  const t = j.extensions?.cost?.throttleStatus
  if (!j.data) return { error: typeof j.errors === 'string' ? j.errors : (j.errors?.[0]?.message ?? `Shopify answered ${r.status}`), available: t?.currentlyAvailable, restore: t?.restoreRate }
  return { data: j.data, available: t?.currentlyAvailable, restore: t?.restoreRate }
}

/** Wait until the API bucket has room for a call of this cost (Shopify refills it every second). */
async function pace(res: GqlResult<unknown>, cost: number) {
  if (res.available === undefined || res.available >= cost) return
  await sleep(Math.min(10_000, ((cost - res.available) / Math.max(1, res.restore ?? 50)) * 1000 + 100))
}

const PRODUCTS = `query Products($after: String) {
  shop { currencyCode }
  products(first: 100, after: $after, sortKey: TITLE) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status productType totalInventory tracksInventory hasVariantsThatRequiresComponents
      variantsCount { count }
      priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
      featuredMedia { preview { image { url(transform: { maxWidth: 160 }) } } }
    }
  }
}`

interface ProductsData {
  shop: { currencyCode: string }
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: {
      id: string
      title: string
      status: string
      productType: string
      totalInventory: number
      tracksInventory: boolean
      hasVariantsThatRequiresComponents: boolean
      variantsCount: { count: number } | null
      priceRangeV2: { minVariantPrice: { amount: string }; maxVariantPrice: { amount: string } }
      featuredMedia: { preview: { image: { url: string } | null } | null } | null
    }[]
  }
}

// A bundle sold through Shopify's bundles API arrives as its component line items, grouped:
// the group carries the bundle product, the line items carry the parts.
const SALES = `query Sales($after: String, $q: String!) {
  orders(first: 10, after: $after, sortKey: CREATED_AT, reverse: true, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt
      lineItems(first: 8) {
        nodes {
          quantity
          product { id }
          variant { id }
          discountedTotalSet { shopMoney { amount } }
          lineItemGroup { id productId quantity }
        }
      }
    }
  }
}`
const SALES_COST = 520

interface SalesData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: {
      createdAt: string
      lineItems: { nodes: { quantity: number; product: { id: string } | null; variant: { id: string } | null; discountedTotalSet: { shopMoney: { amount: string } }; lineItemGroup: { id: string; productId: string | null; quantity: number } | null }[] }
    }[]
  }
}

interface Sales {
  products: Map<string, { sold: number; inBundles: number; revenue: number; daily: number[] }>
  variants: Map<string, number>
  orders: number
  partial: boolean
}

const SALES_DAYS = 30
const MAX_ORDER_PAGES = 40

async function loadSales(domain: string, cred: ShopifyCred): Promise<Sales | { error: string }> {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const from = start.getTime() - (SALES_DAYS - 1) * DAY
  const products: Sales['products'] = new Map()
  const variants: Sales['variants'] = new Map()
  const of = (id: string) => {
    let p = products.get(id)
    if (!p) products.set(id, (p = { sold: 0, inBundles: 0, revenue: 0, daily: Array.from({ length: SALES_DAYS }, () => 0) }))
    return p
  }
  let after: string | null = null
  let orders = 0
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const res: GqlResult<SalesData> = await gql<SalesData>(domain, cred, SALES, { after, q: `created_at:>='${new Date(from).toISOString()}'` })
    if (!res.data) return { error: res.error ?? 'Couldn’t read orders' }
    const seen = new Set<string>()
    for (const o of res.data.orders.nodes) {
      orders++
      const day = Math.min(SALES_DAYS - 1, Math.max(0, Math.floor((Date.parse(o.createdAt) - from) / DAY)))
      for (const li of o.lineItems.nodes) {
        const amount = Number(li.discountedTotalSet.shopMoney.amount) || 0
        const g = li.lineItemGroup
        if (li.variant) variants.set(gid(li.variant.id), (variants.get(gid(li.variant.id)) ?? 0) + li.quantity)
        if (g?.productId) {
          // a part of a bundle: the stock left with this product, the money belongs to the bundle
          if (li.product) {
            const c = of(gid(li.product.id))
            c.sold += li.quantity
            c.inBundles += li.quantity
          }
          const b = of(gid(g.productId))
          if (!seen.has(g.id)) {
            seen.add(g.id)
            b.sold += g.quantity
          }
          b.revenue += amount
          b.daily[day] += amount
        } else if (li.product) {
          const p = of(gid(li.product.id))
          p.sold += li.quantity
          p.revenue += amount
          p.daily[day] += amount
        }
      }
    }
    const info = res.data.orders.pageInfo
    if (!info.hasNextPage) return { products, variants, orders, partial: false }
    after = info.endCursor
    await pace(res, SALES_COST)
  }
  return { products, variants, orders, partial: true }
}

const catalogs = new Map<string, { at: number; catalog: StoreCatalog; sales: Sales | null }>()
const CATALOG_TTL = 5 * 60_000

/** Every product in the store with its stock and last-30-day sales. Cached for five minutes. */
export async function loadCatalog(domain: string, cred: ShopifyCred, force = false): Promise<StoreCatalog | { error: string }> {
  const hit = catalogs.get(domain)
  if (hit && !force && Date.now() - hit.at < CATALOG_TTL) return hit.catalog
  try {
    const salesJob = loadSales(domain, cred)
    const nodes: ProductsData['products']['nodes'] = []
    let currency = 'GBP'
    let after: string | null = null
    for (let page = 0; page < 10; page++) {
      const res: GqlResult<ProductsData> = await gql<ProductsData>(domain, cred, PRODUCTS, { after })
      if (!res.data) return { error: res.error ?? 'Couldn’t read products' }
      currency = res.data.shop.currencyCode
      nodes.push(...res.data.products.nodes)
      if (!res.data.products.pageInfo.hasNextPage) break
      after = res.data.products.pageInfo.endCursor
      await pace(res, 400)
    }
    const s = await salesJob
    const sales = 'error' in s ? null : s
    const admin = adminUrl(domain)
    const products: StoreProduct[] = nodes.map((n) => {
      const id = gid(n.id)
      const x = sales?.products.get(id)
      return {
        id,
        title: n.title,
        status: n.status,
        type: n.productType,
        image: n.featuredMedia?.preview?.image?.url ?? null,
        minPrice: Number(n.priceRangeV2.minVariantPrice.amount) || 0,
        maxPrice: Number(n.priceRangeV2.maxVariantPrice.amount) || 0,
        stock: n.tracksInventory ? n.totalInventory : null,
        variants: n.variantsCount?.count ?? 0,
        bundle: n.hasVariantsThatRequiresComponents,
        sold: x?.sold ?? 0,
        inBundles: x?.inBundles ?? 0,
        revenue: round(x?.revenue ?? 0),
        daily: (x?.daily ?? Array.from({ length: SALES_DAYS }, () => 0)).map(round),
        url: `${admin}/products/${id}`,
      }
    })
    const catalog: StoreCatalog = { currency, products, orders: sales?.orders ?? 0, partial: !sales || sales.partial, checked: now() }
    catalogs.set(domain, { at: Date.now(), catalog, sales })
    return catalog
  } catch (e) {
    log('shopify', domain, (e as Error).message)
    return { error: `Couldn't reach ${domain}` }
  }
}

const PRODUCT = `query Product($id: ID!) {
  product(id: $id) {
    id description onlineStoreUrl tracksInventory
    options { name values }
    variants(first: 250) {
      nodes { id title sku price inventoryQuantity selectedOptions { name value } }
    }
    variantsCount { count }
    bundleComponents(first: 20) { nodes { quantity componentProduct { id title totalInventory tracksInventory } } }
    productParents(first: 20) { nodes { id title } }
  }
}`

interface ProductData {
  product: {
    id: string
    description: string
    onlineStoreUrl: string | null
    tracksInventory: boolean
    options: { name: string; values: string[] }[]
    variants: { nodes: { id: string; title: string; sku: string | null; price: string; inventoryQuantity: number | null; selectedOptions: { name: string; value: string }[] }[] }
    variantsCount: { count: number } | null
    bundleComponents: { nodes: { quantity: number | null; componentProduct: { id: string; title: string; totalInventory: number; tracksInventory: boolean } }[] }
    productParents: { nodes: { id: string; title: string }[] }
  } | null
}

/** One product opened up: options, every variant's stock and sales, and its bundle links. */
export async function loadProduct(domain: string, cred: ShopifyCred, id: string): Promise<StoreProductDetail | { error: string }> {
  try {
    const res = await gql<ProductData>(domain, cred, PRODUCT, { id: `gid://shopify/Product/${id}` })
    if (!res.data) return { error: res.error ?? 'Couldn’t read that product' }
    const p = res.data.product
    if (!p) return { error: 'That product isn’t in the store any more' }
    const sold = catalogs.get(domain)?.sales?.variants
    return {
      id,
      description: p.description.slice(0, 600),
      storeUrl: p.onlineStoreUrl,
      options: p.options.filter((o) => !(o.name === 'Title' && o.values.length === 1 && o.values[0] === 'Default Title')),
      variants: p.variants.nodes.map((v) => ({
        id: gid(v.id),
        title: v.title,
        options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])),
        sku: v.sku || null,
        price: Number(v.price) || 0,
        stock: p.tracksInventory ? (v.inventoryQuantity ?? 0) : null,
        sold: sold?.get(gid(v.id)) ?? 0,
      })),
      moreVariants: Math.max(0, (p.variantsCount?.count ?? 0) - p.variants.nodes.length),
      components: p.bundleComponents.nodes.map((c) => ({ id: gid(c.componentProduct.id), title: c.componentProduct.title, qty: c.quantity ?? 1, stock: c.componentProduct.tracksInventory ? c.componentProduct.totalInventory : null })),
      bundles: p.productParents.nodes.map((b) => ({ id: gid(b.id), title: b.title })),
    }
  } catch (e) {
    log('shopify', domain, (e as Error).message)
    return { error: `Couldn't reach ${domain}` }
  }
}
