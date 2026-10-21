import { useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Billboard, Line } from '@react-three/drei'
import { Anchor } from '../../shared/Labels'
import * as THREE from 'three'
import { SITES, type Site, type SiteStatus } from '../../data/mock'
import { useApp, prefersReducedMotion } from '../../store'

export const STATUS_COLOR: Record<SiteStatus, string> = {
  live: '#4fe3ff',
  building: '#ffb547',
  attention: '#ff4d6a',
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3)

// --- Claude core ---------------------------------------------------------

const shellVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vP = position;
    gl_Position = projectionMatrix * mv;
  }`
const shellFrag = /* glsl */ `
  uniform float uTime; uniform float uLevel; uniform vec3 uColor;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.4);
    float bands = smoothstep(0.92, 1.0, sin(vP.y * 22.0 - uTime * 3.0) * 0.5 + 0.5);
    float grid = smoothstep(0.96, 1.0, sin(atan(vP.z, vP.x) * 24.0) * 0.5 + 0.5);
    vec3 col = uColor * (f * (1.6 + uLevel * 1.8) + (bands + grid) * 0.35 * (0.4 + uLevel));
    gl_FragColor = vec4(col, clamp(f * 0.95 + (bands + grid) * 0.25, 0.0, 1.0));
  }`

function Core({ level, born }: { level: MutableRefObject<number>; born: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!)
  const ico = useRef<THREE.LineSegments>(null!)
  const inner = useRef<THREE.Mesh>(null!)
  const smooth = useRef(0)
  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uLevel: { value: 0 }, uColor: { value: new THREE.Color('#4fe3ff') } }),
    [],
  )
  const icoGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.25, 1)), [])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    // decay the speaking level and smooth it so the pulse feels organic
    level.current *= Math.pow(0.02, dt)
    smooth.current += (level.current - smooth.current) * Math.min(1, dt * 10)
    const l = smooth.current
    uniforms.uTime.value = t
    uniforms.uLevel.value = l
    const b = ease((t - born.current) / 1.4)
    group.current.scale.setScalar(b * (1 + l * 0.08 + Math.sin(t * 1.6) * 0.012))
    ico.current.rotation.y = t * 0.25
    ico.current.rotation.x = t * 0.11
    inner.current.scale.setScalar(0.42 + l * 0.18 + Math.sin(t * 3) * 0.015)
  })

  return (
    <group ref={group}>
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
          vertexShader={shellVert}
          fragmentShader={shellFrag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={inner}>
        <icosahedronGeometry args={[1, 3]} />
        <meshBasicMaterial color={[1.6, 5, 6.5]} toneMapped={false} />
      </mesh>
      <lineSegments ref={ico} geometry={icoGeo}>
        <lineBasicMaterial color="#4fe3ff" transparent opacity={0.35} />
      </lineSegments>
      <TickRing radius={1.75} count={120} speed={0.15} tilt={[Math.PI / 2, 0, 0]} />
      <TickRing radius={2.1} count={72} speed={-0.09} tilt={[Math.PI / 2.4, 0.3, 0]} opacity={0.4} />
      <TickRing radius={2.45} count={180} speed={0.05} tilt={[Math.PI / 1.8, -0.2, 0]} opacity={0.25} />
      <Arc radius={1.95} arc={Math.PI * 0.6} speed={0.6} color="#ffb547" tilt={[Math.PI / 2, 0, 0]} />
      <Arc radius={2.25} arc={Math.PI * 0.25} speed={-0.9} color="#4fe3ff" tilt={[Math.PI / 2.4, 0.3, 0]} />
    </group>
  )
}

function TickRing({
  radius,
  count,
  speed,
  tilt,
  opacity = 0.7,
}: {
  radius: number
  count: number
  speed: number
  tilt: [number, number, number]
  opacity?: number
}) {
  const ref = useRef<THREE.LineSegments>(null!)
  const geo = useMemo(() => {
    const p: number[] = []
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      const len = i % 10 === 0 ? 0.16 : i % 5 === 0 ? 0.09 : 0.045
      p.push(Math.cos(a) * radius, Math.sin(a) * radius, 0)
      p.push(Math.cos(a) * (radius + len), Math.sin(a) * (radius + len), 0)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    return g
  }, [radius, count])
  useFrame((_, dt) => {
    ref.current.rotation.z += dt * speed
  })
  return (
    <group rotation={tilt}>
      <lineSegments ref={ref} geometry={geo}>
        <lineBasicMaterial color="#4fe3ff" transparent opacity={opacity} />
      </lineSegments>
      <mesh>
        <ringGeometry args={[radius - 0.006, radius + 0.006, 128]} />
        <meshBasicMaterial color="#4fe3ff" transparent opacity={opacity * 0.8} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function Arc({
  radius,
  arc,
  speed,
  color,
  tilt,
}: {
  radius: number
  arc: number
  speed: number
  color: string
  tilt: [number, number, number]
}) {
  const ref = useRef<THREE.Mesh>(null!)
  useFrame((_, dt) => {
    ref.current.rotation.z += dt * speed
  })
  return (
    <group rotation={tilt}>
      <mesh ref={ref}>
        <torusGeometry args={[radius, 0.018, 6, 96, arc]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  )
}

// --- Site nodes ------------------------------------------------------------

function hexPoints(r: number): [number, number, number][] {
  return Array.from({ length: 7 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6
    return [Math.cos(a) * r, Math.sin(a) * r, 0]
  })
}
const HEX_IN = hexPoints(0.26)
const HEX_OUT = hexPoints(0.36)

const RX = 4.7
const RZ = 2.5

function Node({ site, index, total, theta }: { site: Site; index: number; total: number; theta: MutableRefObject<number> }) {
  const hovered = useApp((s) => s.hoveredId === site.id)
  const selected = useApp((s) => s.selectedId === site.id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const anchor = useRef<THREE.Group>(null!)
  const root = useRef<THREE.Group>(null!)
  const outer = useRef<THREE.Group>(null!)
  const fill = useRef<THREE.MeshBasicMaterial>(null!)
  const beam = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const m = new THREE.LineDashedMaterial({ color: STATUS_COLOR[site.status], dashSize: 0.14, gapSize: 0.08, transparent: true, opacity: 0 })
    return new THREE.Line(g, m)
  }, [site.status])
  const phi = (index / total) * Math.PI * 2
  const lift = Math.sin(index * 1.7) * 0.3
  const color = STATUS_COLOR[site.status]
  const active = hovered || selected

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const a = phi + theta.current
    const x = Math.sin(a) * RX
    const z = Math.cos(a) * RZ
    const y = lift + Math.sin(t * 0.8 + index) * 0.06
    anchor.current.position.set(x, y, z)
    const k = Math.min(1, dt * 10)
    // shrink nodes as they come forward so the front one never swamps the HUD
    const depth = 1 - (z / RZ) * 0.28
    const target = (active ? 1.35 : 1) * depth
    const s = root.current.scale.x + (target - root.current.scale.x) * k
    root.current.scale.setScalar(s)
    outer.current.rotation.z += dt * (active ? 2 : 0.4)
    const pulse = site.status === 'attention' ? 0.35 + Math.sin(t * 5) * 0.25 : 0.22
    fill.current.opacity += ((active ? 0.45 : pulse) - fill.current.opacity) * k
    // beam from the node back to the core
    const pos = beam.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(1, -x, -y, -z)
    pos.needsUpdate = true
    beam.computeLineDistances()
    const bm = beam.material as THREE.LineDashedMaterial
    bm.opacity += ((active ? 0.9 : 0) - bm.opacity) * k
    beam.visible = bm.opacity > 0.02
  })

  return (
    <group ref={anchor}>
      <primitive object={beam} />
      <Billboard>
        <group
          ref={root}
          onPointerOver={(e) => {
            e.stopPropagation()
            hover(site.id)
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            hover(null)
            document.body.style.cursor = ''
          }}
          onClick={(e) => {
            e.stopPropagation()
            select(selected ? null : site.id)
          }}
        >
          <mesh>
            <circleGeometry args={[0.3, 6, Math.PI / 6]} />
            <meshBasicMaterial ref={fill} color={color} transparent opacity={0.22} toneMapped={false} />
          </mesh>
          <Line points={HEX_IN} color={color} lineWidth={1.5} />
          <group ref={outer}>
            <Line points={HEX_OUT} color={color} lineWidth={1} transparent opacity={0.5} dashed dashSize={0.1} gapSize={0.08} />
          </group>
          {/* bigger invisible hit area */}
          <mesh visible={false}>
            <circleGeometry args={[0.5, 12]} />
          </mesh>
          <Anchor id={`lbl-jv-${site.id}`} position={[0, -0.62, 0]} />
        </group>
      </Billboard>
    </group>
  )
}

function NodeRing({ born }: { born: MutableRefObject<number> }) {
  const ring = useRef<THREE.Group>(null!)
  const theta = useRef(0.4)
  const guide = useMemo(() => {
    const pts = new THREE.EllipseCurve(0, 0, RX, RZ, 0, Math.PI * 2).getPoints(160)
    return new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)))
  }, [])
  useFrame((state, dt) => {
    const { selectedId, hoveredId } = useApp.getState()
    const idx = SITES.findIndex((s) => s.id === selectedId)
    if (idx >= 0) {
      // swing the selected site to the front along the shortest path
      const target = -(idx / SITES.length) * Math.PI * 2
      let d = target - theta.current
      d = Math.atan2(Math.sin(d), Math.cos(d))
      theta.current += d * Math.min(1, dt * 3)
    } else if (!hoveredId && !prefersReducedMotion) {
      theta.current += dt * 0.07
    }
    const b = ease((state.clock.elapsedTime - born.current - 0.5) / 1.2)
    ring.current.scale.setScalar(0.6 + b * 0.4)
    ring.current.visible = b > 0.01
  })
  return (
    <group rotation={[0.12, 0, 0]} position={[0, 0.15, 0]} ref={ring}>
      <lineLoop geometry={guide}>
        <lineBasicMaterial color="#4fe3ff" transparent opacity={0.28} />
      </lineLoop>
      {SITES.map((s, i) => (
        <Node key={s.id} site={s} index={i} total={SITES.length} theta={theta} />
      ))}
    </group>
  )
}

// --- Atmosphere -------------------------------------------------------------

function Dust() {
  const ref = useRef<THREE.Points>(null!)
  const geo = useMemo(() => {
    const n = 2200
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 5 + Math.random() * 14
      const t = Math.random() * Math.PI * 2
      const u = Math.random() * 2 - 1
      const s = Math.sqrt(1 - u * u)
      p.set([Math.cos(t) * s * r, u * r * 0.6, Math.sin(t) * s * r], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  }, [])
  useFrame((_, dt) => {
    ref.current.rotation.y += dt * 0.012
  })
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color="#6fe9ff" size={0.035} sizeAttenuation transparent opacity={0.55} depthWrite={false} />
    </points>
  )
}

function Floor() {
  const grid = useMemo(() => {
    const g = new THREE.PolarGridHelper(9, 24, 9, 96, '#1b6b80', '#0d3a48')
    const m = g.material as THREE.LineBasicMaterial
    m.transparent = true
    m.opacity = 0.35
    return g
  }, [])
  const pulse = useRef<THREE.Mesh>(null!)
  const mat = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame((state) => {
    const k = (state.clock.elapsedTime % 4) / 4
    pulse.current.scale.setScalar(0.5 + k * 9)
    mat.current.opacity = (1 - k) * 0.5
  })
  return (
    <group position={[0, -2.6, 0]}>
      <primitive object={grid} />
      <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.98, 1, 128]} />
        <meshBasicMaterial ref={mat} color="#4fe3ff" transparent depthWrite={false} />
      </mesh>
    </group>
  )
}

function CameraRig({ pointer }: { pointer: MutableRefObject<{ x: number; y: number }> }) {
  const { camera } = useThree()
  const look = useMemo(() => new THREE.Vector3(0, -0.35, 0), [])
  useFrame((state, dt) => {
    const sel = useApp.getState().selectedId
    const intro = ease(state.clock.elapsedTime / 2.2)
    const z = 12.5 - intro * 2.2 - (sel ? 0.5 : 0)
    const tx = pointer.current.x * 0.9
    const ty = 1.3 - pointer.current.y * 0.6
    const k = Math.min(1, dt * 2.5)
    camera.position.x += (tx - camera.position.x) * k
    camera.position.y += (ty - camera.position.y) * k
    camera.position.z += (z - camera.position.z) * k
    camera.lookAt(look)
  })
  return null
}

export function JarvisScene({
  level,
  pointer,
}: {
  level: MutableRefObject<number>
  pointer: MutableRefObject<{ x: number; y: number }>
}) {
  const born = useRef(0)
  useFrame((state) => {
    if (born.current === 0) born.current = state.clock.elapsedTime + 0.0001
  })
  return (
    <>
      <color attach="background" args={['#03070d']} />
      <fog attach="fog" args={['#03070d', 9, 24]} />
      <CameraRig pointer={pointer} />
      <Core level={level} born={born} />
      <NodeRing born={born} />
      <Dust />
      <Floor />
    </>
  )
}
