import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { Project } from '../../data/types'
import { useData } from '../../data/store'
import { signals } from '../../data/derive'
import { useApp, prefersReducedMotion } from '../../store'
import type { Tier } from '../../shared/quality'
import { Anchor } from '../../shared/Labels'
import { since, useImpulses, type Impulses } from '../../shared/pulse'

// Township: every project is a house on the village green. Peg people walk
// the lanes (busier sites get more visitors), and what's happening to a
// project plays out around its house: scaffolding and hard hats while it
// builds, a delivery van while it deploys, smoke when it breaks, a queue of
// grumbling visitors for open issues, confetti when it ships.

const RING = 6
const ISLAND_PAD = 6.5
const STOREY = 0.78
const WALKERS = 40
const LEVEL: Record<string, string> = { info: '#5b8def', progress: '#f5a524', success: '#36b37e', warning: '#e8a317', critical: '#e5484d' }
const BODY = ['#ff7a59', '#5b8def', '#36b37e', '#f5a524', '#a77bf3', '#ef5da8', '#2ec4b6', '#ffd166', '#8ecae6', '#e76f51']
const SKIN = ['#f6d5b8', '#e8b48f', '#c98e64', '#8d5a3b', '#f2c9a0']
const WALL = ['#fff4e0', '#fde8e1', '#e9f4ea', '#e8eefc', '#fff0cc', '#f3e8ff']
const CLAUDE = '#d97757'

const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))
const noRay = () => null
const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export interface Plot {
  project: Project
  index: number
  angle: number
  /** house centre */
  x: number
  z: number
  /** door, on the green side */
  dx: number
  dz: number
  storeys: number
  w: number
  d: number
  wall: string
}

export function townRadius(n: number) {
  return Math.max(10.5, (n * 2.9) / (Math.PI * 2) + 6.5)
}

export function usePlots(): Plot[] {
  const projects = useData((s) => s.projects)
  const key = projects.map((p) => `${p.id}:${p.commitsWeek}:${p.pages.length}`).join('|')
  return useMemo(() => {
    const n = Math.max(1, projects.length)
    const hr = townRadius(n)
    return projects.map((project, i) => {
      const angle = (i / n) * Math.PI * 2 + 0.3
      const storeys = THREE.MathUtils.clamp(1 + Math.round(project.commitsWeek / 12), 1, 3)
      const w = 1.6 + Math.min(project.pages.length, 6) * 0.13
      const d = 1.45
      const x = Math.sin(angle) * hr
      const z = Math.cos(angle) * hr
      const doorR = hr - d / 2 - 0.05
      return { project, index: i, angle, x, z, dx: Math.sin(angle) * doorR, dz: Math.cos(angle) * doorR, storeys, w, d, wall: WALL[i % WALL.length] }
    })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

// --- shared geometry ------------------------------------------------------------------------------

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  body: new THREE.CylinderGeometry(0.11, 0.15, 0.4, 14).translate(0, 0.2, 0),
  head: new THREE.SphereGeometry(0.115, 16, 12).translate(0, 0.52, 0),
  hat: new THREE.SphereGeometry(0.13, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.56, 0),
  // a gable: ridge along x, apex up, base at y = -0.5, eaves at z = ±0.866
  roof: new THREE.CylinderGeometry(1, 1, 1, 3, 1).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2),
  puff: new THREE.IcosahedronGeometry(0.22, 1),
  bubble: new THREE.SphereGeometry(0.09, 12, 8),
  ring: new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2),
  trunk: new THREE.CylinderGeometry(0.08, 0.11, 0.5, 6).translate(0, 0.25, 0),
  crown: new THREE.ConeGeometry(0.55, 1.3, 7).translate(0, 1.05, 0),
  crown2: new THREE.IcosahedronGeometry(0.6, 0).translate(0, 0.95, 0),
  confetti: new THREE.PlaneGeometry(0.09, 0.05),
  wheel: new THREE.CylinderGeometry(0.11, 0.11, 0.08, 10).rotateX(Math.PI / 2),
}

function lambert(color: string, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra })
}

// --- the island ---------------------------------------------------------------------------------

