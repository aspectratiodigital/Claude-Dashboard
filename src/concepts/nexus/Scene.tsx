import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { NoteKind, Project, Status } from '../../data/types'
import { onNote, useData } from '../../data/store'
import { signals } from '../../data/derive'
import { useApp, prefersReducedMotion } from '../../store'
import { Anchor } from '../../shared/Labels'
import { SNOISE, SOFT_POINT_FRAG } from '../../shared/glsl'

// Nexus, rebuilt: one liquid Claude core, every project a glowing droplet on a
// slow orbit, joined to the core by ribbons of flowing light. Everything is
// soft-edged (sprites, fresnel, anti-aliased shader bands) and eased, so there's
// nothing to shimmer or flash.

export const NX_COLOR: Record<Status, string> = {
  live: '#5ce1ff',
  building: '#ffb547',
  deploying: '#a98bff',
  attention: '#ffd166',
  broken: '#ff5c7a',
  quiet: '#58788a',
}

const R = 4.7
const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3)
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))

/** One impulse per project per kind of effect, written by the notification bus, read in useFrame. */
export interface Impulse {
  at: number
  kind: NoteKind
}
export type Impulses = Map<string, Impulse>

const tone = (kind: NoteKind) =>
  kind === 'build-fail' || kind === 'deploy-fail' || kind === 'down' ? '#ff5c7a' : kind === 'deployed' || kind === 'build-ok' || kind === 'up' || kind === 'merged' ? '#6dffc1' : kind === 'issue' || kind === 'review' || kind === 'perf' ? '#ffd166' : '#8fe9ff'

// --- Shaders ------------------------------------------------------------------------------

const fresnelVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`

const coreVert = /* glsl */ `
  uniform float uTime; uniform float uLevel; uniform float uRipple;
  varying vec3 vN; varying vec3 vV; varying float vD;
  ${SNOISE}
  float field(vec3 p){
    float t = uTime;
    float d = snoise(p * 1.25 + vec3(0.0, t * 0.22, t * 0.16)) * (0.13 + uLevel * 0.12);
    d += snoise(p * 2.7 - vec3(t * 0.28)) * 0.035;
    d += uRipple * 0.07 * sin(p.y * 9.0 - t * 7.0);
    return d;
  }
  void main(){
    vec3 n = normalize(position);
    vec3 tA = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 tB = cross(n, tA);
    float e = 0.02;
    vec3 p0 = n * (1.0 + field(n));
    vec3 p1 = normalize(n + tA * e); p1 *= 1.0 + field(p1);
    vec3 p2 = normalize(n + tB * e); p2 *= 1.0 + field(p2);
    vec3 nn = normalize(cross(p1 - p0, p2 - p0));
    vD = length(p0) - 1.0;
    vec4 mv = modelViewMatrix * vec4(p0, 1.0);
    vN = normalize(normalMatrix * nn);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`

const coreFrag = /* glsl */ `
  uniform float uLevel; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
  varying vec3 vN; varying vec3 vV; varying float vD;
  void main(){
    float ndv = max(dot(vN, vV), 0.0);
    float f = pow(1.0 - ndv, 2.2);
    vec3 body = mix(uA, uB, smoothstep(-0.12, 0.16, vD));
    vec3 col = body * (0.32 + 0.25 * ndv) + uC * f * (1.25 + uLevel * 0.8);
    col += vec3(1.0) * pow(ndv, 24.0) * 0.18;
    gl_FragColor = vec4(col, 1.0);
  }`

const orbFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uGlow;
  varying vec3 vN; varying vec3 vV;
  void main(){
    float ndv = max(dot(vN, vV), 0.0);
    float f = pow(1.0 - ndv, 2.0);
    vec3 col = uColor * (0.28 + f * (1.1 + uGlow)) + vec3(1.0) * pow(ndv, 18.0) * 0.22;
    gl_FragColor = vec4(col, 1.0);
  }`

const shellFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha;
  varying vec3 vN; varying vec3 vV;
  void main(){
    float f = pow(1.0 - max(dot(vN, vV), 0.0), 3.0);
    gl_FragColor = vec4(uColor * f * uAlpha, f * uAlpha);
  }`

const haloVert = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const haloFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 4.5) * (1.0 - smoothstep(0.85, 1.0, d));
    gl_FragColor = vec4(uColor * a * uAlpha, a * uAlpha);
  }`

const ribbonVert = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`
const ribbonFrag = /* glsl */ `
  uniform float uTime; uniform float uSpeed; uniform float uHot; uniform float uPacket; uniform float uPacket2; uniform vec3 uColor;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){
    float x = vUv.x;
    float edge = pow(abs(dot(vN, vV)), 1.4);
    float bands = pow(0.5 + 0.5 * sin(x * 18.0 - uTime * uSpeed), 6.0);
    float ends = smoothstep(0.0, 0.1, x) * smoothstep(1.0, 0.82, x);
    float pk = exp(-pow((x - uPacket) * 12.0, 2.0)) * step(-0.01, uPacket);
    float pk2 = exp(-pow((x - uPacket2) * 12.0, 2.0)) * step(-0.01, uPacket2);
    float a = (0.07 + 0.18 * uHot + bands * (0.22 + 0.4 * uHot) + (pk + pk2) * 1.4) * ends * edge;
    gl_FragColor = vec4(uColor * a * 1.5, a);
  }`

const pointVert = /* glsl */ `
  uniform float uTime; uniform float uSize; uniform float uAlpha; uniform float uWobble;
  attribute vec4 aSeed; varying float vAlpha;
  void main(){
    float a = aSeed.x + uTime * aSeed.z;
    float r = aSeed.y;
    vec3 p = vec3(cos(a) * r, aSeed.w + sin(uTime * 0.35 + aSeed.x * 3.0) * uWobble, sin(a) * r);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (8.0 / -mv.z);
    vAlpha = uAlpha * (0.4 + 0.6 * fract(aSeed.x * 7.13));
    gl_Position = projectionMatrix * mv;
  }`

const floorFrag = /* glsl */ `
  uniform float uTime; uniform vec3 uColor; uniform float uPulse; varying vec3 vW;
  void main(){
    float r = length(vW.xz);
    float ph = r * 0.42 - uTime * 0.14;
    float d = abs(fract(ph) - 0.5);
    float aa = fwidth(ph) * 1.5;
    float band = 1.0 - smoothstep(0.0, 0.035 + aa, d);
    float fade = smoothstep(17.0, 3.0, r);
    float glow = exp(-r * 0.28);
    float wave = exp(-pow(r - uPulse * 14.0, 2.0) * 0.6) * (1.0 - uPulse);
    vec3 col = uColor * (band * 0.11 * fade + glow * 0.16 + wave * 0.35);
    gl_FragColor = vec4(col, 1.0);
  }`

const backFrag = /* glsl */ `
  uniform float uTime; varying vec2 vUv;
  ${SNOISE}
  void main(){
    vec2 p = vUv - vec2(0.5, 0.55);
    float v = exp(-dot(p, p) * 3.2);
    float n = snoise(vec3(vUv * 2.2, uTime * 0.03)) * 0.5 + 0.5;
    vec3 a = vec3(0.012, 0.035, 0.07);
    vec3 b = vec3(0.03, 0.09, 0.15);
    vec3 c = vec3(0.07, 0.04, 0.14);
    vec3 col = mix(a, b, v) + c * n * v * 0.9;
    gl_FragColor = vec4(col, 1.0);
  }`

function fresnelMat(frag: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) {
  return new THREE.ShaderMaterial({ vertexShader: fresnelVert, fragmentShader: frag, uniforms, ...extra })
}

// --- Core ------------------------------------------------------------------------------------

function Core({ level, ripple, born }: { level: MutableRefObject<number>; ripple: MutableRefObject<number>; born: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!)
  const smooth = useRef(0)
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: coreVert,
        fragmentShader: coreFrag,
        uniforms: {
          uTime: { value: 0 },
          uLevel: { value: 0 },
          uRipple: { value: 0 },
          uA: { value: new THREE.Color('#0b2a6b') },
          uB: { value: new THREE.Color('#1fb6d9') },
          uC: { value: new THREE.Color('#8ff3ff') },
        },
      }),
    [],
  )
  const halo = useMemo(() => new THREE.ShaderMaterial({ vertexShader: haloVert, fragmentShader: haloFrag, uniforms: { uColor: { value: new THREE.Color('#3fc8ff') }, uAlpha: { value: 0.55 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const halo2 = useMemo(() => new THREE.ShaderMaterial({ vertexShader: haloVert, fragmentShader: haloFrag, uniforms: { uColor: { value: new THREE.Color('#8a6bff') }, uAlpha: { value: 0.3 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const haloRef = useRef<THREE.Mesh>(null!)
  const halo2Ref = useRef<THREE.Mesh>(null!)
  const { camera } = useThree()

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    level.current *= Math.exp(-dt * 3)
    ripple.current *= Math.exp(-dt * 1.6)
    smooth.current = damp(smooth.current, level.current, 6, dt)
    mat.uniforms.uTime.value = t
    mat.uniforms.uLevel.value = smooth.current
    mat.uniforms.uRipple.value = ripple.current
    const b = ease((t - born.current) / 1.6)
    group.current.scale.setScalar(b * (1.05 + smooth.current * 0.06 + Math.sin(t * 0.9) * 0.015))
    haloRef.current.quaternion.copy(camera.quaternion)
    halo2Ref.current.quaternion.copy(camera.quaternion)
    halo.uniforms.uAlpha.value = 0.5 + smooth.current * 0.3 + ripple.current * 0.4
    halo2Ref.current.rotation.z = t * 0.05
  })

  return (
    <group ref={group}>
      <mesh material={mat}>
        <icosahedronGeometry args={[1, 48]} />
      </mesh>
      <mesh ref={haloRef} material={halo} scale={5.2} renderOrder={-1}>
        <planeGeometry />
      </mesh>
      <mesh ref={halo2Ref} material={halo2} scale={[8, 6, 1]} renderOrder={-2}>
        <planeGeometry />
      </mesh>
    </group>
  )
}

// --- Project droplets ---------------------------------------------------------------------------

function makePoints(n: number, seed: (i: number) => [number, number, number, number]) {
  const g = new THREE.BufferGeometry()
  const s = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) s.set(seed(i), i * 4)
  g.setAttribute('aSeed', new THREE.BufferAttribute(s, 4))
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50)
  return g
}

function pointsMat(color: string, size: number, vert = pointVert, wobble = 0.04) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: SOFT_POINT_FRAG,
    uniforms: { uTime: { value: 0 }, uSize: { value: size }, uAlpha: { value: 0 }, uWobble: { value: wobble }, uColor: { value: new THREE.Color(color) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

const streamVert = /* glsl */ `
  uniform float uTime; uniform float uSize; uniform float uAlpha;
  attribute vec4 aSeed; varying float vAlpha;
  void main(){
    float k = fract(uTime * 0.45 + aSeed.x);
    float a = aSeed.y + uTime * 1.5;
    vec3 p = vec3(cos(a) * 0.18 * (1.0 - k), k * 1.9 + 0.2, sin(a) * 0.18 * (1.0 - k));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (8.0 / -mv.z) * (1.0 - k * 0.6);
    vAlpha = uAlpha * smoothstep(0.0, 0.15, k) * (1.0 - k);
    gl_Position = projectionMatrix * mv;
  }`

function Droplet({ project, index, total, impulses }: { project: Project; index: number; total: number; impulses: Impulses }) {
  const hovered = useApp((s) => s.hoveredId === project.id)
  const selected = useApp((s) => s.selectedId === project.id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const sig = signals(project)
  const color = NX_COLOR[project.status]
  const a = (index / total) * Math.PI * 2
  const pos = useMemo(() => new THREE.Vector3(Math.sin(a) * R, 0, Math.cos(a) * R), [a])
  const root = useRef<THREE.Group>(null!)
  const orb = useRef<THREE.Mesh>(null!)
  const haloRef = useRef<THREE.Mesh>(null!)
  const shellRef = useRef<THREE.Mesh>(null!)
  const spinner = useRef<THREE.Points>(null!)
  const sats = useRef<THREE.Points>(null!)
  const { camera } = useThree()

  const target = useMemo(() => new THREE.Color(color), [color])
  const orbMat = useMemo(() => fresnelMat(orbFrag, { uColor: { value: new THREE.Color(color) }, uGlow: { value: 0 } }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const haloMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: haloVert, fragmentShader: haloFrag, uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0.5 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const shellMat = useMemo(() => fresnelMat(shellFrag, { uColor: { value: new THREE.Color('#6dffc1') }, uAlpha: { value: 0 } }, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const ribbonMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: ribbonVert,
        fragmentShader: ribbonFrag,
        uniforms: { uTime: { value: 0 }, uSpeed: { value: 2 }, uHot: { value: 0 }, uPacket: { value: -1 }, uPacket2: { value: -1 }, uColor: { value: new THREE.Color(color) } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const ribbonGeo = useMemo(() => {
    const mid = pos.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.3, 0))
    const curve = new THREE.QuadraticBezierCurve3(pos.clone(), mid, new THREE.Vector3(0, 0.15, 0))
    return new THREE.TubeGeometry(curve, 64, 0.022, 6, false)
  }, [pos])
  const spinGeo = useMemo(() => makePoints(10, (i) => [(i / 10) * Math.PI * 2, 0.42, 1.6, 0]), [])
  const spinMat = useMemo(() => pointsMat('#ffb547', 3.2), [])
  const satGeo = useMemo(() => makePoints(6, (i) => [(i / 6) * Math.PI * 2, 0.55 + (i % 2) * 0.08, 0.7 + i * 0.05, (i % 3) * 0.08 - 0.08]), [])
  const satMat = useMemo(() => pointsMat('#ffd166', 4.2), [])
  const streamGeo = useMemo(() => makePoints(26, (i) => [i / 26, i * 2.4, 0, 0]), [])
  const streamMat = useMemo(() => pointsMat('#b8a0ff', 3, streamVert), [])

  useEffect(() => {
    target.set(color)
  }, [color, target])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const active = hovered || selected
    // colour + size ease toward state
    orbMat.uniforms.uColor.value.lerp(target, 1 - Math.exp(-dt * 3))
    haloMat.uniforms.uColor.value.copy(orbMat.uniforms.uColor.value)
    ribbonMat.uniforms.uColor.value.copy(orbMat.uniforms.uColor.value)
    const beat = sig.broken ? Math.pow(Math.max(0, Math.sin(t * 2.4)), 10) * 0.18 : 0
    const s = (active ? 1.35 : 1) + beat + Math.sin(t * 1.3 + index) * 0.02
    root.current.scale.setScalar(damp(root.current.scale.x, s, 8, dt))
    orbMat.uniforms.uGlow.value = damp(orbMat.uniforms.uGlow.value, active ? 1 : sig.broken ? 0.6 + beat * 3 : 0.25, 6, dt)
    haloRef.current.quaternion.copy(camera.quaternion)
    haloMat.uniforms.uAlpha.value = damp(haloMat.uniforms.uAlpha.value, active ? 0.95 : sig.broken ? 0.65 + beat * 2 : 0.45, 5, dt)

    // ribbon flow: faster with activity, hot when hovered, packets on events
    ribbonMat.uniforms.uTime.value = t
    ribbonMat.uniforms.uSpeed.value = 1.2 + Math.min(project.commitsWeek, 30) * 0.12 + (sig.building ? 3 : 0)
    ribbonMat.uniforms.uHot.value = damp(ribbonMat.uniforms.uHot.value, active ? 1 : 0, 6, dt)
    const imp = impulses.get(project.id)
    const since = imp ? t - imp.at : 99
    ribbonMat.uniforms.uPacket.value = since < 1.1 ? since / 1.1 : -1
    // Claude working: packets travel from the core out to the project, on a loop
    ribbonMat.uniforms.uPacket2.value = sig.claude ? 1 - ((t * 0.55 + index * 0.3) % 1) : -1

    // shockwave on events
    if (since < 1.6) {
      const k = since / 1.6
      shellRef.current.visible = true
      shellRef.current.scale.setScalar(0.3 + ease(k) * 2.4)
      shellMat.uniforms.uAlpha.value = Math.pow(1 - k, 2) * 1.4
      shellMat.uniforms.uColor.value.set(tone(imp!.kind))
    } else shellRef.current.visible = false

    // building spinner, issue satellites, deploy stream
    spinMat.uniforms.uTime.value = t
    spinMat.uniforms.uAlpha.value = damp(spinMat.uniforms.uAlpha.value, sig.building ? 1 : 0, 4, dt)
    spinner.current.visible = spinMat.uniforms.uAlpha.value > 0.01
    satMat.uniforms.uTime.value = t
    satMat.uniforms.uAlpha.value = damp(satMat.uniforms.uAlpha.value, sig.issues ? 1 : 0, 3, dt)
    sats.current.visible = satMat.uniforms.uAlpha.value > 0.01
    satGeo.setDrawRange(0, Math.min(6, sig.issues))
    streamMat.uniforms.uTime.value = t
    streamMat.uniforms.uAlpha.value = damp(streamMat.uniforms.uAlpha.value, sig.deploying ? 1 : 0, 3, dt)
  })

  return (
    <group>
      <mesh geometry={ribbonGeo} material={ribbonMat} />
      <group position={pos}>
        <group
          ref={root}
          onPointerOver={(e) => {
            e.stopPropagation()
            hover(project.id)
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            hover(null)
            document.body.style.cursor = ''
          }}
          onClick={(e) => {
            e.stopPropagation()
            select(selected ? null : project.id)
          }}
        >
          <mesh ref={orb} material={orbMat}>
            <sphereGeometry args={[0.24, 32, 24]} />
          </mesh>
          <mesh ref={haloRef} material={haloMat} scale={1.7}>
            <planeGeometry />
          </mesh>
          <mesh visible={false}>
            <sphereGeometry args={[0.6, 8, 8]} />
          </mesh>
          <points ref={spinner} geometry={spinGeo} material={spinMat} />
          <points ref={sats} geometry={satGeo} material={satMat} />
          <points geometry={streamGeo} material={streamMat} />
          <mesh ref={shellRef} material={shellMat} visible={false}>
            <sphereGeometry args={[0.3, 32, 16]} />
          </mesh>
          <Anchor id={`lbl-nx-${project.id}`} position={[0, -0.62, 0]} />
        </group>
      </group>
    </group>
  )
}

function Orbit({ born, impulses, projects }: { born: MutableRefObject<number>; impulses: Impulses; projects: Project[] }) {
  const ring = useRef<THREE.Group>(null!)
  const theta = useRef(0.35)
  const guide = useMemo(() => {
    const g = new THREE.RingGeometry(R - 0.006, R + 0.006, 256, 1)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])
  useFrame((state, dt) => {
    const { selectedId, hoveredId } = useApp.getState()
    const idx = projects.findIndex((p) => p.id === selectedId)
    if (idx >= 0) {
      const target = -(idx / projects.length) * Math.PI * 2
      let d = target - theta.current
      d = Math.atan2(Math.sin(d), Math.cos(d))
      theta.current += d * (1 - Math.exp(-dt * 2.6))
    } else if (!hoveredId && !prefersReducedMotion) theta.current += dt * 0.045
    ring.current.rotation.y = theta.current
    const b = ease((state.clock.elapsedTime - born.current - 0.4) / 1.4)
    ring.current.scale.setScalar(0.7 + b * 0.3)
    ring.current.visible = b > 0.01
  })
  return (
    <group rotation={[0.1, 0, 0]} ref={ring}>
      <mesh geometry={guide}>
        <meshBasicMaterial color="#2b8fb3" transparent opacity={0.22} depthWrite={false} />
      </mesh>
      {projects.map((p, i) => (
        <Droplet key={p.id} project={p} index={i} total={projects.length} impulses={impulses} />
      ))}
    </group>
  )
}

// --- Atmosphere ---------------------------------------------------------------------------------

function Motes() {
  const geo = useMemo(() => {
    const n = 900
    return makePoints(n, () => {
      const r = 2.2 + Math.pow(Math.random(), 0.7) * 9
      return [Math.random() * Math.PI * 2, r, (0.02 + Math.random() * 0.05) * (8 / r), (Math.random() - 0.5) * 5]
    })
  }, [])
  const mat = useMemo(() => {
    const m = pointsMat('#79e4ff', 1.6, pointVert, 0.25)
    m.uniforms.uAlpha.value = 0.5
    return m
  }, [])
  useFrame((s) => (mat.uniforms.uTime.value = s.clock.elapsedTime))
  return <points geometry={geo} material={mat} />
}

function Floor({ pulse }: { pulse: MutableRefObject<number> }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: floorFrag,
        uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#3fc8ff') }, uPulse: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useFrame((s, dt) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime
    pulse.current = Math.min(1, pulse.current + dt * 0.45)
    mat.uniforms.uPulse.value = pulse.current
  })
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.5, 0]} material={mat}>
      <planeGeometry args={[44, 44]} />
    </mesh>
  )
}

function Backdrop() {
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: haloVert, fragmentShader: backFrag, uniforms: { uTime: { value: 0 } }, depthWrite: false }),
    [],
  )
  const ref = useRef<THREE.Mesh>(null!)
  const { camera } = useThree()
  const dir = useMemo(() => new THREE.Vector3(), [])
  useFrame((s) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime
    // keep it parked behind everything, facing the camera
    ref.current.position.copy(camera.position).add(camera.getWorldDirection(dir).multiplyScalar(40))
    ref.current.quaternion.copy(camera.quaternion)
  })
  return (
    <mesh ref={ref} material={mat} scale={[110, 70, 1]} renderOrder={-10}>
      <planeGeometry />
    </mesh>
  )
}

function Rig({ pointer }: { pointer: MutableRefObject<{ x: number; y: number }> }) {
  const { camera, size } = useThree()
  const look = useMemo(() => new THREE.Vector3(0, -0.25, 0), [])
  const offset = useRef(0)
  useFrame((state, dt) => {
    const sel = useApp.getState().selectedId
    const intro = ease(state.clock.elapsedTime / 2.4)
    const z = 16 - intro * 4.6 + (sel ? 0.4 : 0)
    camera.position.x = damp(camera.position.x, pointer.current.x * 0.8, 1.6, dt)
    camera.position.y = damp(camera.position.y, 2.1 - pointer.current.y * 0.5, 1.6, dt)
    camera.position.z = damp(camera.position.z, z, 2, dt)
    camera.lookAt(look)
    // slide the whole scene left when the detail panel opens, without changing perspective
    offset.current = damp(offset.current, sel ? size.width * 0.24 : 0, 3, dt)
    ;(camera as THREE.PerspectiveCamera).setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
  })
  return null
}

export function NexusScene({ level, pointer }: { level: MutableRefObject<number>; pointer: MutableRefObject<{ x: number; y: number }> }) {
  const projects = useData((s) => s.projects)
  const born = useRef(0)
  const ripple = useRef(0)
  const pulse = useRef(1)
  const impulses = useMemo<Impulses>(() => new Map(), [])
  const clock = useThree((s) => s.clock)

  useEffect(
    () =>
      onNote((n) => {
        impulses.set(n.projectId, { at: clock.elapsedTime, kind: n.kind })
        ripple.current = 1
        pulse.current = 0
        level.current = Math.max(level.current, 0.6)
      }),
    [impulses, clock, level],
  )
  useFrame((state) => {
    if (born.current === 0) born.current = state.clock.elapsedTime + 0.0001
  })

  return (
    <>
      <color attach="background" args={['#030810']} />
      <fog attach="fog" args={['#030810', 14, 34]} />
      <Rig pointer={pointer} />
      <Backdrop />
      <Core level={level} ripple={ripple} born={born} />
      {projects.length > 0 && <Orbit born={born} impulses={impulses} projects={projects} />}
      <Motes />
      <Floor pulse={pulse} />
    </>
  )
}
