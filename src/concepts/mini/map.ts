import type { Project } from '../../data/types'
import { floorsIn } from '../../data/derive'

// The Mini theme's little city, after Mini Motorways: a grid of tiles with a
// building for every site, homes whose cars drive to it and back, and roads
// drawn as links between neighbouring tiles (a road over water is a bridge).
//
// Everything here is plain data and pure functions: an edit returns a new map
// (or the same one when nothing changed), so undo is just the previous map.

export type Tool = 'look' | 'move' | 'road' | 'roundabout' | 'house' | 'tree' | 'water' | 'erase'

/** A site's building: its corner tile, its size in tiles and its colour (a COLORS index). */
export interface Plot {
  x: number
  z: number
  w: number
  d: number
  color: number
}

/** A home: its cars drive to `site` and back. */
export interface Home {
  id: string
  site: string
  x: number
  z: number
}

export interface MiniMap {
  v: 1
  /** when it last changed: between computers the newest copy wins */
  at: number
  /** changed by hand: a map you've changed beats one the app laid out by itself */
  edited: boolean
  seed: number
  cols: number
  rows: number
  sites: Record<string, Plot>
  homes: Home[]
  /** links between neighbouring tiles, 'x,z|x,z' */
  roads: string[]
  water: string[]
  trees: string[]
  roundabouts: string[]
}

/** Building colours, in the order sites get them (after Mini Motorways' destinations). */
export const COLORS = ['#e8574a', '#3e8ed9', '#f2bd3d', '#4fae69', '#9a6bd2', '#f1863a', '#ec7aab', '#2fb3a5', '#5a6fd0', '#b9c136', '#a87454', '#d94f7c']

export function colorOf(i: number): string {
  if (i < COLORS.length) return COLORS[i]
  return `hsl(${Math.round((i * 137.508) % 360)}, 62%, 56%)`
}

// --- Tiles and links -----------------------------------------------------------------------------

export const tk = (x: number, z: number) => `${x},${z}`
export function xz(k: string): [number, number] {
  const i = k.indexOf(',')
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))]
}
export const link = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
export const ends = (l: string) => l.split('|') as [string, string]
export const inside = (m: MiniMap, x: number, z: number) => x >= 0 && z >= 0 && x < m.cols && z < m.rows

/** The tiles a plot covers. */
export function plotTiles(p: { x: number; z: number; w: number; d: number }): string[] {
  const out: string[] = []
  for (let x = p.x; x < p.x + p.w; x++) for (let z = p.z; z < p.z + p.d; z++) out.push(tk(x, z))
  return out
}

/** Lookups for one map, for the projects you have (a hidden project's building and homes step aside). */
export interface Index {
  map: MiniMap
  links: Set<string>
  /** each road tile's neighbours along its links */
  adj: Map<string, string[]>
  water: Set<string>
  trees: Set<string>
  roundabouts: Set<string>
  /** the building on each tile: a site's id, or a home's */
  occ: Map<string, { kind: 'site' | 'home'; id: string }>
  sites: [string, Plot][]
  homes: Home[]
}

export function buildIndex(map: MiniMap, active: Set<string>): Index {
  const adj = new Map<string, string[]>()
  const add = (a: string, b: string) => {
    const l = adj.get(a)
    if (l) l.push(b)
    else adj.set(a, [b])
  }
  for (const l of map.roads) {
    const [a, b] = ends(l)
    add(a, b)
    add(b, a)
  }
  const occ: Index['occ'] = new Map()
  const sites = Object.entries(map.sites).filter(([id]) => active.has(id))
  for (const [id, p] of sites) for (const t of plotTiles(p)) occ.set(t, { kind: 'site', id })
  const homes = map.homes.filter((h) => active.has(h.site))
  for (const h of homes) occ.set(tk(h.x, h.z), { kind: 'home', id: h.id })
  return { map, links: new Set(map.roads), adj, water: new Set(map.water), trees: new Set(map.trees), roundabouts: new Set(map.roundabouts), occ, sites, homes }
}

