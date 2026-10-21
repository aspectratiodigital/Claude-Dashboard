import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Note, NoteLevel, Project } from '../../data/types'
import { useData } from '../../data/store'
import { signals } from '../../data/derive'
import { useApp, prefersReducedMotion } from '../../store'
import type { Tier } from '../../shared/quality'
import { Anchor } from '../../shared/Labels'
import { since, useImpulses, type Impulses } from '../../shared/pulse'
import { SNOISE } from '../../shared/glsl'

// Reef: each project is a coral colony on a sunlit seabed. The coral is grown
// from the project itself (branching coral from its pages, brain coral from
// its commits, tube coral from the last 14 days of activity) and the reef
// shows what's going on: bubbles while it builds, a school of fish rising
// while it deploys, bleaching when it breaks, silt when the site is down,
// crabs and urchins for issues, pearls for pull requests, a glowing jellyfish
// after a deploy, and Claude's little orange submarine when Claude's at work.

export const LEVEL: Record<NoteLevel, string> = { info: '#7fc8ff', progress: '#ffd36e', success: '#6dffb5', warning: '#ffbe6e', critical: '#ff6e8a' }
export const CLAUDE = '#d97757'
const FOG = new THREE.Color('#0a4256')
const DENSITY = 0.028
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))
const noRay = () => null
const UP = new THREE.Vector3(0, 1, 0)

function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

/** Gentle dunes; colonies, critters and the camera all sit on this. */
export function seabed(x: number, z: number) {
  return Math.sin(x * 0.31) * 0.28 + Math.cos(z * 0.27 + x * 0.12) * 0.32 + Math.sin((x + z) * 0.73) * 0.07
}

export type CoralKind = 'branching' | 'brain' | 'tube'
const KINDS: CoralKind[] = ['branching', 'brain', 'tube']

export interface Site {
  project: Project
  index: number
  x: number
  z: number
  y: number
  kind: CoralKind
}

/** Colonies spread out on a sunflower spiral so none crowd each other. */
export function useSites() {
  const projects = useData((s) => s.projects)
  return useMemo(() => {
    const sites: Site[] = projects.map((p, i) => {
      const r = projects.length === 1 ? 0 : 3.4 * Math.sqrt(i + 0.6)
      const a = i * 2.39996 + 0.6
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      return { project: p, index: i, x, z, y: seabed(x, z), kind: KINDS[Math.floor(rng(p.id)() * 3)] }
    })
    const radius = sites.reduce((m, s) => Math.max(m, Math.hypot(s.x, s.z)), 0) + 2.4
    return { sites, radius }
  }, [projects])
}

// --- growing coral --------------------------------------------------------------------------------

function paint(g: THREE.BufferGeometry, c: THREE.Color) {
  const out = g.index ? g.toNonIndexed() : g
  if (out !== g) g.dispose()
  const n = out.attributes.position.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.clearGroups()
  return out
}

/** The project's accent, warmed toward coral so every colony still reads as living reef. */
function coralColor(p: Project) {
  const c = new THREE.Color(p.accent).lerp(new THREE.Color('#ff8a7a'), 0.22)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  return c.setHSL(hsl.h, Math.min(0.9, Math.max(0.55, hsl.s)), Math.min(0.68, Math.max(0.5, hsl.l)))
}

interface Coral {
  geo: THREE.BufferGeometry
  tips: THREE.Vector3[]
  height: number
}

function branching(p: Project, rnd: () => number): Coral {
  const parts: THREE.BufferGeometry[] = []
  const tips: THREE.Vector3[] = []
  const base = coralColor(p)
  let height = 0
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
    const to = from.clone().addScaledVector(dir, len)
    const g = new THREE.CylinderGeometry(rad * 0.72, rad, len, 6, 1)
    g.translate(0, len / 2, 0)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir))
    g.translate(from.x, from.y, from.z)
    parts.push(paint(g, base.clone().offsetHSL(0, 0, (3 - depth) * 0.05)))
    height = Math.max(height, to.y)
    if (depth === 0) {
      tips.push(to)
      return
    }
    const kids = depth >= 2 && rnd() < 0.5 ? 3 : 2
    for (let k = 0; k < kids; k++) {
      const a = rnd() * Math.PI * 2
      const d = dir
        .clone()
        .applyAxisAngle(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.35 + rnd() * 0.35)
        .lerp(UP, 0.25)
        .normalize()
      grow(to, d, len * (0.72 + rnd() * 0.1), rad * 0.72, depth - 1)
    }
  }
  const roots = 3 + Math.min(5, Math.floor(p.pages.length / 2))
  for (let r = 0; r < roots; r++) {
    const a = (r / roots) * Math.PI * 2 + rnd()
    grow(new THREE.Vector3(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15), new THREE.Vector3(Math.cos(a) * 0.45, 1, Math.sin(a) * 0.45).normalize(), 0.6 + rnd() * 0.2, 0.1, 3)
  }
  const geo = mergeGeometries(parts)!
  parts.forEach((g) => g.dispose())
  return { geo, tips, height }
}

function brain(p: Project, rnd: () => number): Coral {
  const R = 0.8 + Math.min(0.6, p.commitsWeek / 40)
  const g = new THREE.SphereGeometry(1, 56, 24, 0, Math.PI * 2, 0, Math.PI / 2)
  const pos = g.attributes.position
  const v = new THREE.Vector3()
  const col = new Float32Array(pos.count * 3)
  const base = coralColor(p)
  const c = new THREE.Color()
  const f = 7 + rnd() * 3
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // meandering grooves
    const groove = Math.sin(f * v.x + 2.2 * Math.sin(f * 0.9 * v.z)) * Math.cos(f * v.z + 1.7 * Math.sin(f * 0.8 * v.x))
    v.multiplyScalar(1 + groove * 0.035)
    pos.setXYZ(i, v.x * R, v.y * R * 0.72, v.z * R)
    c.copy(base).offsetHSL(0, 0, groove * 0.07)
    col.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.computeVertexNormals()
  const tips: THREE.Vector3[] = []
  for (let i = 0; i < 16; i++) {
    const th = rnd() * Math.PI * 2
    const ph = 0.15 + rnd() * 1.2
    tips.push(new THREE.Vector3(Math.sin(ph) * Math.cos(th) * R, Math.cos(ph) * R * 0.72, Math.sin(ph) * Math.sin(th) * R))
  }
  return { geo: g, tips, height: R * 0.72 }
}

