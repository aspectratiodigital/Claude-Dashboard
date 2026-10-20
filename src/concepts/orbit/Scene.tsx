import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Billboard, Html } from '@react-three/drei'
import * as THREE from 'three'
import { SITES } from '../../data/mock'
import { useApp, prefersReducedMotion } from '../../store'

// Orbital layout: radius grows with index, size with traffic.
const maxVisitors = Math.max(...SITES.map((s) => s.visitors7d))
export const PLANETS = SITES.map((s, i) => ({
  site: s,
  radius: 3.4 + i * 1.32,
  size: 0.16 + Math.sqrt(s.visitors7d / maxVisitors) * 0.42,
  speed: 0.55 / Math.pow(1 + i * 0.45, 1.25),
  phase: i * 2.399, // golden angle spread
  tilt: Math.sin(i * 1.3) * 0.06,
}))

/** shared simulated time so the time-warp slider affects every body */
export type Clock = MutableRefObject<number>

const noise = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; } return v; }
`

// --- Sun ---------------------------------------------------------------------

function Sun({ level }: { level: MutableRefObject<number> }) {
  const smooth = useRef(0)
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uLevel: { value: 0 } }), [])
  const corona = useMemo(() => ({ uTime: { value: 0 }, uLevel: { value: 0 } }), [])
  const mesh = useRef<THREE.Mesh>(null!)
  useFrame((s, dt) => {
    level.current *= Math.pow(0.03, dt)
    smooth.current += (level.current - smooth.current) * Math.min(1, dt * 8)
    uniforms.uTime.value = s.clock.elapsedTime
    uniforms.uLevel.value = smooth.current
    corona.uTime.value = s.clock.elapsedTime
    corona.uLevel.value = smooth.current
    mesh.current.rotation.y += dt * 0.05
  })
  return (
    <group>
      <mesh ref={mesh}>
        <sphereGeometry args={[1.5, 96, 96]} />
        <shaderMaterial
          uniforms={uniforms}
          toneMapped={false}
          vertexShader={`varying vec3 vP; varying vec3 vN; varying vec3 vV;
            void main(){ vP = position; vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`}
          fragmentShader={`uniform float uTime; uniform float uLevel; varying vec3 vP; varying vec3 vN; varying vec3 vV; ${noise}
            void main(){
              float n = fbm(vP * 2.2 + vec3(0., uTime * .12, uTime * .05));
              float m = fbm(vP * 6.0 - vec3(uTime * .2));
              float k = n * .75 + m * .35;
              vec3 deep = vec3(1.4, .32, .06); vec3 gold = vec3(1.9, .95, .26); vec3 hot = vec3(2.6, 1.8, .9);
              vec3 c = mix(deep, gold, smoothstep(.3, .62, k));
              c = mix(c, hot, smoothstep(.62, .85, k));
              float rim = pow(1. - max(dot(vN, vV), 0.), 2.);
              c += vec3(2.4, 1.0, .3) * rim * (1. + uLevel * 2.);
              gl_FragColor = vec4(c * (1. + uLevel * .6), 1.);
            }`}
        />
      </mesh>
      <Billboard>
        <mesh>
          <planeGeometry args={[9, 9]} />
          <shaderMaterial
            uniforms={corona}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
            vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`}
            fragmentShader={`uniform float uTime; uniform float uLevel; varying vec2 vUv; ${noise}
              void main(){
                vec2 p = vUv - .5; float d = length(p) * 2.;
                float a = atan(p.y, p.x);
                float rays = fbm(vec3(cos(a) * 3., sin(a) * 3., uTime * .25)) * .6 + .4;
                float g = smoothstep(1., .3, d) * pow(max(0., 1. - d), 1.5) * rays;
                g *= smoothstep(.3, .36, d);
                gl_FragColor = vec4(vec3(1., .55, .18) * g * (1.3 + uLevel * 2.5), 1.);
              }`}
          />
        </mesh>
      </Billboard>
      <pointLight intensity={60} distance={0} decay={1.4} color="#ffd9a8" />
    </group>
  )
}

// --- Planets -----------------------------------------------------------------

const planetVert = `varying vec3 vN; varying vec3 vW; varying vec3 vP; varying vec3 vV;
  void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`
const planetFrag = `uniform vec3 uA; uniform vec3 uB; uniform float uSeed; uniform float uHot; varying vec3 vN; varying vec3 vW; varying vec3 vP; varying vec3 vV; ${noise}
  void main(){
    vec3 L = normalize(-vW);
    float diff = max(dot(vN, L), 0.);
    float bands = fbm(vec3(vP.y * 6. + uSeed, vP.x * 1.5, vP.z * 1.5) + fbm(vP * 3. + uSeed) * 1.2);
    vec3 base = mix(uB, uA, smoothstep(.25, .75, bands));
    float rim = pow(1. - max(dot(vN, vV), 0.), 3.);
    vec3 c = base * (.05 + diff * 1.15) + uA * rim * (.5 + uHot * 1.2) * (.3 + diff);
    gl_FragColor = vec4(c, 1.);
  }`