/** The way a home's drive faces: towards its first road, else south. */
export function facing(ix: Index, h: { x: number; z: number }): [number, number] {
  const n = ix.adj.get(tk(h.x, h.z))?.[0]
  if (!n) return [0, 1]
  const [x, z] = xz(n)
  return [Math.sign(x - h.x), Math.sign(z - h.z)]
}

// --- Edits ---------------------------------------------------------------------------------------

const touch = (m: MiniMap, patch: Partial<MiniMap>): MiniMap => ({ ...m, ...patch, at: Date.now(), edited: true })
const without = (list: string[], drop: Set<string> | string) => list.filter((k) => (typeof drop === 'string' ? k !== drop : !drop.has(k)))

/** Can a road run from tile a to its neighbour b? */
export function canLink(ix: Index, a: string, b: string): boolean {
  const [ax, az] = xz(a)
  const [bx, bz] = xz(b)
  const dx = bx - ax
  const dz = bz - az
  if ((!dx && !dz) || Math.abs(dx) > 1 || Math.abs(dz) > 1) return false
  if (!inside(ix.map, ax, az) || !inside(ix.map, bx, bz)) return false
  const oa = ix.occ.get(a)
  const ob = ix.occ.get(b)
  if (oa && ob && oa.id === ob.id) return false
  // a diagonal can't reach into a building, or squeeze past one's corner
  if (dx && dz && (oa || ob || ix.occ.has(tk(ax + dx, az)) || ix.occ.has(tk(ax, az + dz)))) return false
  return true
}

export function addLink(ix: Index, a: string, b: string): MiniMap {
  const l = link(a, b)
  if (ix.links.has(l) || !canLink(ix, a, b)) return ix.map
  return touch(ix.map, { roads: [...ix.map.roads, l], trees: without(ix.map.trees, new Set([a, b])) })
}

/** Take away every road touching a tile, and its roundabout. */
export function clearRoads(ix: Index, t: string): MiniMap {
  const roads = ix.map.roads.filter((l) => {
    const [a, b] = ends(l)
    return a !== t && b !== t
  })
  if (roads.length === ix.map.roads.length && !ix.roundabouts.has(t)) return ix.map
  return touch(ix.map, { roads, roundabouts: without(ix.map.roundabouts, t) })
}

export function canRoundabout(ix: Index, t: string) {
  return ix.adj.has(t) && !ix.occ.has(t) && !ix.water.has(t)
}

export function toggleRoundabout(ix: Index, t: string): MiniMap {
  if (ix.roundabouts.has(t)) return touch(ix.map, { roundabouts: without(ix.map.roundabouts, t) })
  if (!canRoundabout(ix, t)) return ix.map
  return touch(ix.map, { roundabouts: [...ix.map.roundabouts, t] })
}

export function canHome(ix: Index, t: string, self?: string) {
  const [x, z] = xz(t)
  const o = ix.occ.get(t)
  return inside(ix.map, x, z) && (!o || o.id === self) && !ix.water.has(t) && (!ix.adj.has(t) || !!self)
}