function Island({ radius, shadows }: { radius: number; shadows: boolean }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows} raycast={noRay}>
        <circleGeometry args={[radius, 96]} />
        <meshLambertMaterial color="#9bd67a" />
      </mesh>
      <mesh position={[0, -0.6, 0]} raycast={noRay}>
        <cylinderGeometry args={[radius, radius * 0.94, 1.2, 96, 1, true]} />
        <meshLambertMaterial color="#b98a5e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -1.2, 0]} rotation={[Math.PI / 2, 0, 0]} raycast={noRay}>
        <circleGeometry args={[radius * 0.94, 96]} />
        <meshLambertMaterial color="#8d6443" />
      </mesh>
      {/* ring lane and the green */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow={shadows} raycast={noRay}>
        <ringGeometry args={[RING - 0.65, RING + 0.65, 96]} />
        <meshLambertMaterial color="#f1e2c4" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow={shadows} raycast={noRay}>
        <circleGeometry args={[3, 64]} />
        <meshLambertMaterial color="#efe6d8" />
      </mesh>
    </group>
  )
}

function Paths({ plots, shadows }: { plots: Plot[]; shadows: boolean }) {
  return (
    <group>
      {plots.map((p) => {
        const r0 = RING + 0.5
        const r1 = Math.hypot(p.dx, p.dz) + 0.2
        const len = r1 - r0
        const mid = (r0 + r1) / 2
        return (
          <mesh key={p.project.id} position={[Math.sin(p.angle) * mid, 0.011, Math.cos(p.angle) * mid]} rotation={[-Math.PI / 2, 0, -p.angle]} receiveShadow={shadows} raycast={noRay}>
            <planeGeometry args={[0.8, len]} />
            <meshLambertMaterial color="#f1e2c4" />
          </mesh>
        )
      })}
    </group>
  )
}

function Trees({ plots, radius, shadows }: { plots: Plot[]; radius: number; shadows: boolean }) {
  const trunks = useRef<THREE.InstancedMesh>(null!)
  const crowns = useRef<THREE.InstancedMesh>(null!)
  const spots = useMemo(() => {
    const out: [number, number, number][] = []
    const hr = townRadius(plots.length)
    for (let i = 0; out.length < 70 && i < 600; i++) {
      const a = rand(i) * Math.PI * 2
      const r = hr - 2.4 + rand(i + 99) * (radius - hr + 1.6)
      const x = Math.sin(a) * r
      const z = Math.cos(a) * r
      // keep clear of houses and their paths
      if (plots.some((p) => Math.hypot(p.x - x, p.z - z) < 2.6 || (Math.abs(Math.atan2(Math.sin(a - p.angle), Math.cos(a - p.angle))) < 0.16 && r < hr))) continue
      if (r > radius - 0.8 || r < RING + 1.6) continue
      out.push([x, z, 0.75 + rand(i + 7) * 0.6])
    }
    return out
  }, [plots, radius])
  useEffect(() => {
    const m = new THREE.Object3D()
    const c = new THREE.Color()
    spots.forEach(([x, z, s], i) => {
      m.position.set(x, 0, z)
      m.rotation.y = rand(i) * 6
      m.scale.setScalar(s)
      m.updateMatrix()
      trunks.current.setMatrixAt(i, m.matrix)
      crowns.current.setMatrixAt(i, m.matrix)
      crowns.current.setColorAt(i, c.set(['#4caf6d', '#5dbb63', '#3e9f62', '#76c35b'][i % 4]))
    })
    trunks.current.instanceMatrix.needsUpdate = true
    crowns.current.instanceMatrix.needsUpdate = true
    if (crowns.current.instanceColor) crowns.current.instanceColor.needsUpdate = true
  }, [spots])
  return (
    <group>
      <instancedMesh ref={trunks} args={[G.trunk, undefined, spots.length]} castShadow={shadows} raycast={noRay}>
        <meshLambertMaterial color="#8d6443" />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[G.crown, undefined, spots.length]} castShadow={shadows} raycast={noRay}>
        <meshLambertMaterial />
      </instancedMesh>
    </group>
  )
}

