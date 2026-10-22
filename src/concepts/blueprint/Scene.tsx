import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import type { Project } from '../../data/types'
import { useData } from '../../data/store'
import { signals, threadsByPush } from '../../data/derive'
import { useApp } from '../../store'
import { Anchor } from '../../shared/Labels'
import { since, useImpulses, type Impulses } from '../../shared/pulse'
import { useBp } from './state'
import { usePalette, type Palette } from './palette'

const levelColor = (p: Palette, level: string) => ({ info: p.line, progress: p.mark, success: p.go, warning: p.mark, critical: p.alert })[level] ?? p.line

const SPACE_X = 5.6
const SPACE_Z = 6
const FLOOR_H = 0.42
const BASE = 0.2
const GAP = 0.5
const MAX_FLOORS = 10
const MAX_HUTS = 5

const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))
const noRay = () => null

export interface Lot {
  project: Project
  letter: string
  x: number
  z: number
  floors: number
  w: number
  d: number
}

export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Lay projects out on a grid of lots. One floor per page of the site; footprint grows with this week's commits. */
export function useLots(): Lot[] {
  const projects = useData((s) => s.projects)
  const key = projects.map((p) => `${p.id}:${p.pages.length}:${p.commitsWeek}`).join('|')
  return useMemo(() => {
    const n = projects.length
    const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.6)))
    const rows = Math.max(1, Math.ceil(n / cols))
    const maxC = Math.max(6, ...projects.map((p) => p.commitsWeek))
    return projects.map((project, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const w = 1.5 + Math.sqrt(project.commitsWeek / maxC) * 1.5
      return {
        project,
        letter: LETTERS[i % LETTERS.length],
        x: (col - (cols - 1) / 2) * SPACE_X,
        z: (row - (rows - 1) / 2) * SPACE_Z,
        floors: THREE.MathUtils.clamp(project.pages.length || 1, 1, MAX_FLOORS),
        w,
        d: w * (0.72 + (i % 3) * 0.1),
      }
    })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Height of a building, opened up by `ex` (0 closed, 1 fully dissected). */
export const heightOf = (floors: number, ex = 0) => BASE + floors * (FLOOR_H + ex * GAP) + 0.3 + ex * GAP

// --- Ground: drafting grid --------------------------------------------------------------------

function Ground({ ping }: { ping: MutableRefObject<{ at: number; color: THREE.Color }> }) {
  const pal = usePalette()
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPing: { value: 99 }, uPingColor: { value: new THREE.Color() }, uGrid: { value: new THREE.Vector3() }, uAlpha: { value: 1 } }), [])
  useFrame((s) => {
    uniforms.uGrid.value.set(...pal.grid)
    uniforms.uAlpha.value = pal.gridAlpha
    uniforms.uTime.value = s.clock.elapsedTime
    uniforms.uPing.value = s.clock.elapsedTime - ping.current.at
    uniforms.uPingColor.value.copy(ping.current.color)
  })
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} raycast={noRay}>
      <planeGeometry args={[140, 140]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        vertexShader="varying vec2 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }"
        fragmentShader={`uniform float uTime; uniform float uPing; uniform vec3 uPingColor; uniform vec3 uGrid; uniform float uAlpha; varying vec2 vW;
          float grid(vec2 p, float s, float w) { vec2 g = abs(fract(p / s - .5) - .5) / fwidth(p / s); return 1. - min(min(g.x, g.y) / w, 1.); }
          void main(){
            float minor = grid(vW, 1., 1.) * .1;
            float major = grid(vW, ${SPACE_X.toFixed(1)}, 1.2) * .22;
            float fade = smoothstep(46., 12., length(vW));
            float reveal = smoothstep(0., 1., uTime * .8 - length(vW) * .04);
            // a sweep across the whole sheet when something big happens
            float sweep = exp(-pow(length(vW) - uPing * 16., 2.) * .08) * smoothstep(3., 0., uPing);
            vec3 col = mix(uGrid, uPingColor, sweep);
            gl_FragColor = vec4(col, ((minor + major) * fade + sweep * (minor * 3. + .05)) * reveal * uAlpha);
          }`}
      />
    </mesh>
  )
}