const newId = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A road on a tile next door (straight across, not diagonally) that isn't part of a building. */
function roadBeside(ix: Index, tiles: string[]): [string, string] | null {
  const own = new Set(tiles)
  for (const t of tiles) {
    const [x, z] = xz(t)
    for (const [dx, dz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const n = tk(x + dx, z + dz)
      if (!own.has(n) && ix.adj.has(n) && !ix.occ.has(n)) return [t, n]
    }
  }
  return null
}

/** Join a building to a road beside it, if it has no road yet. */
function driveway(m: MiniMap, active: Set<string>, tiles: string[]): MiniMap {
  const ix = buildIndex(m, active)
  if (tiles.some((t) => ix.adj.has(t))) return m
  const pair = roadBeside(ix, tiles)
  return pair ? { ...m, roads: [...m.roads, link(pair[0], pair[1])] } : m
}

export function addHome(ix: Index, t: string, site: string, active: Set<string>): MiniMap {
  if (!canHome(ix, t)) return ix.map
  const [x, z] = xz(t)
  const m = touch(ix.map, { homes: [...ix.map.homes, { id: newId(), site, x, z }], trees: without(ix.map.trees, t) })
  return driveway(m, active, [t])
}

export type Layer = 'road' | 'home' | 'tree' | 'water'

/** What the eraser takes from a tile first. */
export function topLayer(ix: Index, t: string): Layer | null {
  const o = ix.occ.get(t)
  if (o?.kind === 'home') return 'home'
  if (ix.adj.has(t)) return 'road'
  if (ix.trees.has(t)) return 'tree'
  if (ix.water.has(t)) return 'water'
  return null
}

export function erase(ix: Index, t: string, layer: Layer): MiniMap {
  if (layer === 'road') return clearRoads(ix, t)
  if (layer === 'tree') return ix.trees.has(t) ? touch(ix.map, { trees: without(ix.map.trees, t) }) : ix.map
  if (layer === 'water') return ix.water.has(t) ? touch(ix.map, { water: without(ix.map.water, t) }) : ix.map
  const o = ix.occ.get(t)
  if (o?.kind !== 'home') return ix.map
  return touch(clearRoads(ix, t), { homes: ix.map.homes.filter((h) => h.id !== o.id) })
}

export function setTree(ix: Index, t: string, on: boolean): MiniMap {
  if (!on) return ix.trees.has(t) ? touch(ix.map, { trees: without(ix.map.trees, t) }) : ix.map
  const [x, z] = xz(t)
  if (!inside(ix.map, x, z) || ix.trees.has(t) || ix.occ.has(t) || ix.adj.has(t) || ix.water.has(t)) return ix.map
  return touch(ix.map, { trees: [...ix.map.trees, t] })
}

export function setWater(ix: Index, t: string, on: boolean): MiniMap {
  if (!on) return ix.water.has(t) ? touch(ix.map, { water: without(ix.map.water, t) }) : ix.map
  const [x, z] = xz(t)
  if (!inside(ix.map, x, z) || ix.water.has(t) || ix.occ.has(t)) return ix.map
  return touch(ix.map, { water: [...ix.map.water, t], trees: without(ix.map.trees, t), roundabouts: without(ix.map.roundabouts, t) })
}

/** Can a site's building stand with its corner at x, z? Roads there make way; water and other buildings don't. */
export function canPlot(ix: Index, id: string, x: number, z: number): boolean {
  const p = ix.map.sites[id]
  if (!p) return false
  for (const t of plotTiles({ ...p, x, z })) {
    const [tx, tz] = xz(t)
    const o = ix.occ.get(t)
    if (!inside(ix.map, tx, tz) || ix.water.has(t) || (o && o.id !== id)) return false
  }
  return true
}

/** Roads that ran into a building's old spot go with it; roads under its new spot make way; links reaching in become its entrances. */
function clearFor(m: MiniMap, old: Set<string>, now: Set<string>): Partial<MiniMap> {
  const roads = m.roads.filter((l) => {
    const [a, b] = ends(l)
    if (old.has(a) || old.has(b)) return false
    if (now.has(a) && now.has(b)) return false
    const [ax, az] = xz(a)
    const [bx, bz] = xz(b)
    // a diagonal can't reach into a building
    if (ax !== bx && az !== bz && (now.has(a) || now.has(b) || now.has(tk(bx, az)) || now.has(tk(ax, bz)))) return false
    return true
  })
  return { roads, trees: without(m.trees, now), roundabouts: without(m.roundabouts, now) }
}

export function moveSite(ix: Index, id: string, x: number, z: number, active: Set<string>): MiniMap {
  const p = ix.map.sites[id]
  if (!p || (p.x === x && p.z === z) || !canPlot(ix, id, x, z)) return ix.map
  const next = { ...p, x, z }
  const m = touch(ix.map, { ...clearFor(ix.map, new Set(plotTiles(p)), new Set(plotTiles(next))), sites: { ...ix.map.sites, [id]: next } })
  return driveway(m, active, plotTiles(next))
}

export function moveHome(ix: Index, id: string, x: number, z: number, active: Set<string>): MiniMap {
  const h = ix.map.homes.find((o) => o.id === id)
  const t = tk(x, z)
  if (!h || (h.x === x && h.z === z) || !canHome(ix, t, id) || ix.adj.has(t)) return ix.map
  const m = touch(ix.map, { ...clearFor(ix.map, new Set([tk(h.x, h.z)]), new Set([t])), homes: ix.map.homes.map((o) => (o.id === id ? { ...o, x, z } : o)) })
  return driveway(m, active, [t])
}

// --- Laying out a city ---------------------------------------------------------------------------

type Rand = () => number

/** A small seeded random number generator (mulberry32), so a seed always draws the same city. */
export function rand(seed: number): Rand {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
]

/** Typed-array copy of the map for the layout code: what stands where, as numbers. */
interface Grid {
  cols: number
  rows: number
  /** -1 free, else the building's number in `ids` */
  occ: Int32Array
  ids: string[]
  water: Uint8Array
  road: Uint8Array
  /** links as min * n + max */
  lk: Set<number>
}

function gridOf(m: MiniMap, active: Set<string>): Grid {
  const { cols, rows } = m
  const n = cols * rows
  const g: Grid = { cols, rows, occ: new Int32Array(n).fill(-1), ids: [], water: new Uint8Array(n), road: new Uint8Array(n), lk: new Set() }
  const at = (k: string) => {
    const [x, z] = xz(k)
    return x >= 0 && z >= 0 && x < cols && z < rows ? z * cols + x : -1
  }
  for (const [id, p] of Object.entries(m.sites)) if (active.has(id)) mark(g, plotTiles(p).map(at), id)
  for (const h of m.homes) if (active.has(h.site)) mark(g, [at(tk(h.x, h.z))], h.id)
  for (const k of m.water) {
    const i = at(k)
    if (i >= 0) g.water[i] = 1
  }
  for (const l of m.roads) {
    const [a, b] = ends(l).map(at)
    if (a < 0 || b < 0) continue
    g.road[a] = g.road[b] = 1
    g.lk.add(Math.min(a, b) * n + Math.max(a, b))
  }
  return g
}

function mark(g: Grid, tiles: number[], id: string) {
  const n = g.ids.push(id) - 1
  for (const i of tiles) if (i >= 0) g.occ[i] = n
}

/** A river from the top of the map to the bottom, two or three tiles wide, wandering a little. */
function river(cols: number, rows: number, r: Rand): string[] {
  const out = new Set<string>()
  let x = Math.round(cols * (0.5 + r() * 0.18))
  let drift = 0
  for (let z = 0; z < rows; z++) {
    if (r() < 0.4) drift = clamp(drift + (r() < 0.5 ? -1 : 1), -1, 1)
    if (r() < 0.55) x = clamp(x + drift, 4, cols - 6)
    const w = r() < 0.18 ? 3 : 2
    for (let i = 0; i < w; i++) out.add(tk(x + i, z))
  }
  return [...out]
}

/** Is everything within `rad` tiles of x, z on the map, dry and free of buildings (and the tile itself free of road)? */
function freeAround(g: Grid, x: number, z: number, rad: number) {
  for (let dx = -rad; dx <= rad; dx++)
    for (let dz = -rad; dz <= rad; dz++) {
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= g.cols || nz >= g.rows) return false
      const i = nz * g.cols + nx
      if (g.occ[i] >= 0 || g.water[i]) return false
    }
  return !g.road[z * g.cols + x]
}