function tubes(p: Project, rnd: () => number): Coral {
  const act = p.activity.length ? p.activity : [1]
  const max = Math.max(1, ...act)
  const parts: THREE.BufferGeometry[] = []
  const tips: THREE.Vector3[] = []
  const base = coralColor(p)
  let height = 0
  act.forEach((v, i) => {
    const r = 0.2 * Math.sqrt(i + 0.5)
    const a = i * 2.39996
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const h = 0.35 + (v / max) * 1.5
    const rad = 0.075 + rnd() * 0.035
    const wall = new THREE.CylinderGeometry(rad, rad * 1.2, h, 10, 1, true)
    wall.translate(x, h / 2, z)
    const lip = new THREE.TorusGeometry(rad, rad * 0.25, 6, 12)
    lip.rotateX(Math.PI / 2)
    lip.translate(x, h, z)
    parts.push(paint(wall, base.clone().offsetHSL(0, 0, -0.05 + (v / max) * 0.08)), paint(lip, base.clone().offsetHSL(0, 0.05, 0.12)))
    tips.push(new THREE.Vector3(x, h - 0.03, z))
    height = Math.max(height, h)
  })
  const geo = mergeGeometries(parts)!
  parts.forEach((g) => g.dispose())
  return { geo, tips, height }
}

function grow(p: Project, kind: CoralKind): Coral {
  const rnd = rng(`${p.id}:coral`)
  return kind === 'branching' ? branching(p, rnd) : kind === 'brain' ? brain(p, rnd) : tubes(p, rnd)
}

/** Lit coral that can bleach (to bone white) and silt up (darken), driven by uniforms. */
function coralMaterial(tier: Tier) {
  const u = { uBleach: { value: 0 }, uMurk: { value: 0 } }
  const m = tier === 'high' ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }) : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.fragmentShader = `uniform float uBleach; uniform float uMurk;\n${sh.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.84, 0.78), uBleach) * (1.0 - 0.55 * uMurk);',
    )}`
  }
  return { m, u }
}

// --- shared critters and props --------------------------------------------------------------------

function vc(g: THREE.BufferGeometry, color: string, pos: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], rot: [number, number, number] = [0, 0, 0]) {
  g.scale(...scale)
  g.rotateX(rot[0])
  g.rotateY(rot[1])
  g.rotateZ(rot[2])
  g.translate(...pos)
  return paint(g, new THREE.Color(color))
}

let props: { rock: THREE.BufferGeometry; crab: THREE.BufferGeometry; urchin: THREE.BufferGeometry; fish: THREE.BufferGeometry; shell: THREE.BufferGeometry; sub: THREE.BufferGeometry } | null = null

function sharedProps() {
  if (props) return props
  // a lumpy rock for each colony to grow on
  const rock = new THREE.DodecahedronGeometry(1, 2)
  const rp = rock.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < rp.count; i++) {
    v.fromBufferAttribute(rp, i)
    v.multiplyScalar(1 + Math.sin(v.x * 5.1) * 0.08 + Math.cos(v.z * 4.3 + v.y * 3) * 0.08)
    rp.setXYZ(i, v.x, v.y, v.z)
  }
  rock.computeVertexNormals()
  const crabParts = [
    vc(new THREE.SphereGeometry(0.16, 12, 8), '#e2553f', [0, 0.1, 0], [1.3, 0.55, 1]),
    vc(new THREE.SphereGeometry(0.07, 8, 6), '#f06a50', [0.2, 0.12, 0.14], [1.3, 0.8, 1]),
    vc(new THREE.SphereGeometry(0.07, 8, 6), '#f06a50', [-0.2, 0.12, 0.14], [1.3, 0.8, 1]),
    vc(new THREE.SphereGeometry(0.025, 6, 4), '#111111', [0.05, 0.2, 0.12]),
    vc(new THREE.SphereGeometry(0.025, 6, 4), '#111111', [-0.05, 0.2, 0.12]),
    ...[-1, 1].flatMap((sx) => [0, 1, 2].map((k) => vc(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 4), '#c9452f', [sx * 0.2, 0.06, -0.06 + k * 0.07], [1, 1, 1], [0, 0, sx * 1.1]))),
  ]
  const crab = mergeGeometries(crabParts)!
  const spikes: THREE.BufferGeometry[] = [vc(new THREE.IcosahedronGeometry(0.13, 1), '#3b1f4a')]
  const ico = new THREE.IcosahedronGeometry(1, 1).attributes.position
  for (let i = 0; i < ico.count; i += 3) {
    v.fromBufferAttribute(ico, i).normalize()
    if (v.y < -0.3) continue
    const g = new THREE.ConeGeometry(0.018, 0.28, 4)
    g.translate(0, 0.14, 0)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, v))
    g.translate(v.x * 0.1, v.y * 0.1, v.z * 0.1)
    spikes.push(paint(g, new THREE.Color('#2a1238')))
  }
  const urchin = mergeGeometries(spikes)!
  urchin.translate(0, 0.1, 0)
  // a little fish, nose along +x
  const fish = mergeGeometries([
    vc(new THREE.SphereGeometry(0.5, 10, 8), '#ffffff', [0, 0, 0], [1, 0.42, 0.2]),
    vc(new THREE.ConeGeometry(0.22, 0.32, 4), '#ffffff', [-0.6, 0, 0], [1, 1, 0.25], [0, 0, Math.PI / 2]),
  ])!
  fish.scale(0.32, 0.32, 0.32)
  // clam shell half, hinge at the back
  const shell = new THREE.SphereGeometry(0.2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  shell.scale(1, 0.35, 0.85)
  shell.translate(0, 0, 0.17)
  // Claude's submarine, nose along +z
  const sub = mergeGeometries([
    vc(new THREE.CapsuleGeometry(0.22, 0.55, 4, 14), CLAUDE, [0, 0, 0], [1, 1, 1], [Math.PI / 2, 0, 0]),
    vc(new THREE.BoxGeometry(0.16, 0.2, 0.26), '#b5573a', [0, 0.26, -0.02]),
    vc(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 6), '#3a2a28', [0.03, 0.42, 0.04]),
    vc(new THREE.BoxGeometry(0.4, 0.03, 0.12), '#b5573a', [0, 0, -0.38]),
    vc(new THREE.BoxGeometry(0.03, 0.26, 0.12), '#b5573a', [0, 0, -0.38]),
  ])!
  props = { rock, crab, urchin, fish, shell, sub }
  crabParts.forEach((g) => g.dispose())
  spikes.forEach((g) => g.dispose())
  return props
}