/** Roads between the lots with little request "cars" running on them. */
function Roads({ lots }: { lots: Lot[] }) {
  const pal = usePalette()
  const { xs, zs, spanX, spanZ } = useMemo(() => {
    const cx = [...new Set(lots.map((l) => l.x))].sort((a, b) => a - b)
    const cz = [...new Set(lots.map((l) => l.z))].sort((a, b) => a - b)
    const xs = [...cx.map((x) => x - SPACE_X / 2), (cx.at(-1) ?? 0) + SPACE_X / 2]
    const zs = [...cz.map((z) => z - SPACE_Z / 2), (cz.at(-1) ?? 0) + SPACE_Z / 2]
    return { xs, zs, spanX: [xs[0], xs.at(-1)!], spanZ: [zs[0], zs.at(-1)!] }
  }, [lots])
  const lines = useMemo(() => {
    const pts: number[] = []
    for (const z of zs) pts.push(spanX[0] - 1, 0, z, spanX[1] + 1, 0, z)
    for (const x of xs) pts.push(x, 0, spanZ[0] - 1, x, 0, spanZ[1] + 1)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: pal.line, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.35 }))
    l.computeLineDistances()
    l.raycast = noRay
    return l
  }, [xs, zs, spanX, spanZ, pal])
  const cars = useRef<THREE.InstancedMesh>(null!)
  const n = 60
  const seeds = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => {
        const horizontal = i % 3 !== 0
        return {
          horizontal,
          lane: horizontal ? zs[i % zs.length] : xs[i % xs.length],
          speed: (0.6 + Math.random() * 1.4) * (i % 2 ? 1 : -1),
          off: Math.random() * 100,
        }
      }),
    [xs, zs],
  )
  const m = useMemo(() => new THREE.Object3D(), [])
  useFrame((s) => {
    const t = s.clock.elapsedTime
    seeds.forEach((c, i) => {
      const [a, b] = c.horizontal ? spanX : spanZ
      const span = b - a + 2
      const p = ((((c.off + t * c.speed) % span) + span) % span) + a - 1
      if (c.horizontal) m.position.set(p, 0.04, c.lane + (c.speed > 0 ? 0.18 : -0.18))
      else m.position.set(c.lane + (c.speed > 0 ? 0.18 : -0.18), 0.04, p)
      m.scale.set(c.horizontal ? 0.22 : 0.08, 0.06, c.horizontal ? 0.08 : 0.22)
      m.updateMatrix()
      cars.current.setMatrixAt(i, m.matrix)
    })
    cars.current.instanceMatrix.needsUpdate = true
  })
  return (
    <group>
      <primitive object={lines} />
      <instancedMesh ref={cars} args={[undefined, undefined, n]} raycast={noRay}>
        <boxGeometry />
        <meshBasicMaterial color={pal.mark} toneMapped={false} />
      </instancedMesh>
    </group>
  )
}

// --- Buildings ----------------------------------------------------------------------------------

const box = new THREE.BoxGeometry(1, 1, 1)
const boxEdges = new THREE.EdgesGeometry(box)
const ring = new THREE.RingGeometry(0.96, 1, 96).rotateX(-Math.PI / 2)

function partOf(o: THREE.Object3D | null): string | null {
  for (; o; o = o.parent) if (o.userData.part) return o.userData.part as string
  return null
}

/** One floor, roof, hut, etc: a filled box with drawn edges. */
function Block({ fill, edge, part }: { fill: THREE.Material; edge: THREE.LineBasicMaterial; part?: string }) {
  return (
    <group userData={part ? { part } : undefined}>
      <mesh geometry={box} material={fill} />
      <lineSegments geometry={boxEdges} material={edge} raycast={noRay} />
    </group>
  )
}