function Planet({ p, index, clock }: { p: (typeof PLANETS)[number]; index: number; clock: Clock }) {
  const hovered = useApp((s) => s.hoveredId === p.site.id)
  const selected = useApp((s) => s.selectedId === p.site.id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const anchor = useRef<THREE.Group>(null!)
  const body = useRef<THREE.Mesh>(null!)
  const ringMat = useRef<THREE.LineBasicMaterial>(null!)
  const moons = useRef<THREE.Group>(null!)
  const active = hovered || selected

  const uniforms = useMemo(() => {
    const a = new THREE.Color(p.site.brand.accent)
    const b = new THREE.Color(p.site.brand.bg).lerp(new THREE.Color('#1a1420'), 0.4)
    return { uA: { value: a }, uB: { value: b }, uSeed: { value: index * 7.3 }, uHot: { value: 0 } }
  }, [p, index])

  const orbit = useMemo(() => {
    const pts = new THREE.EllipseCurve(0, 0, p.radius, p.radius, 0, Math.PI * 2).getPoints(220)
    return new THREE.BufferGeometry().setFromPoints(pts.map((v) => new THREE.Vector3(v.x, 0, v.y)))
  }, [p])

  useFrame((_, dt) => {
    const a = p.phase + clock.current * p.speed
    anchor.current.position.set(Math.cos(a) * p.radius, 0, Math.sin(a) * p.radius)
    body.current.rotation.y += dt * 0.4
    const k = Math.min(1, dt * 8)
    const s = active ? 1.35 : 1
    body.current.scale.setScalar(body.current.scale.x + (s - body.current.scale.x) * k)
    uniforms.uHot.value += ((active ? 1 : 0) - uniforms.uHot.value) * k
    ringMat.current.opacity += ((active ? 0.55 : 0.1) - ringMat.current.opacity) * k
    moons.current.rotation.y += dt * 1.2
  })

  return (
    <group rotation={[p.tilt, 0, p.tilt * 0.5]}>
      <lineLoop geometry={orbit}>
        <lineBasicMaterial ref={ringMat} color={p.site.status === 'attention' ? '#ff6b5a' : '#ffd29a'} transparent opacity={0.1} />
      </lineLoop>
      <group ref={anchor} name={p.site.id}>
        <mesh
          ref={body}
          onPointerOver={(e) => {
            e.stopPropagation()
            hover(p.site.id)
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            hover(null)
            document.body.style.cursor = ''
          }}
          onClick={(e) => {
            e.stopPropagation()
            select(p.site.id)
          }}
        >
          <sphereGeometry args={[p.size, 48, 48]} />
          <shaderMaterial uniforms={uniforms} vertexShader={planetVert} fragmentShader={planetFrag} />
        </mesh>
        {/* rings for sites with lots of open PRs */}
        {p.site.openPRs >= 3 && (
          <mesh rotation={[Math.PI / 2.3, 0.2, 0]}>
            <ringGeometry args={[p.size * 1.45, p.size * 2.1, 96]} />
            <meshBasicMaterial color={p.site.brand.accent} transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        )}
        {/* a moon per branch */}
        <group ref={moons}>
          {Array.from({ length: Math.min(p.site.branches, 5) }, (_, m) => {
            const r = p.size * 1.8 + m * 0.14
            const a = m * 2.1
            return (
              <mesh key={m} position={[Math.cos(a) * r, Math.sin(m * 1.7) * 0.08, Math.sin(a) * r]}>
                <sphereGeometry args={[0.035, 10, 10]} />
                <meshStandardMaterial color="#d8cfc4" roughness={1} />
              </mesh>
            )
          })}
        </group>
        <Html center position={[0, p.size + 0.38, 0]} className="ob-label-wrap" zIndexRange={[5, 0]}>
          <div className="ob-label" data-active={active} data-status={p.site.status}>
            {p.site.name}
          </div>
        </Html>
      </group>
    </group>
  )
}

// --- Backdrop -----------------------------------------------------------------

function Stars() {
  const geo = useMemo(() => {
    const n = 5000
    const pos = new Float32Array(n * 3)
    const size = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const r = 60 + Math.random() * 60
      const t = Math.random() * Math.PI * 2
      const u = Math.random() * 2 - 1
      const s = Math.sqrt(1 - u * u)
      pos.set([Math.cos(t) * s * r, u * r, Math.sin(t) * s * r], i * 3)
      size[i] = Math.pow(Math.random(), 6) * 3 + 0.6
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('size', new THREE.BufferAttribute(size, 1))
    return g
  }, [])
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uDpr: { value: Math.min(2, window.devicePixelRatio) } }), [])
  useFrame((s) => (uniforms.uTime.value = s.clock.elapsedTime))
  return (
    <points geometry={geo}>
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        vertexShader={`attribute float size; uniform float uTime; uniform float uDpr; varying float vA;
          void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = size * uDpr * 1.6; vA = .55 + .45 * sin(uTime * (1. + size) + position.x); gl_Position = projectionMatrix * mv; }`}
        fragmentShader={`varying float vA; void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d); gl_FragColor = vec4(vec3(1., .93, .85) * a * vA, a * vA); }`}
      />
    </points>
  )
}