// --- shaders --------------------------------------------------------------------------------------

const fogVarying = /* glsl */ `varying float vFog;`
const fogVertex = /* glsl */ `vFog = 1.0 - exp(-pow(length(mv.xyz) * ${DENSITY.toFixed(3)}, 2.0));`

// fresnel glow for bubbles, the jellyfish and pearls; works on instanced meshes too
const shellVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV; ${fogVarying}
  void main(){
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mv = modelViewMatrix * p;
    vN = normalize(normalMatrix * n);
    vV = normalize(-mv.xyz);
    ${fogVertex}
    gl_Position = projectionMatrix * mv;
  }`
const shellFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; uniform float uCore;
  varying vec3 vN; varying vec3 vV; ${fogVarying}
  void main(){
    float f = 1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float a = (pow(f, 2.2) * 0.9 + uCore) * uAlpha * (1.0 - vFog * 0.85);
    gl_FragColor = vec4(uColor * a, a);
  }`

const quadVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

// sonar ring spreading through the water on events
const ringFrag = /* glsl */ `
  uniform float uK; uniform vec3 uColor; varying vec2 vUv;
  void main(){
    float r = length(vUv - 0.5) * 2.0;
    float w = 0.05;
    float a = (smoothstep(uK - w, uK, r) * (1.0 - smoothstep(uK, uK + w * 0.6, r))
             + 0.5 * smoothstep(uK * 0.7 - w, uK * 0.7, r) * (1.0 - smoothstep(uK * 0.7, uK * 0.7 + w * 0.5, r))) * (1.0 - uK);
    gl_FragColor = vec4(uColor * a * 1.5, a);
  }`