/** The best free spot for a w x d building: away from the others, not too near the edge. */
function spotFor(m: MiniMap, g: Grid, w: number, d: number, r: Rand, active: Set<string>): [number, number] | null {
  const plots = Object.entries(m.sites)
    .filter(([id]) => active.has(id))
    .map(([, p]) => p)
  let best: [number, number] | null = null
  let bestScore = -Infinity
  let found = 0
  for (let tries = 0; tries < 600 && found < 60; tries++) {
    const x = 2 + Math.floor(r() * (m.cols - w - 3))
    const z = 2 + Math.floor(r() * (m.rows - d - 3))
    let ok = true
    for (let dx = -1; dx <= w && ok; dx++)
      for (let dz = -1; dz <= d && ok; dz++) {
        const i = (z + dz) * g.cols + x + dx
        if (g.occ[i] >= 0 || g.water[i] || g.road[i]) ok = false
      }
    if (!ok) continue
    found++
    const cx = x + w / 2
    const cz = z + d / 2
    let near = 12
    for (const p of plots) near = Math.min(near, Math.hypot(cx - p.x - p.w / 2, cz - p.z - p.d / 2) - (Math.max(p.w, p.d) + Math.max(w, d)) / 2)
    let homes = 5
    for (const h of m.homes) if (active.has(h.site)) homes = Math.min(homes, Math.hypot(cx - h.x - 0.5, cz - h.z - 0.5))
    const score = Math.min(near, 7) + homes * 0.4 - Math.hypot(cx - m.cols / 2, cz - m.rows / 2) * 0.07 + r() * 0.6
    if (score > bestScore) {
      bestScore = score
      best = [x, z]
    }
  }
  return best
}