function Belt({ clock }: { clock: Clock }) {
  const ref = useRef<THREE.InstancedMesh>(null!)
  const n = 900
  useEffect(() => {
    const m = new THREE.Object3D()
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 8.02 + (Math.random() - 0.5) * 0.6 + Math.sin(a * 5) * 0.08
      m.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 0.25, Math.sin(a) * r)
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
      m.scale.setScalar(0.015 + Math.pow(Math.random(), 3) * 0.06)
      m.updateMatrix()
      ref.current.setMatrixAt(i, m.matrix)
    }
    ref.current.instanceMatrix.needsUpdate = true
  }, [])
  useFrame(() => {
    ref.current.rotation.y = clock.current * 0.018
  })
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, n]}>
      <dodecahedronGeometry args={[1, 0]} />
      <meshStandardMaterial color="#a89c8f" roughness={1} flatShading />
    </instancedMesh>
  )
}

// --- Camera -------------------------------------------------------------------

function Rig({ clock, warp }: { clock: Clock; warp: MutableRefObject<number> }) {
  const { camera, scene, gl } = useThree()
  const sph = useRef({ az: -0.6, pol: 1.08, dist: 30 })
  const goal = useRef({ az: -0.6, pol: 1.08, dist: 22 })
  const target = useMemo(() => new THREE.Vector3(), [])
  const tmp = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const el = gl.domElement
    let drag: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => (drag = { x: e.clientX, y: e.clientY })
    const move = (e: PointerEvent) => {
      if (!drag) return
      goal.current.az += (e.clientX - drag.x) * 0.005
      goal.current.pol = Math.max(0.25, Math.min(1.5, goal.current.pol - (e.clientY - drag.y) * 0.004))
      drag = { x: e.clientX, y: e.clientY }
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const sel = useApp.getState().selectedId
      const [lo, hi] = sel ? [1.6, 9] : [8, 40]
      goal.current.dist = Math.max(lo, Math.min(hi, goal.current.dist * (1 + e.deltaY * 0.0012)))
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [gl])

  // zoom in/out when selection changes
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        if (s.selectedId === prev.selectedId) return
        const p = PLANETS.find((x) => x.site.id === s.selectedId)
        goal.current.dist = p ? 1.6 + p.size * 7 : 22
        if (!p) goal.current.pol = 1.08
        else goal.current.pol = 1.2
      }),
    [],
  )

  useFrame((_, dt) => {
    clock.current += dt * warp.current * (prefersReducedMotion ? 0.2 : 1)
    const { selectedId } = useApp.getState()
    if (!selectedId) goal.current.az += dt * 0.02
    const k = Math.min(1, dt * 3)
    const s = sph.current
    s.az += (goal.current.az - s.az) * k
    s.pol += (goal.current.pol - s.pol) * k
    s.dist += (goal.current.dist - s.dist) * k
    const obj = selectedId ? scene.getObjectByName(selectedId) : null
    if (obj) obj.getWorldPosition(tmp)
    else tmp.set(0, 0, 0)
    target.lerp(tmp, selectedId ? Math.min(1, dt * 6) : k)
    camera.position.set(
      target.x + s.dist * Math.sin(s.pol) * Math.cos(s.az),
      target.y + s.dist * Math.cos(s.pol),
      target.z + s.dist * Math.sin(s.pol) * Math.sin(s.az),
    )
    camera.lookAt(target)
  })
  return null
}

export function OrbitScene({ level, warp }: { level: MutableRefObject<number>; warp: MutableRefObject<number> }) {
  const clock = useRef(0)
  return (
    <>
      <color attach="background" args={['#07060b']} />
      <Rig clock={clock} warp={warp} />
      <ambientLight intensity={0.06} />
      <Sun level={level} />
      {PLANETS.map((p, i) => (
        <Planet key={p.site.id} p={p} index={i} clock={clock} />
      ))}
      <Belt clock={clock} />
      <Stars />
    </>
  )
}