// the sub's headlight
const beamFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    float a = pow(vUv.y, 1.6) * uAlpha * 0.35;
    gl_FragColor = vec4(uColor * a, a);
  }`

// silt: a dark cloud hanging around a site that's down
const siltFrag = /* glsl */ `
  uniform float uAlpha; uniform float uTime; varying vec2 vUv;
  void main(){
    vec2 p = vUv - 0.5;
    float d = length(p * vec2(1.0, 1.4));
    float wob = 0.04 * sin(atan(p.y, p.x) * 5.0 + uTime * 0.6);
    float a = smoothstep(0.5 + wob, 0.1, d) * uAlpha * 0.75;
    gl_FragColor = vec4(vec3(0.03, 0.06, 0.06), a);
  }`

// --- one colony -----------------------------------------------------------------------------------

interface Kit {
  rock: THREE.BufferGeometry
  rockMat: THREE.Material
  crab: THREE.BufferGeometry
  urchin: THREE.BufferGeometry
  critterMat: THREE.Material
  fish: THREE.BufferGeometry
  fishMat: THREE.Material
  shell: THREE.BufferGeometry
  shellMat: THREE.Material
  sub: THREE.BufferGeometry
  subMat: THREE.Material
  bubble: THREE.SphereGeometry
}

const _o = new THREE.Object3D()
const _c = new THREE.Color()

function Colony({ site, impulses, kit, tier }: { site: Site; impulses: Impulses; kit: Kit; tier: Tier }) {
  const { project: p } = site
  const id = p.id
  const sig = signals(p)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const coral = useMemo(() => grow(p, site.kind), [p.id, p.accent, site.kind, p.pages.length, p.commitsWeek, p.activity.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => coral.geo.dispose(), [coral])
  const cm = useMemo(() => coralMaterial(tier), [tier])
  useEffect(() => () => cm.m.dispose(), [cm])
  const glowCol = useMemo(() => new THREE.Color(p.accent).lerp(new THREE.Color('#ffffff'), 0.45), [p.accent])

  const mats = useMemo(
    () => ({
      polyp: new THREE.MeshBasicMaterial({ toneMapped: false }),
      bubble: new THREE.ShaderMaterial({ vertexShader: shellVert, fragmentShader: shellFrag, uniforms: { uColor: { value: new THREE.Color('#c8f6ff') }, uAlpha: { value: 1 }, uCore: { value: 0.05 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      jelly: new THREE.ShaderMaterial({ vertexShader: shellVert, fragmentShader: shellFrag, uniforms: { uColor: { value: new THREE.Color('#7dffe8') }, uAlpha: { value: 1.4 }, uCore: { value: 0.15 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      pearl: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4fb').multiplyScalar(1.6), toneMapped: false }),
      ring: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: ringFrag, uniforms: { uK: { value: 1 }, uColor: { value: new THREE.Color('#fff') } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      beam: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: beamFrag, uniforms: { uColor: { value: new THREE.Color('#fff2c4') }, uAlpha: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      silt: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: siltFrag, uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false }),
      school: new THREE.MeshLambertMaterial({ color: '#d8fff0', emissive: '#2f9c7c' }),
    }),
    [],
  )
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])

  const tips = useRef<THREE.InstancedMesh>(null!)
  const bubbles = useRef<THREE.InstancedMesh>(null!)
  const school = useRef<THREE.InstancedMesh>(null!)
  const ring = useRef<THREE.Mesh>(null!)
  const sub = useRef<THREE.Group>(null!)
  const prop = useRef<THREE.Mesh>(null!)
  const jelly = useRef<THREE.Group>(null!)
  const bell = useRef<THREE.Mesh>(null!)
  const silt = useRef<THREE.Mesh>(null!)
  const critters = useRef<THREE.Group>(null!)
  const clams = useRef<THREE.Group>(null!)
  const h = coral.height + 0.35

  useLayoutEffect(() => {
    coral.tips.forEach((tp, i) => {
      _o.position.set(tp.x, tp.y + 0.35, tp.z)
      _o.scale.setScalar(1)
      _o.updateMatrix()
      tips.current.setMatrixAt(i, _o.matrix)
    })
    tips.current.count = coral.tips.length
    tips.current.instanceMatrix.needsUpdate = true
  }, [coral])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const tt = prefersReducedMotion ? 0 : t
    const app = useApp.getState()
    const active = app.hoveredId === id || app.selectedId === id

    // bleaching when broken, silt when the site is down
    cm.u.uBleach.value = damp(cm.u.uBleach.value, sig.broken ? 1 : sig.down ? 0.75 : 0, 0.8, dt)
    cm.u.uMurk.value = damp(cm.u.uMurk.value, sig.down ? 1 : 0, 0.8, dt)
    mats.silt.uniforms.uAlpha.value = cm.u.uMurk.value
    mats.silt.uniforms.uTime.value = t
    silt.current.visible = cm.u.uMurk.value > 0.02
    if (silt.current.visible) silt.current.quaternion.copy(s.camera.quaternion)

    // polyps glow softly; they go dark as the coral bleaches
    const life = 1 - cm.u.uBleach.value
    _c.copy(glowCol).multiplyScalar((1.1 + 0.35 * Math.sin(tt * 1.3 + site.index)) * life * (active ? 1.5 : 1) + 0.08)
    mats.polyp.color.copy(_c)

    // sonar ring on any event
    const k = since(impulses, id, t) / 2.6
    ring.current.visible = k < 1
    if (k < 1) {
      mats.ring.uniforms.uK.value = k
      mats.ring.uniforms.uColor.value.set(LEVEL[impulses.get(id)!.level])
    }

    // bubbles while it builds
    bubbles.current.visible = sig.building
    if (sig.building) {
      for (let i = 0; i < 18; i++) {
        const u = (tt * 0.32 + i * 0.137) % 1
        const a = i * 2.4
        _o.position.set(Math.cos(a) * 0.35 + Math.sin(tt * 2 + i) * 0.06 * u * 4, h * 0.5 + u * 5, Math.sin(a) * 0.35 + Math.cos(tt * 1.7 + i) * 0.06 * u * 4)
        _o.scale.setScalar((0.05 + (i % 4) * 0.02) * (0.6 + u * 0.8) * (u < 0.9 ? 1 : (1 - u) * 10))
        _o.updateMatrix()
        bubbles.current.setMatrixAt(i, _o.matrix)
      }
      _o.scale.setScalar(1)
      bubbles.current.instanceMatrix.needsUpdate = true
    }

    // a school of fish spiralling up and away while it deploys
    school.current.visible = sig.deploying
    if (sig.deploying) {
      for (let i = 0; i < 16; i++) {
        const u = (tt * 0.12 + i * 0.0625) % 1
        const a = tt * 1.3 + i * 0.39
        const r = 0.6 + (i % 3) * 0.22 + u * 0.5
        _o.position.set(Math.cos(a) * r, h * 0.6 + u * 6, Math.sin(a) * r)
        // nose along the spiral, tipped up as they climb
        _o.rotation.set(0, -a - Math.PI / 2, 0.35)
        _o.scale.setScalar(1.25 * (u < 0.85 ? 1 : (1 - u) / 0.15))
        _o.updateMatrix()
        school.current.setMatrixAt(i, _o.matrix)
      }
      school.current.instanceMatrix.needsUpdate = true
      _o.rotation.set(0, 0, 0)
    }

    // Claude's submarine circles with its headlight on the colony
    sub.current.visible = sig.claude
    if (sig.claude) {
      const a = tt * 0.22 + site.index
      const r = 1.75
      sub.current.position.set(Math.cos(a) * r, h + 0.45 + Math.sin(tt * 0.8) * 0.12, Math.sin(a) * r)
      // lookAt works in world space: aim the nose (and headlight) at the colony's middle
      const home = sub.current.parent!.position
      sub.current.lookAt(home.x, home.y + h * 0.5, home.z)
      prop.current.rotation.z = tt * 9
    }

    // a glowing jellyfish drifts above for a while after a deploy lands
    jelly.current.visible = sig.fresh
    if (sig.fresh) {
      const pulse = Math.sin(tt * 2.2)
      jelly.current.position.set(Math.sin(tt * 0.3) * 0.4, h + 1.2 + Math.sin(tt * 0.5) * 0.25 + Math.max(0, pulse) * 0.05, Math.cos(tt * 0.27) * 0.4)
      bell.current.scale.set(1 + pulse * 0.08, 1 - pulse * 0.1, 1 + pulse * 0.08)
    }

    // crabs scuttle side to side
    critters.current.children.forEach((c, i) => {
      if (c.userData.crab) c.position.x = c.userData.x + Math.sin(tt * 1.4 + i * 2) * 0.18
    })
    // clams breathe open and shut
    clams.current.children.forEach((c, i) => {
      const lid = c.children[1]
      if (lid) lid.rotation.x = -0.25 - 0.3 * (0.5 + 0.5 * Math.sin(tt * 0.7 + i * 1.9))
    })
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 6) return
    select(useApp.getState().selectedId === id ? null : id)
  }

  const rnd = useMemo(() => rng(`${id}:props`), [id])
  const nIssues = Math.min(6, sig.issues)
  const critterSpots = useMemo(() => Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * Math.PI * 2 + rnd() * 0.5, r: 1.35 + rnd() * 0.35 })), [rnd])
  const pearls = Math.min(3, sig.prs)

  return (
    <group position={[site.x, site.y, site.z]}>
      <group
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
        <mesh geometry={kit.rock} material={kit.rockMat} position={[0, -0.05, 0]} scale={[1.35, 0.5, 1.35]} rotation={[0, site.index, 0]} />
        <mesh geometry={coral.geo} material={cm.m} position={[0, 0.35, 0]} />
        <instancedMesh ref={tips} args={[undefined, mats.polyp, Math.max(1, coral.tips.length)]} key={coral.tips.length} raycast={noRay}>
          <sphereGeometry args={[0.055, 8, 6]} />
        </instancedMesh>
      </group>

      <instancedMesh ref={bubbles} args={[kit.bubble, mats.bubble, 18]} visible={false} frustumCulled={false} raycast={noRay} />
      <instancedMesh ref={school} args={[kit.fish, mats.school, 16]} visible={false} frustumCulled={false} raycast={noRay} />

      <mesh ref={ring} material={mats.ring} position={[0, h * 0.5, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[8, 8, 1]} visible={false} raycast={noRay}>
        <planeGeometry />
      </mesh>

      <mesh ref={silt} material={mats.silt} position={[0, h * 0.6, 0]} scale={[5, 5, 1]} visible={false} raycast={noRay}>
        <planeGeometry />
      </mesh>

      {/* Claude's sub: body, propeller, porthole and a headlight cone toward the coral */}
      <group ref={sub} visible={false} scale={0.8}>
        <mesh geometry={kit.sub} material={kit.subMat} raycast={noRay} />
        <mesh ref={prop} position={[0, 0, -0.47]} raycast={noRay}>
          <boxGeometry args={[0.3, 0.05, 0.02]} />
          <meshLambertMaterial color="#3a2a28" />
        </mesh>
        <mesh position={[0.2, 0.04, 0.1]} rotation={[0, Math.PI / 2, 0]} raycast={noRay}>
          <circleGeometry args={[0.06, 16]} />
          <meshBasicMaterial color={new THREE.Color('#ffe9a8').multiplyScalar(1.6)} toneMapped={false} />
        </mesh>
        <mesh material={mats.beam} position={[0, 0, 1.25]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRay}>
          <coneGeometry args={[0.55, 1.9, 20, 1, true]} />
        </mesh>
      </group>

      {/* jellyfish after a fresh deploy */}
      <group ref={jelly} visible={false}>
        <mesh ref={bell} material={mats.jelly} raycast={noRay}>
          <sphereGeometry args={[0.32, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i} material={mats.jelly} position={[Math.cos(i) * 0.16, -0.32, Math.sin(i) * 0.16]} raycast={noRay}>
            <cylinderGeometry args={[0.012, 0.004, 0.62, 4, 1, true]} />
          </mesh>
        ))}
      </group>

      {/* issues: urchins for bugs, crabs for everything else */}
      <group ref={critters}>
        {Array.from({ length: nIssues }, (_, i) => {
          const spot = critterSpots[i]
          const bug = i < sig.bugs
          const x = Math.cos(spot.a) * spot.r
          const z = Math.sin(spot.a) * spot.r
          const y = seabed(site.x + x, site.z + z) - site.y
          return (
            <group key={i} position={[x, y, z]} rotation={[0, -spot.a + Math.PI / 2, 0]} userData={{ crab: !bug, x }}>
              <mesh geometry={bug ? kit.urchin : kit.crab} material={kit.critterMat} raycast={noRay} />
            </group>
          )
        })}
      </group>

      {/* pull requests: clams with glowing pearls */}
      <group ref={clams}>
        {Array.from({ length: pearls }, (_, i) => {
          const a = Math.PI * 0.25 + i * 0.7 + site.index
          const x = Math.cos(a) * 1.05
          const z = Math.sin(a) * 1.05
          return (
            <group key={i} position={[x, seabed(site.x + x, site.z + z) - site.y + 0.03, z]} rotation={[0, -a + Math.PI / 2, 0]} scale={1.5}>
              <mesh geometry={kit.shell} material={kit.shellMat} rotation={[Math.PI, Math.PI, 0]} raycast={noRay} />
              <group>
                <mesh geometry={kit.shell} material={kit.shellMat} raycast={noRay} />
              </group>
              <mesh material={mats.pearl} position={[0, 0.04, 0.16]} raycast={noRay}>
                <sphereGeometry args={[0.05, 10, 8]} />
              </mesh>
            </group>
          )
        })}
      </group>

      <Anchor id={`lbl-rf-${id}`} position={[0, h + 0.75, 0]} />
    </group>
  )
}

// --- the rest of the reef -------------------------------------------------------------------------

function fishMaterial(time: { value: number }) {
  const m = new THREE.MeshLambertMaterial()
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time
    sh.vertexShader = `uniform float uTime;\n${sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float ph = float(gl_InstanceID) * 1.37;
      transformed.z += sin(uTime * 9.0 + ph - transformed.x * 16.0) * 0.035 * smoothstep(0.1, -0.3, transformed.x);`,
    )}`
  }
  return m
}

