import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { Project } from '../../data/types'
import { useApp } from '../../store'
import type { Impulses } from '../../shared/pulse'
import { colorOf, link, tk, type Home, type Index } from './map'
import { drive, homeSpot, routeFrom, sample, siteSpot, type Drive, type Pose } from './drive'
import { useMini } from './state'
import { mix, noRay } from './look'

// Every home has two cars in its colour. Now and then one drives to its site,
// parks for a moment and comes home again; busier sites send them out more
// often, and a notification sends a site's cars out straight away. Cars with
// no road to their site wait at home. Turning the cars off in Settings lets
// the ones out on the road finish their trip.

const BODY = new RoundedBoxGeometry(0.26, 0.09, 0.15, 2, 0.035)
const CABIN = new THREE.BoxGeometry(0.12, 0.055, 0.12)
/** tiles a second */
const SPEED = 1.5

interface Car {
  key: string
  home: string
  site: string
  slot: number
  /** which of the parking spaces at the site it takes */
  n: number
  state: 'home' | 'out' | 'park' | 'back'
  until: number
  t0: number
  drive: Drive | null
  seg: number
  spot: [number, number, number] | null
  x: number
  z: number
  yaw: number
  pop: number
  placed: boolean
}

/** Is the car's trip still drivable after an edit? */
function still(ix: Index, c: Car, h: Home | undefined): boolean {
  const d = c.drive
  if (!h || !d) return !!h
  const t = d.tiles
  const homeTile = c.state === 'back' ? t[t.length - 1] : t[0]
  const siteTile = c.state === 'back' ? t[0] : t[t.length - 1]
  if (homeTile !== tk(h.x, h.z)) return false
  const o = ix.occ.get(siteTile)
  if (o?.kind !== 'site' || o.id !== c.site) return false
  for (let i = 1; i < t.length; i++) if (!ix.links.has(link(t[i - 1], t[i]))) return false
  return true
}