/** Claude HQ in the middle of the green: a little round tower whose star spins while Claude works. */
function TownHall({ shadows }: { shadows: boolean }) {
  const star = useRef<THREE.Group>(null!)
  const working = useData((s) => s.projects.some((p) => p.threads.some((t) => t.status === 'working')))
  const speed = useRef(0)
  useFrame((s, dt) => {
    speed.current = damp(speed.current, working ? 2.2 : 0.25, 2, dt)
    star.current.rotation.y += speed.current * dt
    star.current.position.y = 3.25 + Math.sin(s.clock.elapsedTime * 1.6) * 0.06
  })
  const starShape = useMemo(() => {
    const s = new THREE.Shape()
    for (let i = 0; i < 16; i++) {
      const r = i % 2 ? 0.1 : i % 4 === 0 ? 0.42 : 0.3
      const a = (i / 16) * Math.PI * 2
      if (i) s.lineTo(Math.sin(a) * r, Math.cos(a) * r)
      else s.moveTo(Math.sin(a) * r, Math.cos(a) * r)
    }
    return new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: false }).translate(0, 0, -0.04)
  }, [])
  return (
    <group>
      <mesh position={[0, 0.15, 0]} castShadow={shadows} receiveShadow={shadows} raycast={noRay}>
        <cylinderGeometry args={[1.25, 1.35, 0.3, 32]} />
        <meshLambertMaterial color="#e3d5c0" />
      </mesh>
      <mesh position={[0, 1.15, 0]} castShadow={shadows} raycast={noRay}>
        <cylinderGeometry args={[0.85, 0.9, 1.7, 24]} />
        <meshLambertMaterial color="#fff4e0" />
      </mesh>
      <mesh position={[0, 2.45, 0]} castShadow={shadows} raycast={noRay}>
        <coneGeometry args={[1.1, 0.95, 24]} />
        <meshLambertMaterial color={CLAUDE} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[Math.sin((i * Math.PI) / 2) * 0.86, 1.25, Math.cos((i * Math.PI) / 2) * 0.86]} rotation={[0, (i * Math.PI) / 2, 0]} raycast={noRay}>
          <planeGeometry args={[0.32, 0.5]} />
          <meshBasicMaterial color="#ffd77a" toneMapped={false} />
        </mesh>
      ))}
      <group ref={star}>
        <mesh geometry={starShape} raycast={noRay}>
          <meshBasicMaterial color={CLAUDE} toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

// --- peg people walking the lanes -------------------------------------------------------------------

interface Walker {
  mode: 0 | 1 | 2 | 3
  angle: number
  dir: number
  lane: number
  speed: number
  target: number
  s: number
  wait: number
  phase: number
  x: number
  z: number
  yaw: number
  jump: number
}