const SCHOOLS = [
  { n: 26, r: 0.78, y: 3.0, speed: 0.16, size: 1, colors: ['#ffd23f', '#3fa7ff', '#ffe98a'] },
  { n: 18, r: 0.5, y: 1.9, speed: -0.22, size: 0.85, colors: ['#ff8a3d', '#ffffff', '#ff6a2b'] },
  { n: 12, r: 1.15, y: 4.4, speed: 0.1, size: 1.5, colors: ['#b8d4e0', '#93b5c6', '#d6eef5'] },
]

function Fish({ radius, kit }: { radius: number; kit: Kit }) {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const total = SCHOOLS.reduce((a, s) => a + s.n, 0)
  const fish = useMemo(() => {
    const rnd = rng('fish')
    return SCHOOLS.flatMap((s, si) => Array.from({ length: s.n }, () => ({ si, off: (rnd() - 0.5) * 0.7, dr: (rnd() - 0.5) * 1.6, dy: (rnd() - 0.5) * 0.9, ph: rnd() * 10, size: s.size * (0.8 + rnd() * 0.4), color: s.colors[Math.floor(rnd() * s.colors.length)] })))
  }, [])
  // setColorAt creates the colour buffer on first use
  useLayoutEffect(() => {
    fish.forEach((f, i) => mesh.current.setColorAt(i, _c.set(f.color)))
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
  }, [fish, kit])
  useFrame((s) => {
    const t = prefersReducedMotion ? 0 : s.clock.elapsedTime
    fish.forEach((f, i) => {
      const sc = SCHOOLS[f.si]
      const a = t * sc.speed + f.off + f.si * 2.1
      const r = radius * sc.r + f.dr + Math.sin(t * 0.4 + f.ph) * 0.4
      const y = sc.y + f.dy + Math.sin(t * 0.6 + f.ph) * 0.25
      const dir = Math.sign(sc.speed)
      _o.position.set(Math.cos(a) * r, y, Math.sin(a) * r)
      // face along the circle
      _o.rotation.set(0, -a - (dir > 0 ? Math.PI / 2 : -Math.PI / 2), Math.cos(t * 0.6 + f.ph) * 0.12)
      _o.scale.setScalar(f.size)
      _o.updateMatrix()
      mesh.current.setMatrixAt(i, _o.matrix)
    })
    _o.rotation.set(0, 0, 0)
    _o.scale.setScalar(1)
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[kit.fish, kit.fishMat, total]} frustumCulled={false} raycast={noRay} />
  )
}