function Building({ lot, index, impulses }: { lot: Lot; index: number; impulses: Impulses }) {
  const { project } = lot
  const id = project.id
  const hovered = useApp((s) => s.hoveredId === id)
  const selected = useApp((s) => s.selectedId === id)
  const anySelected = useApp((s) => !!s.selectedId)
  const dissect = useBp((s) => s.dissect && selected)
  const othersDissected = useBp((s) => s.dissect) && !selected && anySelected
  const part = useBp((s) => (selected ? s.part : null))
  const hoverPart = useBp((s) => (selected ? s.hoverPart : null))
  const sig = signals(project)
  const pal = usePalette()
  // newest push first; hut 0 sits at the back and rises highest when opened, so it reads as the top of the stack
  const threads = threadsByPush(project).slice(0, MAX_HUTS)
  const store = project.store
  const slot = (k: number) => threads.length - 1 - k

  const root = useRef<THREE.Group>(null!)
  const floorRefs = useRef<THREE.Group[]>([])
  const roof = useRef<THREE.Group>(null!)
  const sign = useRef<THREE.Group>(null!)
  const found = useRef<THREE.Group>(null!)
  const hutRefs = useRef<THREE.Group[]>([])
  const shop = useRef<THREE.Group>(null!)
  const coin = useRef<THREE.Mesh>(null!)
  const lastOrder = useRef<{ id: string | null; at: number }>({ id: null, at: -99 })
  const hl = useRef<THREE.Group>(null!)
  const crane = useRef<THREE.Group>(null!)
  const jib = useRef<THREE.Group>(null!)
  const scan = useRef<THREE.Group>(null!)
  const lift = useRef<THREE.Mesh>(null!)
  const drone = useRef<THREE.Group>(null!)
  const beacon = useRef<THREE.Mesh>(null!)
  const pingRef = useRef<THREE.Mesh>(null!)
  const lotLine = useRef<THREE.LineSegments>(null!)
  const ex = useRef(0)
  const born = useRef<number | null>(null)

  const mats = useMemo(
    () => ({
      fill: new THREE.MeshBasicMaterial({ color: pal.fill, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
      edge: new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: 0.9 }),
      hutFill: new THREE.MeshBasicMaterial({ color: pal.hut, transparent: true, opacity: 0.7, depthWrite: false }),
      hutEdge: new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: 0.85 }),
      hlFill: new THREE.MeshBasicMaterial({ color: pal.mark, transparent: true, opacity: 0.22, depthWrite: false }),
      hlEdge: new THREE.LineBasicMaterial({ color: pal.mark }),
      lot: new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: 0.3 }),
      ping: new THREE.MeshBasicMaterial({ color: pal.line, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
      light: new THREE.MeshBasicMaterial({ color: pal.mark, transparent: true, toneMapped: false }),
      coin: new THREE.MeshBasicMaterial({ color: pal.go, transparent: true, opacity: 0, toneMapped: false }),
      shopLight: new THREE.MeshBasicMaterial({ color: pal.go, toneMapped: false }),
    }),
    [pal],
  )
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])

  const colors = useMemo(() => ({ line: new THREE.Color(pal.line), mark: new THREE.Color(pal.mark), alert: new THREE.Color(pal.alert), fill: new THREE.Color(pal.fill), fillAlert: new THREE.Color(pal.fillAlert) }), [pal])
  const W = lot.w
  const D = lot.d

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    if (born.current === null) born.current = t
    const age = t - born.current
    ex.current = damp(ex.current, dissect ? 1 : 0, 3.2, dt)
    const e = ex.current
    const fh = FLOOR_H + e * GAP
    const fx0 = !othersDissected

    // floors rise one by one on first show, and spread apart when dissected
    floorRefs.current.forEach((f, j) => {
      if (!f) return
      const k = THREE.MathUtils.clamp((age - 0.6 - index * 0.12 - j * 0.07) / 0.35, 0, 1)
      f.scale.y = Math.max(0.0001, 1 - Math.pow(1 - k, 3))
      f.visible = k > 0
      f.position.y = BASE + e * GAP * 0.5 + j * fh
    })
    const top = BASE + e * GAP * 0.5 + lot.floors * fh
    roof.current.position.y = top + e * GAP * 0.6
    sign.current.position.y = top + e * GAP * 1.2
    found.current.position.y = -e * GAP * 0.6
    hutRefs.current.forEach((h, k) => {
      if (!h) return
      h.position.x = W / 2 + 0.55 + e * 1.1
      h.position.y = e * (0.25 + slot(k) * 0.5)
    })
    // the shopfront slides out forwards when opened up; a coin rises on each new order
    if (shop.current) {
      shop.current.position.z = D / 2 + 0.55 + e * 1.1
      const o = store?.orders[0]?.id ?? null
      if (o !== lastOrder.current.id) {
        if (lastOrder.current.id !== null) lastOrder.current.at = t
        lastOrder.current.id = o
      }
      const c = (t - lastOrder.current.at) / 1.6
      coin.current.visible = c < 1 && fx0
      if (c < 1) {
        coin.current.position.y = 0.6 + c * 0.9
        coin.current.rotation.y = t * 6
        mats.coin.opacity = 1 - c * c
      }
      mats.shopLight.color.set(store?.error ? pal.alert : store?.connected ? pal.go : pal.line)
    }

    // lift the hovered/selected building, fade the rest while one is opened up
    root.current.position.y = damp(root.current.position.y, (hovered || selected) && !dissect ? 0.3 : 0, 8, dt)
    const dim = othersDissected ? 0.12 : anySelected && !selected ? 0.55 : 1
    const alarm = sig.broken || sig.down
    mats.edge.color.lerp(selected || hovered ? colors.mark : alarm ? colors.alert : colors.line, 1 - Math.exp(-dt * 8))
    mats.edge.opacity = damp(mats.edge.opacity, 0.9 * dim, 6, dt)
    mats.fill.color.lerp(alarm ? colors.fillAlert : colors.fill, 1 - Math.exp(-dt * 4))
    mats.fill.opacity = damp(mats.fill.opacity, (dissect ? 0.32 : selected ? 0.7 : 0.5) * dim, 6, dt)
    mats.hutEdge.opacity = mats.edge.opacity
    mats.hutFill.opacity = mats.fill.opacity * 1.3
    mats.lot.opacity = damp(mats.lot.opacity, (selected ? 0.8 : sig.down ? 0.7 : 0.3) * dim, 6, dt)
    mats.lot.color.copy(sig.down ? colors.alert : colors.line)

    // highlight box over the hovered or picked part
    const key = hoverPart ?? part
    let target: THREE.Object3D | null = null
    if (dissect && key) {
      if (key === 'roof') target = roof.current
      else if (key === 'sign') target = sign.current
      else if (key === 'foundation') target = found.current
      else if (key.startsWith('floor:')) target = floorRefs.current[Math.min(Number(key.slice(6)), lot.floors - 1)] ?? null
      else if (key.startsWith('hut:')) target = hutRefs.current[Number(key.slice(4))] ?? null
      else if (key === 'store') target = shop.current
    }
    hl.current.visible = !!target
    if (target) {
      const b = target.userData.box as number[] // w, h, d, then the centre's offset x/y/z
      hl.current.position.set(target.position.x + (b[4] ?? 0), target.position.y + b[3], target.position.z + (b[5] ?? 0))
      hl.current.scale.set(b[0] + 0.12, b[1] + 0.12, b[2] + 0.12)
    }

    // build running: crane swings, a scan line sweeps the floors
    // (all of these go quiet while another building is opened up)
    const fx = !othersDissected
    crane.current.visible = sig.building && fx
    scan.current.visible = sig.building && fx
    if (sig.building) {
      jib.current.rotation.y = Math.sin(t * 0.5 + index) * 1.1
      scan.current.position.y = BASE + ((Math.sin(t * 1.4) * 0.5 + 0.5) * (top - BASE))
    }
    // deploying: a lift runs up the corner
    lift.current.visible = sig.deploying && fx
    if (sig.deploying) lift.current.position.y = ((t * 0.9) % 1) * top
    // Claude working: a drone circles the roof
    drone.current.visible = sig.claude && fx
    if (sig.claude) {
      drone.current.rotation.y = t * 0.8
      drone.current.position.y = top + 0.9 + e * GAP * 1.4 + Math.sin(t * 2) * 0.05
    }
    // broken: a slow red beacon
    beacon.current.visible = (sig.broken || sig.down) && fx
    if (beacon.current.visible) {
      beacon.current.position.y = top + 0.75 + e * GAP
      beacon.current.rotation.y = t * 1.5
      beacon.current.scale.setScalar(1 + Math.sin(t * 3) * 0.12)
    }
    mats.light.opacity = 0.55 + Math.sin(t * 3) * 0.35

    // event ping: a ring spreads across the lot
    const k = since(impulses, id, t) / 1.8
    pingRef.current.visible = k < 1 && fx
    if (k < 1) {
      const r = 1.2 + k * Math.max(W, D) * 1.6
      pingRef.current.scale.set(r, 1, r)
      mats.ping.opacity = (1 - k) * (1 - k)
      mats.ping.color.set(levelColor(pal, impulses.get(id)!.level))
    }
  })

  const select = useApp((s) => s.select)
  const hover = useApp((s) => s.hover)
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 6) return // that was a pan, not a click
    const bp = useBp.getState()
    if (!selected) select(id)
    else if (!bp.dissect) bp.setDissect(true)
    else {
      const p = partOf(e.object)
      if (p) bp.setPart(p)
    }
  }

  const fl = Array.from({ length: lot.floors }, (_, j) => j)
  const roofTop = lot.floors * FLOOR_H + BASE

  return (
    <group position={[lot.x, 0, lot.z]}>
      <lineSegments ref={lotLine} geometry={boxEdges} material={mats.lot} scale={[W + 1, 0.001, D + 1]} raycast={noRay} />
      <mesh ref={pingRef} geometry={ring} material={mats.ping} position={[0, 0.03, 0]} visible={false} raycast={noRay} />
      <group
        ref={root}
        onPointerOver={(e) => {
          e.stopPropagation()
          hover(id)
          if (dissect) useBp.getState().setHoverPart(partOf(e.object))
          document.body.style.cursor = 'pointer'
        }}
        onPointerMove={(e) => {
          if (!dissect) return
          const p = partOf(e.object)
          if (p !== useBp.getState().hoverPart) useBp.getState().setHoverPart(p)
        }}
        onPointerOut={() => {
          hover(null)
          useBp.getState().setHoverPart(null)
          document.body.style.cursor = ''
        }}
        onClick={onClick}
      >
        {/* foundation: build quality */}
        <group ref={found} userData={{ part: 'foundation', box: [W + 0.3, BASE, D + 0.3, BASE / 2] }}>
          <group position={[0, BASE / 2, 0]} scale={[W + 0.3, BASE, D + 0.3]}>
            <Block fill={mats.fill} edge={mats.edge} part="foundation" />
          </group>
          {dissect && <Anchor id={`bp-part-foundation`} position={[-(W + 0.3) / 2, BASE / 2, (D + 0.3) / 2]} />}
        </group>

        {/* floors: one per page */}
        {fl.map((j) => {
          const inset = j > lot.floors * 0.6 && lot.floors > 3 ? 0.84 : 1
          return (
            <group
              key={j}
              ref={(g) => {
                if (g) floorRefs.current[j] = g
              }}
              position={[0, BASE + j * FLOOR_H, 0]}
              userData={{ part: `floor:${j}`, box: [W * inset, FLOOR_H * 0.96, D * inset, FLOOR_H / 2] }}
            >
              <group position={[0, FLOOR_H / 2, 0]} scale={[W * inset, FLOOR_H * 0.96, D * inset]}>
                <Block fill={mats.fill} edge={mats.edge} part={`floor:${j}`} />
              </group>
              {dissect && <Anchor id={`bp-part-floor:${j}`} position={[-(W * inset) / 2, FLOOR_H / 2, (D * inset) / 2]} />}
            </group>
          )
        })}

        {/* roof: site speed (with a plant box on top) */}
        <group ref={roof} position={[0, roofTop, 0]} userData={{ part: 'roof', box: [W * 0.9, 0.32, D * 0.9, 0.16] }}>
          <group position={[0, 0.06, 0]} scale={[W * 0.9, 0.12, D * 0.9]}>
            <Block fill={mats.fill} edge={mats.edge} part="roof" />
          </group>
          <group position={[-W * 0.18, 0.22, 0]} scale={[W * 0.3, 0.2, D * 0.3]}>
            <Block fill={mats.fill} edge={mats.edge} part="roof" />
          </group>
          {dissect && <Anchor id={`bp-part-roof`} position={[(W * 0.9) / 2, 0.1, -(D * 0.9) / 2]} />}
        </group>

        {/* sign on the roof: SEO */}
        <group ref={sign} position={[0, roofTop + 0.3, 0]} userData={{ part: 'sign', box: [W * 0.5, 0.62, 0.1, 0.31, W * 0.15, D * 0.2] }}>
          <group position={[W * 0.15, 0.45, D * 0.2]} scale={[W * 0.5, 0.34, 0.05]}>
            <Block fill={mats.hutFill} edge={mats.edge} part="sign" />
          </group>
          <group position={[W * 0.15, 0.14, D * 0.2]} scale={[0.04, 0.28, 0.04]}>
            <Block fill={mats.fill} edge={mats.edge} part="sign" />
          </group>
          {dissect && <Anchor id={`bp-part-sign`} position={[W * 0.4, 0.62, D * 0.2]} />}
        </group>

        {/* site huts: one per Claude thread */}
        {threads.map((th, k) => (
          <group
            key={th.id}
            ref={(g) => {
              if (g) hutRefs.current[k] = g
            }}
            position={[W / 2 + 0.55, 0, D / 2 - 0.25 - slot(k) * 0.5]}
            userData={{ part: `hut:${k}`, box: [0.4, 0.3, 0.36, 0.15] }}
          >
            <group position={[0, 0.15, 0]} scale={[0.4, 0.3, 0.36]}>
              <Block fill={mats.hutFill} edge={mats.hutEdge} part={`hut:${k}`} />
            </group>
            {th.status === 'working' && (
              <mesh position={[0, 0.36, 0]} material={mats.light} raycast={noRay}>
                <sphereGeometry args={[0.05, 10, 8]} />
              </mesh>
            )}
            {dissect && <Anchor id={`bp-part-hut:${k}`} position={[0.2, 0.3, 0]} />}
          </group>
        ))}

        {/* shopfront: the Shopify store the site is built on, in front of the building (facing the
            camera when the compass points north). Its window faces +z, so it's drawn facing -x and turned. */}
        {store && (
          <group ref={shop} position={[0, 0, D / 2 + 0.55]} userData={{ part: 'store', box: [0.84, 0.62, 0.62, 0.31] }}>
            <group rotation={[0, Math.PI / 2, 0]}>
              <group position={[0, 0.25, 0]} scale={[0.56, 0.5, 0.8]}>
                <Block fill={mats.hutFill} edge={mats.hutEdge} part="store" />
              </group>
              {/* awning over the shop window, facing out */}
              <group position={[-0.36, 0.44, 0]} rotation={[0, 0, 0.5]} scale={[0.26, 0.03, 0.84]}>
                <Block fill={mats.fill} edge={mats.edge} part="store" />
              </group>
              {/* shop window and door */}
              <group position={[-0.285, 0.2, 0.12]} scale={[0.01, 0.24, 0.42]}>
                <Block fill={mats.hlFill} edge={mats.hutEdge} part="store" />
              </group>
              <group position={[-0.285, 0.15, -0.26]} scale={[0.01, 0.3, 0.14]}>
                <Block fill={mats.fill} edge={mats.hutEdge} part="store" />
              </group>
              <mesh position={[0, 0.55, 0.3]} material={mats.shopLight} raycast={noRay}>
                <sphereGeometry args={[0.045, 10, 8]} />
              </mesh>
              <mesh ref={coin} material={mats.coin} visible={false} raycast={noRay}>
                <cylinderGeometry args={[0.1, 0.1, 0.025, 20]} />
              </mesh>
              {dissect && <Anchor id={`bp-part-store`} position={[-0.28, 0.5, 0.4]} />}
            </group>
          </group>
        )}

        {/* highlight over the hovered / picked part */}
        <group ref={hl} visible={false}>
          <mesh geometry={box} material={mats.hlFill} raycast={noRay} />
          <lineSegments geometry={boxEdges} material={mats.hlEdge} raycast={noRay} />
        </group>

        {/* notification visuals */}
        <group ref={crane} position={[W * 0.35, 0, D * 0.35]} visible={false}>
          <Crane height={roofTop + 1.4} jib={jib} />
        </group>
        <group ref={scan} visible={false}>
          <lineSegments geometry={boxEdges} scale={[W + 0.25, 0.001, D + 0.25]} raycast={noRay}>
            <lineBasicMaterial color={pal.crane} toneMapped={false} />
          </lineSegments>
        </group>
        <mesh ref={lift} position={[-W / 2 - 0.12, 0, D / 2 + 0.12]} visible={false} raycast={noRay}>
          <boxGeometry args={[0.16, 0.22, 0.16]} />
          <meshBasicMaterial color={pal.go} toneMapped={false} />
        </mesh>
        <group ref={drone} visible={false}>
          <mesh position={[Math.max(W, D) * 0.75, 0, 0]} raycast={noRay}>
            <octahedronGeometry args={[0.12, 0]} />
            <meshBasicMaterial color={pal.drone} wireframe toneMapped={false} />
          </mesh>
        </group>
        <mesh ref={beacon} visible={false} raycast={noRay}>
          <octahedronGeometry args={[0.2, 0]} />
          <meshBasicMaterial color={pal.alert} toneMapped={false} />
        </mesh>
        <Flags count={othersDissected ? 0 : Math.min(5, sig.issues)} w={W} d={D} side={!!store} />

        <Anchor id={`lbl-bp-${id}`} position={[0, roofTop + 1.1, 0]} />
      </group>
    </group>
  )
}