/** A few homes for a site, clustered somewhere else on the map so its cars have a drive. */
function homesFor(m: MiniMap, g: Grid, site: string, count: number, r: Rand, active: Set<string>) {
  const p = m.sites[site]
  const px = p.x + p.w / 2
  const pz = p.z + p.d / 2
  // where the other sites' homes are
  const groups = new Map<string, [number, number, number]>()
  for (const h of m.homes) {
    if (!active.has(h.site)) continue
    const c = groups.get(h.site) ?? [0, 0, 0]
    groups.set(h.site, [c[0] + h.x, c[1] + h.z, c[2] + 1])
  }
  const centres = [...groups.values()].map(([x, z, n]) => [x / n, z / n])
  let hub: [number, number] | null = null
  let best = -Infinity
  for (let i = 0; i < 120; i++) {
    const x = 2 + Math.floor(r() * (m.cols - 4))
    const z = 2 + Math.floor(r() * (m.rows - 4))
    const dist = Math.hypot(x + 0.5 - px, z + 0.5 - pz)
    if (dist < 5 || dist > 17 || !freeAround(g, x, z, 1)) continue
    let apart = 8
    for (const [cx, cz] of centres) apart = Math.min(apart, Math.hypot(x - cx, z - cz))
    const score = apart - Math.abs(dist - 10) * 0.25 + r() * 2
    if (score > best) {
      best = score
      hub = [x, z]
    }
  }
  hub ??= [Math.round(px), Math.min(m.rows - 3, p.z + p.d + 3)]
  for (let k = 0, tries = 0; k < count && tries < 80; tries++) {
    const x = hub[0] + Math.round((r() + r() + r() - 1.5) * 3)
    const z = hub[1] + Math.round((r() + r() + r() - 1.5) * 3)
    if (!freeAround(g, x, z, 1)) continue
    const h = { id: `h${site.slice(0, 12)}-${k}-${Math.floor(r() * 1e6).toString(36)}`, site, x, z }
    m.homes.push(h)
    mark(g, [z * g.cols + x], h.id)
    k++
  }
}