const floorVert = /* glsl */ `
  varying vec3 vW; ${fogVarying}
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vec4 mv = viewMatrix * w;
    ${fogVertex}
    gl_Position = projectionMatrix * mv;
  }`
const floorFrag = /* glsl */ `
  uniform float uTime; uniform vec3 uFog; uniform float uRich; varying vec3 vW; ${fogVarying}
  ${SNOISE}
  void main(){
    vec2 p = vW.xz;
    float rip = sin(p.x * 2.6 + sin(p.y * 0.7) * 2.0) * 0.5 + 0.5;
    float n = snoise(vec3(p * 0.12, 0.0));
    vec3 sand = mix(vec3(0.30, 0.27, 0.18), vec3(0.46, 0.42, 0.29), clamp(rip * 0.35 + n * 0.3 + 0.4, 0.0, 1.0));
    // caustics: ridged noise makes a net of bright lines that drifts
    float c1 = 1.0 - abs(snoise(vec3(p * 0.42, uTime * 0.22)));
    float c = pow(c1, 9.0);
    if (uRich > 0.5) {
      float c2 = 1.0 - abs(snoise(vec3(p * 0.42 + 13.1, uTime * 0.19 + 4.0)));
      c = c * 0.7 + pow(c2, 9.0) * 0.6;
    }
    vec3 col = sand * vec3(0.42, 0.68, 0.72) + vec3(0.45, 0.8, 0.8) * c * 0.4;
    col = mix(col, uFog, vFog);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`

const skyVert = 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
const skyFrag = /* glsl */ `
  uniform vec3 uFog; uniform float uTime; varying vec3 vDir;
  void main(){
    float y = vDir.y;
    vec3 surf = vec3(0.07, 0.36, 0.42);
    vec3 deep = vec3(0.004, 0.03, 0.045);
    vec3 col = mix(uFog, surf, smoothstep(0.02, 0.9, y));
    col = mix(col, deep, smoothstep(0.0, -0.4, y));
    float s = pow(max(0.0, y), 7.0);
    col += vec3(0.2, 0.42, 0.42) * s * (0.85 + 0.15 * sin(uTime * 0.7 + vDir.x * 18.0));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`

// shafts of sunlight, turned to face the camera around their vertical axis
const rayVert = /* glsl */ `
  uniform vec3 uCam; varying vec2 vUv; varying float vId;
  void main(){
    vUv = uv;
    vId = float(gl_InstanceID);
    vec3 c = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float sx = length(instanceMatrix[0].xyz);
    float sy = length(instanceMatrix[1].xyz);
    vec3 to = normalize(vec3(uCam.x - c.x, 0.0, uCam.z - c.z));
    vec3 right = vec3(to.z, 0.0, -to.x);
    vec3 w = c + right * position.x * sx + vec3(0.0, position.y * sy, 0.0) + vec3(0.3, 0.0, 0.18) * position.y * sy;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`
const rayFrag = /* glsl */ `
  uniform float uTime; varying vec2 vUv; varying float vId;
  void main(){
    float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
    float flick = 0.6 + 0.4 * sin(uTime * 0.35 + vId * 2.1);
    float a = edge * smoothstep(0.0, 0.85, vUv.y) * flick * 0.1;
    gl_FragColor = vec4(vec3(0.7, 0.95, 1.0) * a, a);
  }`

const snowVert = /* glsl */ `
  uniform float uTime; uniform float uScale; attribute float aSeed; varying float vA;
  void main(){
    vec3 p = position;
    p.y = mod(p.y - uTime * (0.06 + aSeed * 0.08), 14.0) - 0.5;
    p.x += sin(uTime * 0.3 + aSeed * 20.0) * 0.4;
    p.z += cos(uTime * 0.25 + aSeed * 17.0) * 0.4;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = -mv.z;
    vA = (0.25 + 0.45 * aSeed) * exp(-d * 0.06);
    gl_PointSize = max(1.0, (0.035 + aSeed * 0.03) * uScale / d);
  }`
const snowFrag = /* glsl */ `
  varying float vA;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.1, d) * vA;
    gl_FragColor = vec4(vec3(0.8, 0.95, 1.0) * a, a);
  }`

const kelpVert = /* glsl */ `
  uniform float uTime; varying float vY; varying float vNear; ${fogVarying}
  void main(){
    vec3 p = position;
    float h = p.y;
    p.x *= 1.0 - 0.55 * h;
    float ph = float(gl_InstanceID) * 1.91;
    vec4 w = instanceMatrix * vec4(p, 1.0);
    w.x += sin(uTime * 0.7 + ph + h * 2.2) * 0.45 * h * h;
    w.z += cos(uTime * 0.55 + ph * 1.3 + h * 1.7) * 0.35 * h * h;
    vec4 mv = viewMatrix * w;
    vY = h;
    vNear = smoothstep(6.0, 13.0, length(mv.xyz));
    ${fogVertex}
    gl_Position = projectionMatrix * mv;
  }`
const kelpFrag = /* glsl */ `
  uniform vec3 uFog; varying float vY; varying float vNear; ${fogVarying}
  void main(){
    // dissolve strands that come close to the camera
    float dither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (vNear < dither) discard;
    vec3 col = mix(vec3(0.02, 0.09, 0.05), vec3(0.16, 0.36, 0.14), vY);
    col = mix(col, uFog, vFog);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`

