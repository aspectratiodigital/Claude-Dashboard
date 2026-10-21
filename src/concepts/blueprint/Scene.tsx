import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import { Anchor } from '../../shared/Labels'
import * as THREE from 'three'
import { SITES } from '../../data/mock'
import { useApp } from '../../store'

export const LINE = '#dce9ff'
export const MARK = '#ffd23f'
export const ALERT = '#ff6b6b'

const maxV = Math.max(...SITES.map((s) => s.visitors7d))
export const LOTS = SITES.map((site, i) => {
  const col = i % 4
  const row = Math.floor(i / 4)
  const floors = Math.max(1, Math.min(12, Math.round(site.commitsThisWeek / 2.6)))
  const w = 1.4 + Math.sqrt(site.visitors7d / maxV) * 1.8
  return { site, x: (col - 1.5) * 5.2, z: (row - 0.5) * 5.6, floors, w, d: w * (0.7 + (i % 3) * 0.12), floorH: 0.42 }
})

// --- Ground: drafting grid --------------------------------------------------

function Ground() {
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), [])
  useFrame((s) => (uniforms.uTime.value = s.clock.elapsedTime))
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
      <planeGeometry args={[120, 120]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        vertexShader="varying vec2 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }"
        fragmentShader={`uniform float uTime; varying vec2 vW;
          float grid(vec2 p, float s, float w) { vec2 g = abs(fract(p / s - .5) - .5) / fwidth(p / s); return 1. - min(min(g.x, g.y) / w, 1.); }
          void main(){
            float minor = grid(vW, 1., 1.) * .12;
            float major = grid(vW, 5.2, 1.2) * .28;
            float fade = smoothstep(40., 12., length(vW));
            float reveal = smoothstep(0., 1., uTime * .8 - length(vW) * .04);
            gl_FragColor = vec4(vec3(.86, .91, 1.), (minor + major) * fade * reveal);
          }`}
      />
    </mesh>
  )
}

/** Roads between the lots with little request "cars" running on them. */
function Roads() {
  const lines = useMemo(() => {
    const pts: number[] = []
    const xs = [-13, -7.8, -2.6, 2.6, 7.8, 13]
    const zs = [-5.6, 0, 5.6]
    for (const z of zs) pts.push(-13, 0, z, 13, 0, z)
    for (const x of xs) pts.push(x, 0, -5.6, x, 0, 5.6)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: LINE, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.35 }))
    l.computeLineDistances()
    return l
  }, [])
  const cars = useRef<THREE.InstancedMesh>(null!)
  const n = 70
  const seeds = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => ({
        horizontal: i % 3 !== 0,
        lane: i % 3 !== 0 ? [-5.6, 0, 5.6][i % 3] : [-13, -7.8, -2.6, 2.6, 7.8, 13][i % 6],
        speed: (0.6 + Math.random() * 1.4) * (i % 2 ? 1 : -1),
        off: Math.random() * 100,
      })),
    [],
  )
  const m = useMemo(() => new THREE.Object3D(), [])
  useFrame((s) => {
    const t = s.clock.elapsedTime
    seeds.forEach((c, i) => {
      const span = c.horizontal ? 26 : 11.2
      const p = (((c.off + t * c.speed) % span) + span) % span - span / 2
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
      <instancedMesh ref={cars} args={[undefined, undefined, n]}>
        <boxGeometry />
        <meshBasicMaterial color={MARK} toneMapped={false} />
      </instancedMesh>
    </group>
  )
}

// --- Buildings ----------------------------------------------------------------

const box = new THREE.BoxGeometry(1, 1, 1)
const boxEdges = new THREE.EdgesGeometry(box)

function Building({ lot, index }: { lot: (typeof LOTS)[number]; index: number }) {
  const hovered = useApp((s) => s.hoveredId === lot.site.id)
  const selected = useApp((s) => s.selectedId === lot.site.id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const root = useRef<THREE.Group>(null!)
  const floorsRef = useRef<THREE.Group[]>([])
  const edgeMat = useMemo(() => new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.9 }), [])
  const fillMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#2a6bb8', transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
    [],
  )
  const beacon = useRef<THREE.Mesh>(null!)
  const crane = useRef<THREE.Group>(null!)
  const born = useRef<number | null>(null)
  const active = hovered || selected
  const top = lot.floors * lot.floorH
  const hot = new THREE.Color(MARK)
  const cold = new THREE.Color(LINE)

  useFrame((s, dt) => {
    if (born.current === null) born.current = s.clock.elapsedTime
    const t = s.clock.elapsedTime - born.current
    // build floor by floor on first show
    floorsRef.current.forEach((f, j) => {
      if (!f) return
      const k = THREE.MathUtils.clamp((t - 0.6 - index * 0.14 - j * 0.07) / 0.35, 0, 1)
      const e = 1 - Math.pow(1 - k, 3)
      f.scale.y = Math.max(0.0001, e)
      f.visible = k > 0
    })
    const k = Math.min(1, dt * 10)
    root.current.position.y += ((active ? 0.35 : 0) - root.current.position.y) * k
    edgeMat.color.lerp(active ? hot : cold, k)
    fillMat.opacity += ((active ? 0.72 : 0.5) - fillMat.opacity) * k
    if (beacon.current) {
      const m = beacon.current.material as THREE.MeshBasicMaterial
      m.opacity = 0.5 + Math.sin(s.clock.elapsedTime * 6) * 0.5
    }
    if (crane.current) crane.current.rotation.y = Math.sin(s.clock.elapsedTime * 0.5 + index) * 0.9
  })

  return (
    <group position={[lot.x, 0, lot.z]}>
      {/* lot outline */}
      <lineSegments geometry={boxEdges} scale={[lot.w + 0.8, 0.001, lot.d + 0.8]}>
        <lineBasicMaterial color={LINE} transparent opacity={active ? 0.8 : 0.3} />
      </lineSegments>
      <group
        ref={root}
        onPointerOver={(e) => {
          e.stopPropagation()
          hover(lot.site.id)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          hover(null)
          document.body.style.cursor = ''
        }}
        onClick={(e) => {
          e.stopPropagation()
          select(selected ? null : lot.site.id)
        }}
      >
        {Array.from({ length: lot.floors }, (_, j) => {
          // upper floors step in slightly, like a setback tower
          const inset = j > lot.floors * 0.6 ? 0.82 : 1
          return (
            <group
              key={j}
              ref={(g) => {
                if (g) floorsRef.current[j] = g
              }}
              position={[0, j * lot.floorH, 0]}
            >
              <group position={[0, lot.floorH / 2, 0]} scale={[lot.w * inset, lot.floorH * 0.96, lot.d * inset]}>
                <mesh geometry={box} material={fillMat} />
                <lineSegments geometry={boxEdges} material={edgeMat} />
              </group>
            </group>
          )
        })}
        {lot.site.status === 'attention' && (
          <mesh ref={beacon} position={[0, top + 0.35, 0]}>
            <octahedronGeometry args={[0.18, 0]} />
            <meshBasicMaterial color={ALERT} transparent toneMapped={false} />
          </mesh>
        )}
        {lot.site.status === 'building' && (
          <group ref={crane} position={[lot.w * 0.3, 0, lot.d * 0.3]}>
            <Crane height={top + 1.2} />
          </group>
        )}
        <Anchor id={`lbl-bp-${lot.site.id}`} position={[0, top + 0.9, 0]} />
      </group>
    </group>
  )
}