export class Heap {
  private k: number[] = []
  private v: number[] = []
  get size() {
    return this.k.length
  }
  push(key: number, val: number) {
    const { k, v } = this
    let i = k.length
    k.push(key)
    v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]
      v[i] = v[p]
      i = p
    }
    k[i] = key
    v[i] = val
  }
  pop(): [number, number] {
    const { k, v } = this
    const top: [number, number] = [k[0], v[0]]
    const lk = k.pop()!
    const lv = v.pop()!
    const n = k.length
    if (n) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]
        v[i] = v[c]
        i = c
      }
      k[i] = lk
      v[i] = lv
    }
    return top
  }
}

/** The road a planner would draw from a home to its site: straight where it can, sharing roads, short bridges. */
function pave(g: Grid, from: number, p: Plot, site: number): number[] | null {
  const { cols, rows } = g
  const n = cols * rows
  const cost = new Float32Array(n * 9).fill(Infinity)
  const back = new Int32Array(n * 9).fill(-1)
  const heap = new Heap()
  const h = (i: number) => {
    const x = i % cols
    const z = (i / cols) | 0
    return Math.max(p.x - x, 0, x - (p.x + p.w - 1), p.z - z, z - (p.z + p.d - 1)) * 0.3
  }
  const start = from * 9 + 8
  cost[start] = 0
  heap.push(h(from), start)
  while (heap.size) {
    const [f, s] = heap.pop()
    const i = (s / 9) | 0
    const dir = s % 9
    if (f > cost[s] + h(i) + 1e-4) continue
    if (g.occ[i] === site) {
      const path: number[] = []
      for (let k = s; k >= 0; k = back[k]) path.push((k / 9) | 0)
      return path.reverse()
    }
    if (i !== from && g.occ[i] >= 0) continue
    const x = i % cols
    const z = (i / cols) | 0
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS[d]
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue
      const j = nz * cols + nx
      if (g.occ[j] >= 0 && g.occ[j] !== site) continue
      const diag = d >= 4
      if (diag && (g.occ[j] >= 0 || g.occ[i] >= 0 || g.occ[z * cols + nx] >= 0 || g.occ[nz * cols + x] >= 0 || g.water[i] || g.water[j])) continue
      let c = diag ? 1.5 : 1
      if (g.water[j]) c *= 3.5
      if (g.lk.has(Math.min(i, j) * n + Math.max(i, j))) c *= 0.15
      else if (g.road[j]) c *= 0.5
      if (dir !== 8 && dir !== d) c += 0.45
      const ns = j * 9 + d
      const nc = cost[s] + c
      if (nc < cost[ns]) {
        cost[ns] = nc
        back[ns] = s
        heap.push(nc + h(j), ns)
      }
    }
  }
  return null
}

function lay(m: MiniMap, g: Grid, path: number[], have: Set<string>) {
  const n = g.cols * g.rows
  const key = (i: number) => tk(i % g.cols, (i / g.cols) | 0)
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]
    const b = path[k]
    const l = link(key(a), key(b))
    g.road[a] = g.road[b] = 1
    g.lk.add(Math.min(a, b) * n + Math.max(a, b))
    if (!have.has(l)) {
      have.add(l)
      m.roads.push(l)
    }
  }
}

/** Make room at the edges: every tile moves in by dx, dz, and the river runs on to the new edge. */
function enlarge(m: MiniMap, dx: number, dz: number) {
  const shift = (k: string) => {
    const [x, z] = xz(k)
    return tk(x + dx, z + dz)
  }
  const water = new Set(m.water.map(shift))
  for (const k of m.water) {
    const [x, z] = xz(k)
    for (let i = 1; i <= dz; i++) {
      if (z === 0) water.add(tk(x + dx, dz - i))
      if (z === m.rows - 1) water.add(tk(x + dx, z + dz + i))
    }
    for (let i = 1; i <= dx; i++) {
      if (x === 0) water.add(tk(dx - i, z + dz))
      if (x === m.cols - 1) water.add(tk(x + dx + i, z + dz))
    }
  }
  m.cols += dx * 2
  m.rows += dz * 2
  m.water = [...water]
  m.roads = m.roads.map((l) => {
    const [a, b] = ends(l)
    return link(shift(a), shift(b))
  })
  m.trees = m.trees.map(shift)
  m.roundabouts = m.roundabouts.map(shift)
  for (const p of Object.values(m.sites)) {
    p.x += dx
    p.z += dz
  }
  for (const h of m.homes) {
    h.x += dx
    h.z += dz
  }
}