function Environment({ radius, tier }: { radius: number; tier: Tier }) {
  const { camera } = useThree()
  const sky = useRef<THREE.Mesh>(null!)
  const time = useMemo(() => ({ value: 0 }), [])
  const floorGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(140, 140, tier === 'battery' ? 90 : 160, tier === 'battery' ? 90 : 160)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, seabed(pos.getX(i), pos.getZ(i)))
    g.computeVertexNormals()
    return g
  }, [tier])
  const mats = useMemo(
    () => ({
      floor: new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: { uTime: time, uFog: { value: FOG }, uRich: { value: tier === 'battery' ? 0 : 1 } } }),
      sky: new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: { uTime: time, uFog: { value: FOG } }, side: THREE.BackSide, depthWrite: false }),
      ray: new THREE.ShaderMaterial({ vertexShader: rayVert, fragmentShader: rayFrag, uniforms: { uTime: time, uCam: { value: new THREE.Vector3() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      snow: new THREE.ShaderMaterial({ vertexShader: snowVert, fragmentShader: snowFrag, uniforms: { uTime: time, uScale: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      kelp: new THREE.ShaderMaterial({ vertexShader: kelpVert, fragmentShader: kelpFrag, uniforms: { uTime: time, uFog: { value: FOG } }, side: THREE.DoubleSide }),
    }),
    [time, tier],
  )
  useEffect(() => () => (Object.values(mats).forEach((m) => m.dispose()), floorGeo.dispose()), [mats, floorGeo])

  const snow = useMemo(() => {
    const n = tier === 'battery' ? 200 : 420
    const rnd = rng('snow')
    const pos = new Float32Array(n * 3)
    const seed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      pos.set([(rnd() - 0.5) * 44, rnd() * 14, (rnd() - 0.5) * 44], i * 3)
      seed[i] = rnd()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    return g
  }, [tier])
  useEffect(() => () => snow.dispose(), [snow])

  const rays = useRef<THREE.InstancedMesh>(null!)
  const kelp = useRef<THREE.InstancedMesh>(null!)
  const kelpCount = 46
  const rayCount = 8
  useLayoutEffect(() => {
    const rnd = rng('kelp')
    for (let i = 0; i < kelpCount; i++) {
      const a = rnd() * Math.PI * 2
      const r = radius + 1.5 + rnd() * 7
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      _o.position.set(x, seabed(x, z) - 0.1, z)
      _o.rotation.set(0, rnd() * Math.PI, 0)
      _o.scale.set(0.9 + rnd() * 0.5, 3 + rnd() * 4.5, 1)
      _o.updateMatrix()
      kelp.current.setMatrixAt(i, _o.matrix)
    }
    kelp.current.instanceMatrix.needsUpdate = true
    for (let i = 0; i < rayCount; i++) {
      const a = (i / rayCount) * Math.PI * 2 + rnd()
      const r = rnd() * radius * 0.9
      _o.position.set(Math.cos(a) * r - 3, -1, Math.sin(a) * r - 2)
      _o.rotation.set(0, 0, 0)
      _o.scale.set(1.6 + rnd() * 2.8, 20, 1)
      _o.updateMatrix()
      rays.current.setMatrixAt(i, _o.matrix)
    }
    rays.current.instanceMatrix.needsUpdate = true
    _o.scale.set(1, 1, 1)
  }, [radius])

  const kelpGeo = useMemo(() => new THREE.PlaneGeometry(0.34, 1, 1, 12).translate(0, 0.5, 0), [])
  const rayGeo = useMemo(() => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), [])
  useEffect(() => () => (kelpGeo.dispose(), rayGeo.dispose()), [kelpGeo, rayGeo])

  useFrame((s) => {
    time.value = prefersReducedMotion ? 0 : s.clock.elapsedTime
    sky.current.position.copy(camera.position)
    mats.ray.uniforms.uCam.value.copy(camera.position)
    const cam = camera as THREE.PerspectiveCamera
    mats.snow.uniforms.uScale.value = (s.size.height * s.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360))
  })

  return (
    <>
      <mesh ref={sky} material={mats.sky} renderOrder={-1} raycast={noRay}>
        <sphereGeometry args={[90, 32, 16]} />
      </mesh>
      <mesh geometry={floorGeo} material={mats.floor} raycast={noRay} />
      <instancedMesh ref={kelp} args={[kelpGeo, mats.kelp, kelpCount]} frustumCulled={false} raycast={noRay} />
      <instancedMesh ref={rays} args={[rayGeo, mats.ray, rayCount]} frustumCulled={false} raycast={noRay} />
      <points geometry={snow} material={mats.snow} frustumCulled={false} />
    </>
  )
}

// --- plankton bloom when something ships ----------------------------------------------------------

const BLOOM = 700
const bloomVert = /* glsl */ `
  attribute float aLife; uniform float uScale; varying float vA;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = clamp(aLife, 0.0, 1.0);
    gl_PointSize = aLife > 0.0 ? (0.04 + 0.05 * vA) * uScale / -mv.z : 0.0;
  }`
const bloomFrag = /* glsl */ `
  varying float vA;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * sin(vA * 3.14159);
    gl_FragColor = vec4(vec3(0.45, 1.0, 0.85) * a * 1.8, a);
  }`

export interface BloomApi {
  burst: (x: number, y: number, z: number) => void
}

function Plankton({ api }: { api: MutableRefObject<BloomApi | null> }) {
  const sys = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(BLOOM * 3)
    const life = new Float32Array(BLOOM)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage))
    const mat = new THREE.ShaderMaterial({ vertexShader: bloomVert, fragmentShader: bloomFrag, uniforms: { uScale: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    return { geo, mat, pos, life, vel: new Float32Array(BLOOM * 3), left: new Float32Array(BLOOM), span: new Float32Array(BLOOM).fill(1), next: 0, live: 0 }
  }, [])
  useEffect(() => () => (sys.geo.dispose(), sys.mat.dispose()), [sys])
  useEffect(() => {
    api.current = {
      burst: (x, y, z) => {
        if (prefersReducedMotion) return
        for (let i = 0; i < 160; i++) {
          const p = sys.next
          sys.next = (sys.next + 1) % BLOOM
          const a = Math.random() * Math.PI * 2
          const r = Math.random() * 0.8
          sys.pos.set([x + Math.cos(a) * r, y + Math.random() * 1.5, z + Math.sin(a) * r], p * 3)
          const sp = 0.3 + Math.random() * 0.6
          sys.vel.set([Math.cos(a) * sp, 0.2 + Math.random() * 0.5, Math.sin(a) * sp], p * 3)
          sys.span[p] = sys.left[p] = 2.8 + Math.random() * 2
        }
        sys.live = 6
      },
    }
    return () => {
      api.current = null
    }
  }, [api, sys])
  useFrame((s, dt) => {
    const cam = s.camera as THREE.PerspectiveCamera
    sys.mat.uniforms.uScale.value = (s.size.height * s.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360))
    if (sys.live <= 0) return
    sys.live -= dt
    for (let i = 0; i < BLOOM; i++) {
      if (sys.left[i] <= 0) {
        sys.life[i] = 0
        continue
      }
      sys.left[i] -= dt
      const k = 1 - 0.7 * dt
      sys.vel[i * 3] *= k
      sys.vel[i * 3 + 1] *= k
      sys.vel[i * 3 + 2] *= k
      sys.pos[i * 3] += sys.vel[i * 3] * dt
      sys.pos[i * 3 + 1] += sys.vel[i * 3 + 1] * dt
      sys.pos[i * 3 + 2] += sys.vel[i * 3 + 2] * dt
      sys.life[i] = Math.max(0, sys.left[i] / sys.span[i])
    }
    sys.geo.attributes.position.needsUpdate = true
    sys.geo.attributes.aLife.needsUpdate = true
  })
  return <points geometry={sys.geo} material={sys.mat} frustumCulled={false} />
}