function Crowd({ plots, shadows, party }: { plots: Plot[]; shadows: boolean; party: MutableRefObject<{ at: number; plot: number }> }) {
  const bodies = useRef<THREE.InstancedMesh>(null!)
  const heads = useRef<THREE.InstancedMesh>(null!)
  const walkers = useMemo<Walker[]>(
    () =>
      Array.from({ length: WALKERS }, (_, i) => ({
        mode: 0,
        angle: rand(i * 3) * Math.PI * 2,
        dir: rand(i * 5) > 0.5 ? 1 : -1,
        lane: RING + (rand(i * 11) - 0.5) * 0.8,
        speed: 0.55 + rand(i * 13) * 0.45,
        target: 0,
        s: 0,
        wait: 0,
        phase: rand(i * 17) * 10,
        x: 0,
        z: 0,
        yaw: 0,
        jump: 0,
      })),
    [],
  )
  // busier sites (more commits this week) draw more visitors
  const pick = useMemo(() => {
    const weights = plots.map((p) => 1 + Math.min(30, p.project.commitsWeek) * 0.25 + (p.project.status === 'quiet' ? -0.6 : 0))
    const total = weights.reduce((a, b) => a + b, 0)
    return () => {
      let r = Math.random() * total
      for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return i
      return 0
    }
  }, [plots])
  useEffect(() => {
    walkers.forEach((w) => (w.target = plots.length ? pick() : 0))
    const c = new THREE.Color()
    walkers.forEach((_, i) => {
      bodies.current.setColorAt(i, c.set(BODY[i % BODY.length]))
      heads.current.setColorAt(i, c.set(SKIN[i % SKIN.length]))
    })
    if (bodies.current.instanceColor) bodies.current.instanceColor.needsUpdate = true
    if (heads.current.instanceColor) heads.current.instanceColor.needsUpdate = true
  }, [walkers, plots, pick])

  const m = useMemo(() => new THREE.Object3D(), [])
  useFrame((s, rawDt) => {
    const dt = prefersReducedMotion ? rawDt * 0.3 : rawDt
    const t = s.clock.elapsedTime
    const n = plots.length
    walkers.forEach((w, i) => {
      const px = w.x
      const pz = w.z
      const plot = plots[w.target % Math.max(1, n)]
      if (!plot) return
      if (w.mode === 0) {
        w.angle += (w.dir * w.speed * dt) / w.lane
        const diff = Math.atan2(Math.sin(plot.angle - w.angle), Math.cos(plot.angle - w.angle))
        if (Math.abs(diff) < 0.03) {
          if (Math.random() < 0.6) {
            w.mode = 1
            w.s = 0
          } else w.target = pick()
        } else if (Math.sign(diff) !== w.dir && Math.abs(diff) < 0.6 && Math.random() < 0.01) w.dir = -w.dir
        w.x = Math.sin(w.angle) * w.lane
        w.z = Math.cos(w.angle) * w.lane
      } else {
        const r0 = w.lane
        const r1 = Math.hypot(plot.dx, plot.dz) - 0.35
        const len = Math.max(0.5, r1 - r0)
        if (w.mode === 1) {
          w.s += (w.speed * dt) / len
          if (w.s >= 1) {
            w.s = 1
            w.mode = 2
            w.wait = 1 + Math.random() * 2.5
          }
        } else if (w.mode === 2) {
          w.wait -= dt
          if (w.wait <= 0) w.mode = 3
        } else {
          w.s -= (w.speed * dt) / len
          if (w.s <= 0) {
            w.mode = 0
            w.angle = plot.angle
            w.dir = Math.random() > 0.5 ? 1 : -1
            w.target = pick()
          }
        }
        const r = r0 + (r1 - r0) * w.s
        const side = (i % 2 ? 0.18 : -0.18) * (w.mode === 3 ? -1 : 1)
        w.x = Math.sin(plot.angle) * r + Math.cos(plot.angle) * side
        w.z = Math.cos(plot.angle) * r - Math.sin(plot.angle) * side
      }
      const vx = w.x - px
      const vz = w.z - pz
      const moving = Math.hypot(vx, vz) > 1e-4
      if (moving) {
        const yaw = Math.atan2(vx, vz)
        w.yaw += Math.atan2(Math.sin(yaw - w.yaw), Math.cos(yaw - w.yaw)) * Math.min(1, dt * 10)
      }
      // a party: everyone near the house that just shipped jumps for joy
      const pt = party.current
      const near = plots[pt.plot] && Math.hypot(w.x - plots[pt.plot].x, w.z - plots[pt.plot].z) < 6.5
      w.jump = t - pt.at < 2.2 && near ? Math.abs(Math.sin((t - pt.at) * 7 + i)) * 0.35 : damp(w.jump, 0, 8, dt)
      w.phase += dt * (moving ? 9 : 0)
      const bob = moving ? Math.abs(Math.sin(w.phase)) * 0.05 : 0
      m.position.set(w.x, bob + w.jump, w.z)
      m.rotation.set(0, w.yaw, moving ? Math.sin(w.phase) * 0.07 : 0)
      m.scale.setScalar(1)
      m.updateMatrix()
      bodies.current.setMatrixAt(i, m.matrix)
      heads.current.setMatrixAt(i, m.matrix)
    })
    bodies.current.instanceMatrix.needsUpdate = true
    heads.current.instanceMatrix.needsUpdate = true
  })
  return (
    <group>
      <instancedMesh ref={bodies} args={[G.body, undefined, WALKERS]} castShadow={shadows} raycast={noRay}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={heads} args={[G.head, undefined, WALKERS]} castShadow={shadows} raycast={noRay}>
        <meshLambertMaterial />
      </instancedMesh>
    </group>
  )
}

// --- houses -----------------------------------------------------------------------------------------

/** A single peg person (for the small casts around each house). */
function Peg({ body, hat, position, bubble }: { body: string; hat?: string; position?: [number, number, number]; bubble?: string }) {
  const mats = useMemo(() => ({ body: lambert(body), head: lambert(SKIN[Math.abs(body.charCodeAt(2)) % SKIN.length]), hat: hat ? lambert(hat) : null, bubble: bubble ? new THREE.MeshBasicMaterial({ color: bubble, toneMapped: false }) : null }), [body, hat, bubble])
  return (
    <group position={position}>
      <mesh geometry={G.body} material={mats.body} castShadow raycast={noRay} />
      <mesh geometry={G.head} material={mats.head} castShadow raycast={noRay} />
      {mats.hat && <mesh geometry={G.hat} material={mats.hat} raycast={noRay} />}
      {mats.bubble && <mesh geometry={G.bubble} material={mats.bubble} position={[0.14, 0.86, 0]} raycast={noRay} />}
    </group>
  )
}