const busy = (p: Project) => p.commitsWeek + (floorsIn(p) || 1) * 2

/** Buildings for new sites, a few homes each, and roads from the homes to them. Changes `m` in place. */
function settle(m: MiniMap, active: Set<string>, add: Project[], all: Project[], r: Rand) {
  const top = Math.max(1, ...all.map(busy))
  const placed: Project[] = []
  let g = gridOf(m, active)
  for (const p of [...add].sort((a, b) => busy(b) - busy(a))) {
    const s = busy(p) / top
    let [w, d] = s >= 0.8 ? [4, 3] : s >= 0.55 ? [3, 3] : s >= 0.3 ? [3, 2] : [2, 2]
    if (w !== d && r() < 0.5) [w, d] = [d, w]
    let spot = spotFor(m, g, w, d, r, active)
    for (let grow = 0; !spot && grow < 4; grow++) {
      enlarge(m, 4, 3)
      g = gridOf(m, active)
      spot = spotFor(m, g, w, d, r, active)
    }
    if (!spot) continue
    const used = new Set(Object.values(m.sites).map((o) => o.color))
    let color = 0
    while (used.has(color)) color++
    m.sites[p.id] = { x: spot[0], z: spot[1], w, d, color }
    mark(
      g,
      plotTiles(m.sites[p.id]).map((k) => {
        const [x, z] = xz(k)
        return z * g.cols + x
      }),
      p.id,
    )
    placed.push(p)
  }
  for (const p of placed) homesFor(m, g, p.id, clamp(2 + Math.round(p.commitsWeek / 10), 2, 5), r, active)
  // nearest homes first, so the longer roads can follow the shorter ones
  const near = (h: Home) => {
    const p = m.sites[h.site]
    return Math.hypot(h.x - p.x - p.w / 2, h.z - p.z - p.d / 2)
  }
  const ids = new Set(placed.map((p) => p.id))
  const have = new Set(m.roads)
  for (const h of m.homes.filter((o) => ids.has(o.site)).sort((a, b) => near(a) - near(b))) {
    const site = g.ids.indexOf(h.site)
    const path = pave(g, h.z * g.cols + h.x, m.sites[h.site], site)
    if (path) lay(m, g, path, have)
  }
  // no trees under the new roads and buildings
  const ix = buildIndex(m, active)
  m.trees = m.trees.filter((t) => !ix.adj.has(t) && !ix.occ.has(t))
}

/** Roundabouts on the busiest crossroads, spaced out. */
function junctions(m: MiniMap, active: Set<string>, count: number): string[] {
  const ix = buildIndex(m, active)
  const picks: [number, number][] = []
  const out: string[] = []
  const cands = [...ix.adj.entries()].filter(([t, nb]) => nb.length >= 3 && !ix.occ.has(t) && !ix.water.has(t)).sort((a, b) => b[1].length - a[1].length)
  for (const [t] of cands) {
    if (out.length >= count) break
    const [x, z] = xz(t)
    if (picks.some(([px, pz]) => Math.max(Math.abs(px - x), Math.abs(pz - z)) < 5)) continue
    picks.push([x, z])
    out.push(t)
  }
  return out
}