/** Little red survey flags at the front of the lot (down the side when the shopfront is there): one per open issue. */
function Flags({ count, w, d, side }: { count: number; w: number; d: number; side: boolean }) {
  const pal = usePalette()
  const ref = useRef<THREE.Group>(null!)
  useFrame((s) => ref.current.children.forEach((f, i) => (f.children[1].rotation.y = Math.sin(s.clock.elapsedTime * 2 + i) * 0.4)))
  return (
    <group ref={ref} position={side ? [-w / 2 - 0.35, 0, d / 2 - 0.1] : [-w / 2 - 0.1, 0, d / 2 + 0.35]}>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} position={side ? [0, 0, -i * 0.3] : [i * 0.3, 0, 0]}>
          <mesh position={[0, 0.25, 0]} raycast={noRay}>
            <boxGeometry args={[0.02, 0.5, 0.02]} />
            <meshBasicMaterial color={pal.line} />
          </mesh>
          <mesh position={[0, 0.44, 0]} raycast={noRay}>
            <planeGeometry args={[0.2, 0.12]} />
            <meshBasicMaterial color={pal.alert} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function Crane({ height, jib }: { height: number; jib: MutableRefObject<THREE.Group> }) {
  const pal = usePalette()
  const mast = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, height, 0], 3))
    return g
  }, [height])
  const arm = useMemo(() => {
    const p = [-0.6, 0, 0, 1.8, 0, 0, 0, 0.4, 0, -0.6, 0, 0, 0, 0.4, 0, 1.8, 0, 0, 1.4, 0, 0, 1.4, -0.8, 0]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    return g
  }, [])
  return (
    <group>
      <lineSegments geometry={mast} raycast={noRay}>
        <lineBasicMaterial color={pal.crane} />
      </lineSegments>
      <group ref={jib} position={[0, height, 0]}>
        <lineSegments geometry={arm} raycast={noRay}>
          <lineBasicMaterial color={pal.crane} />
        </lineSegments>
      </group>
    </group>
  )
}