// --- camera ---------------------------------------------------------------------------------------

function Rig({ sites, radius }: { sites: Site[]; radius: number }) {
  const { camera, gl, size } = useThree()
  const az = useRef(0.5)
  const azGoal = useRef(0.5)
  const dist = useRef(radius * 3.2)
  const zoom = useRef(1)
  const offset = useRef(0)
  const target = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])
  const sitesRef = useRef(sites)
  sitesRef.current = sites

  useEffect(() => {
    const el = gl.domElement
    let drag: number | null = null
    const down = (e: PointerEvent) => (drag = e.clientX)
    const move = (e: PointerEvent) => {
      if (drag === null) return
      azGoal.current -= (e.clientX - drag) * 0.005
      drag = e.clientX
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoom.current = THREE.MathUtils.clamp(zoom.current * (1 + e.deltaY * 0.001), 0.45, 1.4)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    // swim round to the outside of a colony when it's picked
    const un = useApp.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return
      const site = sitesRef.current.find((x) => x.project.id === s.selectedId)
      if (site && Math.hypot(site.x, site.z) > 0.5) {
        const want = Math.atan2(site.x, site.z)
        azGoal.current += Math.atan2(Math.sin(want - azGoal.current), Math.cos(want - azGoal.current))
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
    const sel = sites.find((x) => x.project.id === useApp.getState().selectedId)
    if (!sel && !prefersReducedMotion && !useApp.getState().hoveredId) azGoal.current += dt * 0.025
    az.current = damp(az.current, azGoal.current, 2.2, dt)
    const board = size.width > 900 ? Math.min(320, size.width * 0.22) : 0
    const aspect = (size.width - board) / size.height
    const fit = radius * (aspect < 1.3 ? 2.4 : 1.95)
    const intro = 1 - Math.pow(1 - Math.min(1, s.clock.elapsedTime / 2.6), 3)
    dist.current = damp(dist.current, (sel ? 9.5 : fit) * zoom.current + (1 - intro) * 12, 2.2, dt)
    if (sel) target.set(sel.x, sel.y + 1.1, sel.z)
    else target.set(0, 0.6, 0)
    look.lerp(target, 1 - Math.exp(-dt * 2.4))
    const elev = sel ? 0.4 : 0.5
    cam.position.set(look.x + Math.sin(az.current) * dist.current * Math.cos(elev), Math.max(look.y + dist.current * Math.sin(elev), seabed(cam.position.x, cam.position.z) + 0.6), look.z + Math.cos(az.current) * dist.current * Math.cos(elev))
    cam.lookAt(look)
    offset.current = damp(offset.current, sel ? Math.min(330, size.width * 0.2) : -board / 2, 3, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
  })
  return null
}

// --- the reef -------------------------------------------------------------------------------------

export function ReefScene({ tier }: { tier: Tier }) {
  const { sites, radius } = useSites()
  const bloom = useRef<BloomApi | null>(null)
  const sitesRef = useRef(sites)
  sitesRef.current = sites
  const onAny = useCallback((n: Note) => {
    if (n.level !== 'success') return
    const s = sitesRef.current.find((x) => x.project.id === n.projectId)
    if (s) bloom.current?.burst(s.x, s.y + 1.2, s.z)
  }, [])
  const impulses = useImpulses(onAny)
  const fishTime = useMemo(() => ({ value: 0 }), [])
  useFrame((s) => (fishTime.value = prefersReducedMotion ? 0 : s.clock.elapsedTime))

  const kit = useMemo<Kit>(() => {
    const g = sharedProps()
    const lit = (o: THREE.MeshLambertMaterialParameters) => (tier === 'high' ? new THREE.MeshStandardMaterial({ roughness: 0.8, ...(o as THREE.MeshStandardMaterialParameters) }) : new THREE.MeshLambertMaterial(o))
    return {
      rock: g.rock,
      rockMat: lit({ color: '#5d5a52' }),
      crab: g.crab,
      urchin: g.urchin,
      critterMat: new THREE.MeshLambertMaterial({ vertexColors: true }),
      fish: g.fish,
      fishMat: fishMaterial(fishTime),
      shell: g.shell,
      shellMat: lit({ color: '#c9b7a6', side: THREE.DoubleSide }),
      sub: g.sub,
      subMat: new THREE.MeshLambertMaterial({ vertexColors: true }),
      bubble: new THREE.SphereGeometry(1, 12, 8),
    }
  }, [tier, fishTime])
  useEffect(() => () => [kit.rockMat, kit.critterMat, kit.fishMat, kit.shellMat, kit.subMat, kit.bubble].forEach((x) => x.dispose()), [kit])

  return (
    <>
      <color attach="background" args={[FOG.getStyle()]} />
      <fogExp2 attach="fog" args={[FOG.getHex(), DENSITY]} />
      <hemisphereLight args={['#bff3ff', '#1f4a3c', 1.25]} />
      <directionalLight position={[4, 14, 3]} intensity={1.7} color="#d8fbff" />
      <Rig sites={sites} radius={radius} />
      <Environment radius={radius} tier={tier} />
      {sites.map((s) => (
        <Colony key={s.project.id} site={s} impulses={impulses} kit={kit} tier={tier} />
      ))}
      <Fish radius={radius} kit={kit} />
      <Plankton api={bloom} />
    </>
  )
}