function House({ plot, impulses, shadows, night }: { plot: Plot; impulses: Impulses; shadows: boolean; night: MutableRefObject<number> }) {
  const { project: p, w, d, storeys } = plot
  const id = p.id
  const sig = signals(p)
  const hovered = useApp((s) => s.hoveredId === id)
  const selected = useApp((s) => s.selectedId === id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const h = storeys * STOREY

  const root = useRef<THREE.Group>(null!)
  const scaffold = useRef<THREE.Group>(null!)
  const workers = useRef<THREE.Group>(null!)
  const claudeRef = useRef<THREE.Group>(null!)
  const van = useRef<THREE.Group>(null!)
  const smoke = useRef<THREE.Group>(null!)
  const confetti = useRef<THREE.InstancedMesh>(null!)
  const ping = useRef<THREE.Mesh>(null!)
  const flag = useRef<THREE.Mesh>(null!)

  const mats = useMemo(
    () => ({
      wall: lambert(plot.wall),
      roof: lambert(p.accent),
      trim: lambert('#7a5c48'),
      win: new THREE.MeshBasicMaterial({ color: '#ffd77a', toneMapped: false }),
      smoke: new THREE.MeshLambertMaterial({ color: '#6b6b74', transparent: true, depthWrite: false }),
      ping: new THREE.MeshBasicMaterial({ color: '#fff', transparent: true, depthWrite: false, toneMapped: false }),
      scaffold: new THREE.LineBasicMaterial({ color: '#c58b4a' }),
      van: lambert('#ffffff'),
      stripe: lambert(p.accent),
      flag: lambert('#e5484d'),
    }),
    [plot.wall, p.accent],
  )
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])
  const winColor = useMemo(() => ({ on: new THREE.Color('#ffd77a'), day: new THREE.Color('#bfe1ff'), off: new THREE.Color('#3b4252') }), [])

  const scaffoldGeo = useMemo(() => {
    const pts: number[] = []
    const W = w / 2 + 0.18
    const D = d / 2 + 0.18
    const H = h + 0.25
    const corners = [
      [-W, -D],
      [W, -D],
      [W, D],
      [-W, D],
    ]
    for (const [x, z] of corners) pts.push(x, 0, z, x, H, z)
    for (let y = 0.45; y <= H; y += 0.45)
      for (let k = 0; k < 4; k++) {
        const [x0, z0] = corners[k]
        const [x1, z1] = corners[(k + 1) % 4]
        pts.push(x0, y, z0, x1, y, z1)
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [w, d, h])

  // confetti pieces: random velocities
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ vx: (rand(i) - 0.5) * 3, vy: 3 + rand(i + 3) * 2.5, vz: (rand(i + 5) - 0.5) * 3, spin: rand(i + 9) * 10 })), [])
  useEffect(() => {
    const c = new THREE.Color()
    bits.forEach((_, i) => confetti.current.setColorAt(i, c.set(BODY[i % BODY.length])))
    if (confetti.current.instanceColor) confetti.current.instanceColor.needsUpdate = true
  }, [bits])
  const m = useMemo(() => new THREE.Object3D(), [])
  const doorDist = useMemo(() => Math.hypot(plot.dx, plot.dz) - (RING + 0.6), [plot])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const imp = impulses.get(id)
    const k = since(impulses, id, t)
    // hop on events and on hover
    const hop = k < 0.8 ? Math.sin((k / 0.8) * Math.PI) * 0.35 : 0
    root.current.position.y = damp(root.current.position.y, (hovered || selected ? 0.12 : 0) + hop, 10, dt)
    // windows: lit at night or while busy, dark when the site is down
    const lit = sig.down ? winColor.off : night.current > 0.5 || sig.building ? winColor.on : winColor.day
    mats.win.color.lerp(lit, 1 - Math.exp(-dt * 3))

    scaffold.current.visible = sig.building
    workers.current.visible = sig.building
    if (sig.building) workers.current.children.forEach((c, i) => (c.position.y = Math.abs(Math.sin(t * 6 + i * 1.7)) * 0.18))
    claudeRef.current.visible = sig.claude
    if (sig.claude) {
      claudeRef.current.position.y = Math.abs(Math.sin(t * 4)) * 0.12
      claudeRef.current.rotation.y = Math.sin(t * 1.2) * 0.6
    }
    // delivery van drives in from the lane, waits, and drives off again
    van.current.visible = sig.deploying
    if (sig.deploying) {
      const c = (t * 0.18) % 1
      const u = c < 0.4 ? c / 0.4 : c < 0.6 ? 1 : 1 - (c - 0.6) / 0.4
      const e = u * u * (3 - 2 * u)
      van.current.position.set(0, 0, d / 2 + 0.6 + doorDist * (1 - e))
    }
    // smoke from the chimney when it's broken or down
    smoke.current.visible = sig.broken || sig.down
    if (smoke.current.visible)
      smoke.current.children.forEach((c, i) => {
        const u = (t * 0.35 + i / smoke.current.children.length) % 1
        c.position.set(Math.sin(i * 2.1 + t) * 0.15 * u, u * 2.4, -Math.cos(i * 1.3) * 0.1 * u)
        c.scale.setScalar(0.5 + u * 1.4)
      })
    mats.smoke.opacity = 0.55
    // ground ping
    ping.current.visible = k < 1.6
    if (k < 1.6 && imp) {
      const u = k / 1.6
      ping.current.scale.setScalar(1.6 + u * 3.5)
      mats.ping.opacity = (1 - u) * (1 - u)
      mats.ping.color.set(LEVEL[imp.level])
    }
    // confetti after a success
    const party = imp && imp.level === 'success' && k < 2.6
    confetti.current.visible = !!party
    if (party) {
      bits.forEach((b, i) => {
        m.position.set(b.vx * k, h + 0.9 + b.vy * k - 4.9 * k * k * 0.7, b.vz * k)
        m.rotation.set(b.spin * k, b.spin * k * 0.7, 0)
        m.updateMatrix()
        confetti.current.setMatrixAt(i, m.matrix)
      })
      confetti.current.instanceMatrix.needsUpdate = true
    }
    // mailbox flag up while a PR waits for review
    flag.current.rotation.z = damp(flag.current.rotation.z, sig.prs ? 0 : -Math.PI / 2, 4, dt)
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 6) return
    select(selected ? null : id)
  }
  const queue = Math.min(4, sig.issues)
  const winCols = Math.max(2, Math.round(w / 0.7))

  return (
    <group position={[plot.x, 0, plot.z]} rotation={[0, plot.angle + Math.PI, 0]}>
      {/* +z is the front (towards the green) */}
      <group
        ref={root}
        onPointerOver={(e) => {
          e.stopPropagation()
          hover(id)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          hover(null)
          document.body.style.cursor = ''
        }}
        onClick={onClick}
      >
        <mesh geometry={G.box} material={mats.wall} position={[0, h / 2, 0]} scale={[w, h, d]} castShadow={shadows} receiveShadow={shadows} />
        <mesh geometry={G.roof} material={mats.roof} position={[0, h + 0.27, 0]} scale={[w + 0.2, 0.54, (d + 0.32) / 1.732]} castShadow={shadows} />
        <mesh geometry={G.box} material={mats.trim} position={[w * 0.28, h + 0.5, -0.18]} scale={[0.2, 0.55, 0.2]} castShadow={shadows} />
        {/* door and windows */}
        <mesh geometry={G.box} material={mats.trim} position={[0, 0.29, d / 2 + 0.005]} scale={[0.32, 0.58, 0.02]} />
        {Array.from({ length: storeys }, (_, f) =>
          Array.from({ length: winCols }, (_, c) => {
            const x = (c - (winCols - 1) / 2) * (w / winCols)
            if (f === 0 && Math.abs(x) < 0.3) return null
            return <mesh key={`${f}-${c}`} geometry={G.box} material={mats.win} position={[x, f * STOREY + 0.44, d / 2 + 0.006]} scale={[0.24, 0.26, 0.01]} raycast={noRay} />
          }),
        )}
        {/* a bigger invisible target so the whole plot is easy to click */}
        <mesh geometry={G.box} position={[0, h / 2 + 0.2, 0.6]} scale={[w + 1, h + 1.2, d + 1.6]} visible={false} />
        <Anchor id={`lbl-tw-${id}`} position={[0, h + 1.35, 0]} />
      </group>

      {/* scaffolding and hard hats while a build runs */}
      <group ref={scaffold} visible={false}>
        <lineSegments geometry={scaffoldGeo} material={mats.scaffold} raycast={noRay} />
      </group>
      <group ref={workers} visible={false}>
        <group position={[-w / 2 - 0.45, 0, d / 2 + 0.3]}>
          <Peg body="#f5a524" hat="#ffd23f" />
        </group>
        <group position={[w / 2 + 0.45, 0, d / 2 + 0.1]}>
          <Peg body="#5b8def" hat="#ffd23f" />
        </group>
      </group>
      {/* Claude, in its own colours, pottering about while it works on this project */}
      <group position={[w / 2 + 0.2, 0, d / 2 + 0.75]}>
        <group ref={claudeRef} visible={false}>
          <Peg body={CLAUDE} hat="#fff4e0" />
        </group>
      </group>
      {/* grumbling visitors queueing at the door: one per open issue */}
      {Array.from({ length: queue }, (_, i) => (
        <Peg key={i} body={BODY[(i * 3 + 1) % BODY.length]} bubble="#e5484d" position={[-0.55 - (i % 2) * 0.05, 0, d / 2 + 0.55 + i * 0.42]} />
      ))}
      {/* delivery van */}
      <group ref={van} visible={false}>
        <mesh geometry={G.box} material={mats.van} position={[0, 0.34, 0]} scale={[0.5, 0.48, 0.8]} castShadow={shadows} raycast={noRay} />
        <mesh geometry={G.box} material={mats.van} position={[0, 0.25, 0.52]} scale={[0.48, 0.3, 0.28]} raycast={noRay} />
        <mesh geometry={G.box} material={mats.stripe} position={[0, 0.34, 0]} scale={[0.52, 0.1, 0.7]} raycast={noRay} />
        {[-1, 1].map((sx) =>
          [-0.25, 0.4].map((z) => (
            <mesh key={`${sx}${z}`} geometry={G.wheel} position={[sx * 0.24, 0.11, z]} rotation={[0, Math.PI / 2, 0]} raycast={noRay}>
              <meshLambertMaterial color="#333" />
            </mesh>
          )),
        )}
      </group>
      {/* chimney smoke */}
      <group ref={smoke} position={[w * 0.28, h + 0.85, -0.18]} visible={false}>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i} geometry={G.puff} material={mats.smoke} raycast={noRay} />
        ))}
      </group>
      <instancedMesh ref={confetti} args={[G.confetti, undefined, bits.length]} visible={false} raycast={noRay}>
        <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
      </instancedMesh>
      <mesh ref={ping} geometry={G.ring} material={mats.ping} position={[0, 0.03, 0.4]} visible={false} raycast={noRay} />
      {/* mailbox at the end of the path */}
      <group position={[0.65, 0, d / 2 + doorDist - 0.3]}>
        <mesh geometry={G.box} material={mats.trim} position={[0, 0.3, 0]} scale={[0.05, 0.6, 0.05]} raycast={noRay} />
        <mesh geometry={G.box} material={mats.roof} position={[0, 0.66, 0]} scale={[0.18, 0.16, 0.3]} castShadow={shadows} raycast={noRay} />
        <mesh ref={flag} geometry={G.box} material={mats.flag} position={[0.1, 0.78, -0.08]} scale={[0.02, 0.22, 0.03]} raycast={noRay} />
      </group>
      {/* down: a barrier across the path */}
      {sig.down && (
        <mesh geometry={G.box} position={[0, 0.4, d / 2 + 1.1]} scale={[1.1, 0.08, 0.06]} raycast={noRay}>
          <meshLambertMaterial color="#e5484d" />
        </mesh>
      )}
    </group>
  )
}