export function Cars({ ix, projects, impulses }: { ix: Index; projects: Project[]; impulses: Impulses }) {
  const clock = useThree((s) => s.clock)
  const bodies = useRef<THREE.InstancedMesh>(null!)
  const cabins = useRef<THREE.InstancedMesh>(null!)
  const cars = useRef<Car[]>([])
  const ixRef = useRef(ix)
  ixRef.current = ix
  const homes = useMemo(() => new Map(ix.homes.map((h) => [h.id, h])), [ix.homes])
  const homesRef = useRef(homes)
  homesRef.current = homes
  // busier sites send their cars out more often
  const pace = useMemo(() => new Map(projects.map((p) => [p.id, 0.5 + Math.min(1.5, p.commitsWeek / 12)])), [projects])
  const paceRef = useRef(pace)
  paceRef.current = pace
  const rushed = useRef(new Map<string, number>())
  const cap = Math.max(16, Math.ceil((ix.homes.length * 2) / 16) * 16)

  // two cars per home, kept across edits
  useEffect(() => {
    const old = new Map(cars.current.map((c) => [c.key, c]))
    const next: Car[] = []
    for (const h of ix.homes)
      for (let slot = 0; slot < 2; slot++) {
        const key = `${h.id}:${slot}`
        const c = old.get(key) ?? { key, home: h.id, site: h.site, slot, n: next.length, state: 'home', until: -1, t0: 0, drive: null, seg: 0, spot: null, x: 0, z: 0, yaw: 0, pop: -99, placed: false }
        c.site = h.site
        next.push(c)
      }
    // a trip an edit has cut short: the car is back home
    const t = clock.elapsedTime
    for (const c of next) {
      if (c.state === 'home' || still(ix, c, homes.get(c.home))) continue
      c.state = 'home'
      c.drive = null
      c.spot = null
      c.until = t + 1 + Math.random() * 2
      c.placed = false
    }
    cars.current = next
    const body = new THREE.Color()
    const roof = new THREE.Color()
    next.forEach((c, i) => {
      const col = colorOf(ix.map.sites[c.site]?.color ?? 0)
      bodies.current.setColorAt(i, body.set(col))
      cabins.current.setColorAt(i, roof.set(mix(col, '#ffffff', 0.55)))
    })
    if (bodies.current.instanceColor) bodies.current.instanceColor.needsUpdate = true
    if (cabins.current.instanceColor) cabins.current.instanceColor.needsUpdate = true
  }, [ix, homes, cap, clock])

  const pose = useMemo<Pose>(() => ({ x: 0, z: 0, dx: 1, dz: 0 }), [])
  const dummy = useMemo(() => new THREE.Object3D(), [])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const ix = ixRef.current
    const moving = useApp.getState().cars
    const list = cars.current
    // something happened at a site: its cars set off
    for (const [id, imp] of impulses)
      if ((rushed.current.get(id) ?? -1) < imp.at) {
        rushed.current.set(id, imp.at)
        for (const c of list) if (c.site === id && c.state === 'home') c.until = Math.min(c.until, t + Math.random() * 1.5)
      }
    const k = 1 - Math.exp(-dt * 12)
    let i = 0
    for (const c of list) {
      const h = homesRef.current.get(c.home)
      if (!h) continue
      const pace = paceRef.current.get(c.site) ?? 1
      if (c.until < 0) c.until = t + 1 + (Math.random() * 10) / pace
      if (c.state === 'home' && moving && t >= c.until) {
        const route = routeFrom(ix, tk(h.x, h.z), c.site)
        if (route) {
          c.drive = drive(ix, route)
          c.state = 'out'
          c.t0 = t
          c.seg = 0
        } else c.until = t + 4 + Math.random() * 6
      }
      if ((c.state === 'out' || c.state === 'back') && (t - c.t0) * SPEED >= c.drive!.len) {
        if (c.state === 'out') {
          c.state = 'park'
          c.spot = siteSpot(ix, c.drive!, c.n)
          c.until = t + 2 + Math.random() * 3
          useMini.getState().trip()
        } else {
          c.state = 'home'
          c.drive = null
          c.until = t + (5 + Math.random() * 10) / pace
        }
      }
      if (c.state === 'park' && t >= c.until) {
        const route = routeFrom(ix, tk(h.x, h.z), c.site)
        c.spot = null
        if (route) {
          c.drive = drive(ix, route.reverse())
          c.state = 'back'
          c.t0 = t
          c.seg = 0
        } else {
          c.state = 'home'
          c.drive = null
          c.placed = false
          c.until = t + 3
        }
      }

      let tx: number
      let tz: number
      let tyaw: number
      if (c.state === 'out' || c.state === 'back') {
        sample(c.drive!, (t - c.t0) * SPEED, c, pose)
        tx = pose.x
        tz = pose.z
        tyaw = Math.atan2(-pose.dz, pose.dx)
      } else [tx, tz, tyaw] = c.state === 'park' ? c.spot! : homeSpot(ix, h, c.slot)
      if (!c.placed) {
        c.x = tx
        c.z = tz
        c.yaw = tyaw
        c.placed = true
        c.pop = t
      }
      c.x += (tx - c.x) * k
      c.z += (tz - c.z) * k
      const turn = ((((tyaw - c.yaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI
      c.yaw += turn * k

      const grow = Math.min(1, (t - c.pop) / 0.3)
      dummy.position.set(c.x, 0.075, c.z)
      dummy.rotation.set(0, c.yaw, 0)
      dummy.scale.setScalar(Math.max(0.001, grow))
      dummy.updateMatrix()
      bodies.current.setMatrixAt(i, dummy.matrix)
      dummy.position.set(c.x - Math.cos(c.yaw) * 0.025, 0.145, c.z + Math.sin(c.yaw) * 0.025)
      dummy.updateMatrix()
      cabins.current.setMatrixAt(i, dummy.matrix)
      i++
    }
    bodies.current.count = i
    cabins.current.count = i
    bodies.current.instanceMatrix.needsUpdate = true
    cabins.current.instanceMatrix.needsUpdate = true
  })

  return (
    <>
      <instancedMesh key={`b${cap}`} ref={bodies} args={[BODY, undefined, cap]} castShadow frustumCulled={false} raycast={noRay}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh key={`c${cap}`} ref={cabins} args={[CABIN, undefined, cap]} frustumCulled={false} raycast={noRay}>
        <meshLambertMaterial />
      </instancedMesh>
    </>
  )
}
