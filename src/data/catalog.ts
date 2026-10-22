import { useEffect, useState } from 'react'
import type { Project, StoreCatalog, StoreProduct, StoreProductDetail } from './types'
import { useData } from './store'

// A store's products, read from the local API when you open the products view
// (the server caches them for five minutes). Demo: a made-up coffee shop
// catalogue so the view has something to show.

const catalogs = new Map<string, StoreCatalog>()
const details = new Map<string, StoreProductDetail>()

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const x = await r.json().catch(() => null)
  if (!r.ok) throw new Error(x?.error ?? `HTTP ${r.status}`)
  return x as T
}

export function useCatalog(project: Project) {
  const mode = useData((s) => s.mode)
  const key = project.id
  const [, bump] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (fresh = false) => {
    if (mode !== 'live') {
      catalogs.set(key, demoCatalog())
      bump((n) => n + 1)
      return () => {}
    }
    let alive = true
    setBusy(true)
    setError(null)
    get<StoreCatalog>(`./api/shopify/products?project=${encodeURIComponent(project.id)}${fresh ? '&fresh=1' : ''}`)
      .then((c) => {
        catalogs.set(key, c)
        if (alive) bump((n) => n + 1)
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }

  useEffect(() => (catalogs.has(key) ? undefined : load()), [key, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  return { catalog: catalogs.get(key) ?? null, error, loading: busy || (!catalogs.has(key) && !error), refresh: () => load(true) }
}

export function useProductDetail(project: Project, product: StoreProduct) {
  const mode = useData((s) => s.mode)
  const key = `${project.id}|${product.id}`
  const [, bump] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (details.has(key)) return
    if (mode !== 'live') {
      details.set(key, demoDetail(product))
      bump((n) => n + 1)
      return
    }
    let alive = true
    get<StoreProductDetail>(`./api/shopify/product?project=${encodeURIComponent(project.id)}&id=${encodeURIComponent(product.id)}`)
      .then((d) => {
        details.set(key, d)
        if (alive) bump((n) => n + 1)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [key, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  return { detail: details.get(key) ?? null, error, loading: !details.has(key) && !error }
}

// --- Demo ------------------------------------------------------------------------------

const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

const DEMO: [title: string, type: string, price: number, stock: number | null, sold: number, bundle?: boolean][] = [
  ['Brew Kit: Grinder, Dripper & Two Bags', 'Bundles', 64, 18, 22, true],
  ['Colombia Huila 250g', 'Coffee', 11.5, 42, 61],
  ['Decaf Swiss Water 250g', 'Coffee', 11, 1, 19],
  ['Ethiopia Guji 250g', 'Coffee', 12.5, 3, 74],
  ['Hand Grinder', 'Equipment', 39, 12, 9],
  ['House Espresso 1kg', 'Coffee', 34, 26, 38],
  ['Kiln Enamel Mug', 'Merch', 14, 0, 11],
  ['Kiln Tote Bag', 'Merch', 12, null, 6],
  ['Pour-over Dripper', 'Equipment', 22, 15, 14],
  ['Subscription: 2 bags a month', 'Subscriptions', 22, null, 31],
  ['Taster Trio Bundle', 'Bundles', 30, 9, 17, true],
]

const VARIANTS: Record<string, { name: string; values: string[] }[]> = {
  Coffee: [
    { name: 'Grind', values: ['Whole bean', 'Espresso', 'Filter', 'Cafetière'] },
    { name: 'Size', values: ['250g', '500g', '1kg'] },
  ],
  Merch: [
    { name: 'Colour', values: ['Ash', 'Ink', 'Clay'] },
    { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
  ],
}

function demoCatalog(): StoreCatalog {
  const r = rnd(7)
  return {
    currency: 'GBP',
    orders: 214,
    partial: false,
    checked: new Date(Date.now() - 60_000).toISOString(),
    products: DEMO.map(([title, type, price, stock, sold, bundle], i) => {
      const daily = Array.from({ length: 30 }, () => Math.round(r() * (sold / 15) * price * 100) / 100)
      const opts = VARIANTS[type]
      return {
        id: String(9_100_000 + i),
        title,
        status: i === 7 ? 'DRAFT' : 'ACTIVE',
        type,
        image: null,
        minPrice: price,
        maxPrice: opts ? price * 2.6 : price,
        stock,
        variants: opts ? opts.reduce((a, o) => a * o.values.length, 1) : bundle ? 4 : 1,
        bundle: !!bundle,
        sold,
        inBundles: type === 'Coffee' || type === 'Equipment' ? Math.round(sold * 0.2) : 0,
        revenue: Math.round(daily.reduce((a, b) => a + b, 0) * 100) / 100,
        daily,
        url: 'https://admin.shopify.com/store/kiln-coffee/products',
      }
    }),
  }
}

function demoDetail(p: StoreProduct): StoreProductDetail {
  const r = rnd(Number(p.id) % 1000)
  const opts = p.bundle ? [{ name: 'Coffee', values: ['Ethiopia Guji', 'Colombia Huila'] }, { name: 'Grind', values: ['Whole bean', 'Filter'] }] : (VARIANTS[p.type] ?? [])
  const combos = opts.reduce<Record<string, string>[]>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v }))), [{}])
  return {
    id: p.id,
    description: p.bundle ? 'Everything you need to brew at home, put together with Shopify Bundles.' : `${p.title}, roasted in small batches in Leeds.`,
    storeUrl: null,
    options: opts,
    variants: (opts.length ? combos : [{}]).map((c, k) => ({
      id: `${p.id}-${k}`,
      title: Object.values(c).join(' / ') || 'Default',
      options: c,
      sku: `KCR-${p.id.slice(-2)}-${k}`,
      price: p.minPrice,
      stock: p.stock === null ? null : Math.max(0, Math.round(r() * 12) - 3),
      sold: Math.round(r() * (p.sold / Math.max(1, combos.length)) * 2),
    })),
    moreVariants: 0,
    components: p.bundle
      ? [
          { id: '9100004', title: 'Hand Grinder', qty: 1, stock: 12 },
          { id: '9100008', title: 'Pour-over Dripper', qty: 1, stock: 15 },
          { id: '9100003', title: 'Ethiopia Guji 250g', qty: 2, stock: 3 },
        ]
      : [],
    bundles: p.type === 'Coffee' || p.type === 'Equipment' ? [{ id: '9100000', title: 'Brew Kit: Grinder, Dripper & Two Bags' }] : [],
  }
}