// --- light, sky and camera ---------------------------------------------------------------------------

/** 0 by day, 1 at night, from the local clock. */
function nightAmount() {
  const d = new Date()
  const h = d.getHours() + d.getMinutes() / 60
  const day = THREE.MathUtils.smoothstep(h, 6, 8) - THREE.MathUtils.smoothstep(h, 18.5, 20.5)
  return 1 - day
}

function Sky({ night, shadows, radius }: { night: MutableRefObject<number>; shadows: boolean; radius: number }) {
  const hemi = useRef<THREE.HemisphereLight>(null!)
  const sun = useRef<THREE.DirectionalLight>(null!)
  const { scene } = useThree()
  const colors = useMemo(() => ({ day: new THREE.Color('#bfe6ff'), night: new THREE.Color('#1d2742'), bg: new THREE.Color() }), [])
  useEffect(() => {
    sun.current.shadow.camera.updateProjectionMatrix()
  }, [radius])
  useEffect(() => {
    scene.background = colors.bg
    const tick = () => (night.current = nightAmount())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [scene, colors, night])
  useFrame(() => {
    const n = night.current
    colors.bg.copy(colors.day).lerp(colors.night, n)
    hemi.current.intensity = 1.5 - n * 0.9
    sun.current.intensity = 2.1 - n * 1.6
  })
  return (
    <>
      <hemisphereLight ref={hemi} args={['#ffffff', '#7cae5c', 1.4]} />
      <directionalLight
        ref={sun}
        position={[10, 18, 8]}
        castShadow={shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-radius}
        shadow-camera-right={radius}
        shadow-camera-top={radius}
        shadow-camera-bottom={-radius}
        shadow-bias={-0.0008}
      />
    </>
  )
}

function Rig({ plots, radius }: { plots: Plot[]; radius: number }) {
  const { camera, gl, size } = useThree()
  const az = useRef(0.6)
  const azGoal = useRef(0.6)
  const dist = useRef(radius * 2.7)
  const target = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])
  const offset = useRef(0)
  const zoom = useRef(1)
  const plotsRef = useRef(plots)
  plotsRef.current = plots

  useEffect(() => {
    const el = gl.domElement
    let drag: number | null = null
    const down = (e: PointerEvent) => (drag = e.clientX)
    const move = (e: PointerEvent) => {
      if (drag === null) return
      azGoal.current -= (e.clientX - drag) * 0.006
      drag = e.clientX
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoom.current = THREE.MathUtils.clamp(zoom.current * (1 + e.deltaY * 0.001), 0.45, 1.5)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    const un = useApp.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return
      const p = plotsRef.current.find((x) => x.project.id === s.selectedId)
      // swing round so you're looking at the front of the house, across the green
      if (p) {
        const d = Math.atan2(Math.sin(p.angle + Math.PI - azGoal.current), Math.cos(p.angle + Math.PI - azGoal.current))
        azGoal.current += d
      }
    })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      un()
    }
  }, [gl])

  useFrame((s, dt) => {
    const cam = camera as THREE.PerspectiveCamera
    const sel = plotsRef.current.find((x) => x.project.id === useApp.getState().selectedId)
    if (!sel && !prefersReducedMotion && !useApp.getState().hoveredId) azGoal.current += dt * 0.03
    az.current = damp(az.current, azGoal.current, 2.5, dt)
    const fit = radius * (size.width / size.height < 1.4 ? 5 : 4.1)
    const intro = 1 - Math.pow(1 - Math.min(1, s.clock.elapsedTime / 2.2), 3)
    const goalDist = (sel ? 21 : fit) * zoom.current + (1 - intro) * 10
    dist.current = damp(dist.current, goalDist, 2.5, dt)
    if (sel) target.set(sel.x * 0.92, 0.9, sel.z * 0.92)
    else target.set(0, 0, 0)
    look.lerp(target, 1 - Math.exp(-dt * 2.5))
    const elev = sel ? 0.62 : 0.92
    cam.position.set(look.x + Math.sin(az.current) * dist.current * Math.cos(elev), look.y + dist.current * Math.sin(elev), look.z + Math.cos(az.current) * dist.current * Math.cos(elev))
    cam.lookAt(look)
    offset.current = damp(offset.current, sel ? Math.min(330, size.width * 0.2) : 0, 3, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
  })
  return null
}

export function TownshipScene({ tier }: { tier: Tier }) {
  const plots = usePlots()
  const shadows = tier === 'high'
  const radius = townRadius(plots.length) + ISLAND_PAD
  const night = useRef(nightAmount())
  const party = useRef({ at: -99, plot: -1 })
  const plotsRef = useRef(plots)
  plotsRef.current = plots
  const impulses = useImpulses(
    useMemo(
      () => (n: { level: string; projectId: string }, at: number) => {
        if (n.level === 'success') party.current = { at, plot: plotsRef.current.findIndex((p) => p.project.id === n.projectId) }
      },
      [],
    ),
  )
  return (
    <>
      <Sky night={night} shadows={shadows} radius={radius} />
      <Rig plots={plots} radius={townRadius(plots.length)} />
      <Island radius={radius} shadows={shadows} />
      <Paths plots={plots} shadows={shadows} />
      <TownHall shadows={shadows} />
      <Trees plots={plots} radius={radius} shadows={shadows} />
      {plots.map((p) => (
        <House key={p.project.id} plot={p} impulses={impulses} shadows={shadows} night={night} />
      ))}
      {plots.length > 0 && <Crowd plots={plots} shadows={shadows} party={party} />}
    </>
  )
}
