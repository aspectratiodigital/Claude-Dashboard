import { Heap, facing, plotTiles, xz, type Home, type Index } from './map'

// Getting cars around: routes along the road links, and the smooth line a car
// follows (corners rounded, clockwise round roundabouts, keeping left as in
// the UK).

/** World position of a tile's centre: the map is centred on the origin, one unit per tile. */
export function centre(m: { cols: number; rows: number }, x: number, z: number): [number, number] {
  return [x - m.cols / 2 + 0.5, z - m.rows / 2 + 0.5]
}
export const tileAt = (m: { cols: number; rows: number }, k: string) => centre(m, ...xz(k))

const routeCache = new WeakMap<Index, Map<string, Map<string, string>>>()

/** For one site: the next tile towards it from every tile whose roads reach it. Nobody drives through a home or another site. */
export function routesTo(ix: Index, site: string): Map<string, string> {
  let bySite = routeCache.get(ix)
  if (!bySite) routeCache.set(ix, (bySite = new Map()))
  const hit = bySite.get(site)
  if (hit) return hit
  const next = new Map<string, string>()
  const dist = new Map<string, number>()
  const keys: string[] = []
  const ids = new Map<string, number>()
  const id = (k: string) => {
    let i = ids.get(k)
    if (i === undefined) {
      i = keys.push(k) - 1
      ids.set(k, i)
    }
    return i
  }
  const heap = new Heap()
  const p = ix.map.sites[site]
  if (p)
    for (const t of plotTiles(p))
      if (ix.adj.has(t)) {
        dist.set(t, 0)
        next.set(t, '')
        heap.push(0, id(t))
      }
  while (heap.size) {
    const [d, i] = heap.pop()
    const t = keys[i]
    if (d > (dist.get(t) ?? Infinity)) continue
    const o = ix.occ.get(t)
    if (o && !(o.kind === 'site' && o.id === site)) continue
    const [x, z] = xz(t)
    for (const n of ix.adj.get(t) ?? []) {
      const [nx, nz] = xz(n)
      const nd = d + (nx !== x && nz !== z ? Math.SQRT2 : 1)
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd)
        next.set(n, t)
        heap.push(nd, id(n))
      }
    }
  }
  bySite.set(site, next)
  return next
}

/** The tiles from a home to its site, or null when no road gets there. */
export function routeFrom(ix: Index, from: string, site: string): string[] | null {
  const next = routesTo(ix, site)
  if (!next.has(from)) return null
  const out = [from]
  for (let t = next.get(from), guard = 0; t && guard < 10_000; t = next.get(t), guard++) out.push(t)
  return out.length > 1 ? out : null
}

/** A drive along a route: points (x, z pairs) a car follows on its side of the road, and the distance to each. */
export interface Drive {
  tiles: string[]
  pts: number[]
  cum: number[]
  len: number
}

/** Distance from the middle of the road to the middle of a lane. */
export const LANE = 0.12
/** Radius cars go round a roundabout at, before the lane. */
const ROUND = 0.3

function norm(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1
  return [x / l, z / l]
}

export function drive(ix: Index, tiles: string[]): Drive {
  const c = tiles.map((k) => tileAt(ix.map, k))
  const raw: [number, number][] = [c[0]]
  for (let i = 1; i < c.length - 1; i++) {
    const [ax, az] = c[i - 1]
    const [vx, vz] = c[i]
    const [bx, bz] = c[i + 1]
    if (ix.roundabouts.has(tiles[i])) {
      // in from one side and round clockwise to the way out: angles grow clockwise on screen
      const [ux, uz] = norm(vx - ax, vz - az)
      const [ox, oz] = norm(bx - vx, bz - vz)
      const a0 = Math.atan2(-uz, -ux)
      let span = Math.atan2(oz, ox) - a0
      while (span <= 0.2) span += Math.PI * 2
      while (span > Math.PI * 2 + 0.2) span -= Math.PI * 2
      const n = Math.max(3, Math.ceil(span / 0.4))
      for (let s = 0; s <= n; s++) {
        const a = a0 + (span * s) / n
        raw.push([vx + Math.cos(a) * ROUND, vz + Math.sin(a) * ROUND])
      }
      continue
    }
    const [ux, uz] = norm(ax - vx, az - vz)
    const [wx, wz] = norm(bx - vx, bz - vz)
    if (Math.abs(ux * wz - uz * wx) < 1e-3) {
      raw.push([vx, vz])
      continue
    }
    // round the corner
    const cut = Math.min(0.34, Math.hypot(ax - vx, az - vz) / 2, Math.hypot(bx - vx, bz - vz) / 2)
    const p1x = vx + ux * cut
    const p1z = vz + uz * cut
    const p2x = vx + wx * cut
    const p2z = vz + wz * cut
    for (let s = 0; s <= 4; s++) {
      const t = s / 4
      const m = 1 - t
      raw.push([m * m * p1x + 2 * m * t * vx + t * t * p2x, m * m * p1z + 2 * m * t * vz + t * t * p2z])
    }
  }
  raw.push(c[c.length - 1])
  // keep left: shift every point to the left of the way it's going
  const pts: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const [px, pz] = raw[Math.max(0, i - 1)]
    const [nx, nz] = raw[Math.min(raw.length - 1, i + 1)]
    const [tx, tz] = norm(nx - px, nz - pz)
    pts.push(raw[i][0] + tz * LANE, raw[i][1] - tx * LANE)
  }
  const cum = [0]
  for (let i = 1; i < pts.length / 2; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]))
  return { tiles, pts, cum, len: cum[cum.length - 1] }
}

export interface Pose {
  x: number
  z: number
  dx: number
  dz: number
}

/** Where a car is `s` along a drive. `hint` remembers the segment, since cars only move forwards. */
export function sample(d: Drive, s: number, hint: { seg: number }, out: Pose) {
  const { cum, pts } = d
  let i = Math.min(hint.seg, cum.length - 2)
  while (i < cum.length - 2 && cum[i + 1] < s) i++
  hint.seg = i
  const l = cum[i + 1] - cum[i]
  const f = l > 1e-6 ? Math.min(1, Math.max(0, (s - cum[i]) / l)) : 1
  const ax = pts[2 * i]
  const az = pts[2 * i + 1]
  const bx = pts[2 * i + 2]
  const bz = pts[2 * i + 3]
  out.x = ax + (bx - ax) * f
  out.z = az + (bz - az) * f
  if (l > 1e-6) {
    out.dx = (bx - ax) / l
    out.dz = (bz - az) / l
  }
}

/** Where a home's two cars park on its drive, nose to the road: x, z and heading. */
export function homeSpot(ix: Index, h: Home, slot: number): [number, number, number] {
  const [fx, fz] = facing(ix, h)
  const [cx, cz] = centre(ix.map, h.x, h.z)
  const side = slot ? 0.11 : -0.11
  return [cx + fx * 0.2 + fz * side, cz + fz * 0.2 - fx * side, Math.atan2(-fz, fx)]
}

/** Where a car parks at its building: just inside the lot where its road comes in, facing the building. */
export function siteSpot(ix: Index, d: Drive, n: number): [number, number, number] {
  const t = d.tiles
  const [ex, ez] = tileAt(ix.map, t[t.length - 1])
  const [px, pz] = tileAt(ix.map, t[t.length - 2])
  const [ux, uz] = norm(ex - px, ez - pz)
  const side = ((n % 5) - 2) * 0.17
  return [ex - ux * 0.24 + uz * side, ez - uz * 0.24 - ux * side, Math.atan2(-uz, ux)]
}