function Crane({ height }: { height: number }) {
  const geo = useMemo(() => {
    const p = [0, 0, 0, 0, height, 0, -0.6, height, 0, 1.8, height, 0, 0, height + 0.4, 0, -0.6, height, 0, 0, height + 0.4, 0, 1.8, height, 0, 1.4, height, 0, 1.4, height - 0.8, 0]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    return g
  }, [height])
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={MARK} />
    </lineSegments>
  )
}

// --- Camera: isometric with 90° turns, pan and zoom ----------------------------

function Rig({ turn }: { turn: MutableRefObject<number> }) {
  const { camera, gl } = useThree()
  const az = useRef(Math.PI / 4)
  const pan = useRef(new THREE.Vector3())
  const panGoal = useRef(new THREE.Vector3())
  const zoomGoal = useRef(46)

  useEffect(() => {
    const el = gl.domElement
    let drag: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => (drag = { x: e.clientX, y: e.clientY })
    const move = (e: PointerEvent) => {
      if (!drag) return
      const dx = (e.clientX - drag.x) / (camera as THREE.OrthographicCamera).zoom
      const dy = (e.clientY - drag.y) / (camera as THREE.OrthographicCamera).zoom
      const a = az.current
      // screen drag to ground-plane pan (the ground follows the cursor)
      const right = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))
      const fwd = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a))
      panGoal.current.addScaledVector(right, -dx).addScaledVector(fwd, dy * 1.6)
      drag = { x: e.clientX, y: e.clientY }
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomGoal.current = THREE.MathUtils.clamp(zoomGoal.current * (1 - e.deltaY * 0.0012), 22, 140)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    const unsub = useApp.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return
      const lot = LOTS.find((l) => l.site.id === s.selectedId)
      if (lot) {
        // park the building left of centre so the detail callout doesn't cover it
        const a = az.current
        panGoal.current.set(lot.x + Math.sin(a) * 1.3, lot.floors * lot.floorH * 0.4, lot.z - Math.cos(a) * 1.3)
        zoomGoal.current = 78
      } else {
        panGoal.current.set(0, 0, 0)
        zoomGoal.current = 46
      }
    })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      unsub()
    }
  }, [camera, gl])

  useFrame((s, dt) => {
    const cam = camera as THREE.OrthographicCamera
    const k = Math.min(1, dt * 4)
    const goal = Math.PI / 4 + turn.current * (Math.PI / 2)
    az.current += (goal - az.current) * k
    pan.current.lerp(panGoal.current, k)
    const intro = Math.min(1, s.clock.elapsedTime / 1.6)
    const z = zoomGoal.current * (0.75 + 0.25 * (1 - Math.pow(1 - intro, 3)))
    cam.zoom += (z - cam.zoom) * k
    cam.updateProjectionMatrix()
    const r = 40
    cam.position.set(pan.current.x + Math.cos(az.current) * r, pan.current.y + r * 0.82, pan.current.z + Math.sin(az.current) * r)
    cam.lookAt(pan.current)
  })
  return null
}

export function BlueprintScene({ turn }: { turn: MutableRefObject<number> }) {
  return (
    <>
      <color attach="background" args={['#164a86']} />
      <OrthographicCamera makeDefault position={[28, 32, 28]} zoom={34} near={-100} far={200} />
      <Rig turn={turn} />
      <Ground />
      <Roads />
      {LOTS.map((l, i) => (
        <Building key={l.site.id} lot={l} index={i} />
      ))}
    </>
  )
}