/** Smooth value noise, for clumps of trees. */
function noise(seed: number) {
  const h = (x: number, z: number) => {
    let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041)) | 0
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  return (x: number, z: number) => {
    const x0 = Math.floor(x)
    const z0 = Math.floor(z)
    const fx = x - x0
    const fz = z - z0
    const sx = fx * fx * (3 - 2 * fx)
    const sz = fz * fz * (3 - 2 * fz)
    const a = h(x0, z0)
    const b = h(x0 + 1, z0)
    const c = h(x0, z0 + 1)
    const d = h(x0 + 1, z0 + 1)
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
  }
}

function forest(m: MiniMap, active: Set<string>, r: Rand): string[] {
  const ix = buildIndex(m, active)
  const n = noise(m.seed)
  const nearPlot = new Set<string>()
  for (const [, p] of ix.sites) for (const t of plotTiles({ x: p.x - 1, z: p.z - 1, w: p.w + 2, d: p.d + 2 })) nearPlot.add(t)
  const out: string[] = []
  for (let x = 0; x < m.cols; x++)
    for (let z = 0; z < m.rows; z++) {
      const t = tk(x, z)
      if (ix.adj.has(t) || ix.occ.has(t) || ix.water.has(t) || nearPlot.has(t)) continue
      const edge = Math.min(x, z, m.cols - 1 - x, m.rows - 1 - z) < 2 ? 0.12 : 0
      if (n(x / 4.2, z / 4.2) * 0.8 + r() * 0.3 + edge > 0.78) out.push(t)
    }
  return out
}

/** A whole new city for these projects. */
export function generate(projects: Project[], seed: number): MiniMap {
  const n = Math.max(1, projects.length)
  const cols = clamp(Math.round(Math.sqrt(n * 100 * 1.6)), 30, 80)
  const rows = Math.round(cols / 1.6)
  const r = rand(seed)
  const m: MiniMap = { v: 1, at: Date.now(), edited: false, seed, cols, rows, sites: {}, homes: [], roads: [], water: river(cols, rows, r), trees: [], roundabouts: [] }
  const active = new Set(projects.map((p) => p.id))
  settle(m, active, projects, projects, r)
  m.roundabouts = junctions(m, active, Math.max(1, Math.round(n / 3)))
  m.trees = forest(m, active, r)
  return m
}

/** Room, homes and roads for projects that aren't on the map yet; everything else stays where you put it. */
export function withSites(map: MiniMap, projects: Project[]): MiniMap {
  const missing = projects.filter((p) => !map.sites[p.id])
  const active = new Set(projects.map((p) => p.id))
  // a site that comes back (unhidden) to find its spot taken moves somewhere free
  const ix = buildIndex(map, active)
  const blocked = projects.filter((p) => map.sites[p.id] && !canPlot(ix, p.id, map.sites[p.id].x, map.sites[p.id].z))
  if (!missing.length && !blocked.length) return map
  const m: MiniMap = structuredClone(map)
  for (const p of blocked) {
    delete m.sites[p.id]
    m.homes = m.homes.filter((h) => h.site !== p.id)
  }
  settle(m, active, [...missing, ...blocked], projects, rand(Date.now() % 1e9))
  m.at = Date.now()
  return m
}

/** Is this a map we can draw (from storage, or the other computer)? */
export function isMap(m: unknown): m is MiniMap {
  const o = m as MiniMap | null
  return !!o && o.v === 1 && typeof o.at === 'number' && Number.isInteger(o.cols) && Number.isInteger(o.rows) && o.cols > 4 && o.rows > 4 && o.cols <= 400 && o.rows <= 400 && !!o.sites && typeof o.sites === 'object' && [o.homes, o.roads, o.water, o.trees, o.roundabouts].every(Array.isArray)
}

/** Which of two copies of a map to keep: one you've changed beats one laid out by the app, then the newest. */
export const newer = (a: MiniMap | null | undefined, b: MiniMap | null | undefined) => !!a && (!b || (a.edited && !b.edited) || (a.edited === b.edited && a.at > b.at))