// --- Camera: isometric with 90° turns, pan and zoom ------------------------------------------------

function Rig({ turn, lots }: { turn: MutableRefObject<number>; lots: Lot[] }) {
  const { camera, gl, size } = useThree()
  const az = useRef(Math.PI / 4)
  const pan = useRef(new THREE.Vector3())
  const panGoal = useRef(new THREE.Vector3())
  const fit = useRef(46)
  const zoomGoal = useRef(46)
  const offset = useRef(0)
  const lotsRef = useRef(lots)
  lotsRef.current = lots

  // zoom that fits every lot on screen
  useEffect(() => {
    const xs = lots.map((l) => Math.abs(l.x) + SPACE_X / 2)
    const zs = lots.map((l) => Math.abs(l.z) + SPACE_Z / 2)
    const r = Math.max(6, ...xs, ...zs) * 1.45
    fit.current = THREE.MathUtils.clamp(Math.min(size.width, size.height * 1.4) / (r * 2.1), 18, 70)
    if (!useApp.getState().selectedId) zoomGoal.current = fit.current
  }, [lots, size])

  useEffect(() => {
    const el = gl.domElement
    let drag: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => (drag = { x: e.clientX, y: e.clientY })
    const move = (e: PointerEvent) => {
      if (!drag) return
      const zoom = (camera as THREE.OrthographicCamera).zoom
      const dx = (e.clientX - drag.x) / zoom
      const dy = (e.clientY - drag.y) / zoom
      const a = az.current
      const right = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))
      const fwd = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a))
      panGoal.current.addScaledVector(right, -dx).addScaledVector(fwd, dy * 1.6)
      drag = { x: e.clientX, y: e.clientY }
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomGoal.current = THREE.MathUtils.clamp(zoomGoal.current * (1 - e.deltaY * 0.0012), 16, 160)
    }
    const frame = () => {
      const id = useApp.getState().selectedId
      const lot = lotsRef.current.find((l) => l.project.id === id)
      if (!lot) {
        panGoal.current.set(0, 0, 0)
        zoomGoal.current = fit.current
        return
      }
      const open = useBp.getState().dissect
      const h = heightOf(lot.floors, open ? 1 : 0)
      panGoal.current.set(lot.x, h * 0.45, lot.z)
      zoomGoal.current = THREE.MathUtils.clamp((size.height * 0.62) / (h * 0.9 + 2.4), 40, open ? 120 : 95)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    const un1 = useApp.subscribe((s, prev) => s.selectedId !== prev.selectedId && frame())
    const un2 = useBp.subscribe((s, prev) => s.dissect !== prev.dissect && frame())
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      un1()
      un2()
    }
  }, [camera, gl, size])

  useFrame((s, dt) => {
    const cam = camera as THREE.OrthographicCamera
    const goal = Math.PI / 4 + turn.current * (Math.PI / 2)
    az.current = damp(az.current, goal, 4, dt)
    pan.current.x = damp(pan.current.x, panGoal.current.x, 4, dt)
    pan.current.y = damp(pan.current.y, panGoal.current.y, 4, dt)
    pan.current.z = damp(pan.current.z, panGoal.current.z, 4, dt)
    const intro = Math.min(1, s.clock.elapsedTime / 1.6)
    const z = zoomGoal.current * (0.75 + 0.25 * (1 - Math.pow(1 - intro, 3)))
    cam.zoom = damp(cam.zoom, z, 4, dt)
    // the detail callout sits on the right: shift the drawing left to make room
    offset.current = damp(offset.current, useApp.getState().selectedId ? Math.min(300, size.width * 0.19) : 0, 4, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
    cam.updateProjectionMatrix()
    const r = 40
    cam.position.set(pan.current.x + Math.cos(az.current) * r, pan.current.y + r * 0.82, pan.current.z + Math.sin(az.current) * r)
    cam.lookAt(pan.current)
  })
  return null
}

export function BlueprintScene({ turn }: { turn: MutableRefObject<number> }) {
  const lots = useLots()
  const pal = usePalette()
  const palRef = useRef(pal)
  palRef.current = pal
  const ping = useRef({ at: -99, color: new THREE.Color(pal.line) })
  const impulses = useImpulses(
    useMemo(
      () => (n: { level: string }, at: number) => {
        if (n.level === 'critical' || n.level === 'success') ping.current = { at, color: new THREE.Color(levelColor(palRef.current, n.level)) }
      },
      [],
    ),
  )
  return (
    <>
      <color attach="background" args={[pal.paper]} />
      <OrthographicCamera makeDefault position={[28, 32, 28]} zoom={34} near={-100} far={200} />
      <Rig turn={turn} lots={lots} />
      <Ground ping={ping} />
      {lots.length > 0 && <Roads lots={lots} />}
      {lots.map((l, i) => (
        <Building key={l.project.id} lot={l} index={i} impulses={impulses} />
      ))}
    </>
  )
}
