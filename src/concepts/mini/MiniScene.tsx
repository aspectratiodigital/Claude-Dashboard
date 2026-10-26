import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useData } from '../../data/store'
import { useApp } from '../../store'
import { useTier } from '../../shared/quality'
import { useImpulses } from '../../shared/pulse'
import { useBp } from '../blueprint/state'
import {
  addHome,
  addLink,
  canHome,
  canPlot,
  canRoundabout,
  colorOf,
  ends,
  erase,
  inside,
  moveHome,
  moveSite,
  setTree,
  setWater,
  tk,
  toggleRoundabout,
  topLayer,
  xz,
  type Index,
  type Layer,
  type MiniMap,
  type Tool,
} from './map'
import { centre, tileAt } from './drive'
import { indexFor, pullMini, settleMap, useMap, useMini } from './state'
import { House, Site } from './Buildings'
import { Cars } from './Cars'
import { BOX, MINI, ROOF, damp, hash, lambert, mix, noRay, slab } from './look'

// The Mini theme's scene: a top-down city after Mini Motorways. Roads are drawn
// as links between tiles, so they come out with round ends and smooth joins;
// the river is a soft-edged mask in the ground's own material, so buildings
// cast shadows on it like everything else.

/** Where the pointer is on the map, shared by the controls and the editing overlay without React renders. */
const pointer = { tile: null as string | null, x: 0, z: 0 }

// --- Ground: land, the river, and the world beyond the map ---------------------------------------

const PX = 4
const MARGIN = 24

function blur(a: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(a.length)
  const n = 2 * r + 1
  for (let z = 0; z < h; z++) {
    const row = z * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n
      acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let z = -r; z <= r; z++) acc += tmp[Math.min(h - 1, Math.max(0, z)) * w + x]
    for (let z = 0; z < h; z++) {
      a[z * w + x] = acc / n
      acc += tmp[Math.min(h - 1, z + r + 1) * w + x] - tmp[Math.max(0, z - r) * w + x]
    }
  }
}

/** Red: water, green: the map itself, both blurred so the shader can draw soft, rounded edges. */
function groundMask(m: MiniMap): THREE.DataTexture {
  const W = (m.cols + MARGIN * 2) * PX
  const H = (m.rows + MARGIN * 2) * PX
  const water = new Float32Array(W * H)
  const land = new Float32Array(W * H)
  const fill = (a: Float32Array, tx: number, tz: number) => {
    const x0 = (tx + MARGIN) * PX
    const z0 = (tz + MARGIN) * PX
    if (x0 < 0 || z0 < 0 || x0 + PX > W || z0 + PX > H) return
    for (let z = z0; z < z0 + PX; z++) a.fill(1, z * W + x0, z * W + x0 + PX)
  }
  for (let x = 0; x < m.cols; x++) for (let z = 0; z < m.rows; z++) fill(land, x, z)
  for (const k of m.water) {
    const [x, z] = xz(k)
    fill(water, x, z)
    // a river at the edge runs on off the map
    for (let i = 1; i <= MARGIN; i++) {
      if (z === 0) fill(water, x, -i)
      if (z === m.rows - 1) fill(water, x, z + i)
      if (x === 0) fill(water, -i, z)
      if (x === m.cols - 1) fill(water, x + i, z)
    }
  }
  blur(water, W, H, 3)
  blur(water, W, H, 3)
  blur(land, W, H, 2)
  blur(land, W, H, 2)
  const data = new Uint8Array(W * H * 4)
  // texture rows run from the south edge up
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++) {
      const i = z * W + x
      const o = ((H - 1 - z) * W + x) * 4
      data[o] = water[i] * 255
      data[o + 1] = land[i] * 255
      data[o + 3] = 255
    }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

function Ground({ map }: { map: MiniMap }) {
  const waterKey = map.water.join(';')
  const tex = useMemo(() => groundMask(map), [map.cols, map.rows, waterKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const mat = useMemo(() => {
    const m = new THREE.MeshLambertMaterial({ map: tex })
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uOut = { value: new THREE.Color(MINI.outside) }
      sh.uniforms.uLand = { value: new THREE.Color(MINI.ground) }
      sh.uniforms.uBank = { value: new THREE.Color(MINI.bank) }
      sh.uniforms.uWater = { value: new THREE.Color(MINI.water) }
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uOut; uniform vec3 uLand; uniform vec3 uBank; uniform vec3 uWater;').replace(
        '#include <map_fragment>',
        `vec4 mk = texture2D( map, vMapUv );
        vec3 col = mix( uOut, uLand, smoothstep( 0.42, 0.58, mk.g ) );
        vec3 wet = mix( uBank, uWater, smoothstep( 0.5, 0.62, mk.r ) );
        diffuseColor.rgb = mix( col, wet, smoothstep( 0.32, 0.42, mk.r ) );`,
      )
    }
    return m
  }, [tex])
  useEffect(
    () => () => {
      tex.dispose()
      mat.dispose()
    },
    [tex, mat],
  )
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} material={mat} receiveShadow raycast={noRay}>
      <planeGeometry args={[map.cols + MARGIN * 2, map.rows + MARGIN * 2]} />
    </mesh>
  )
}

function Lights({ cols, rows }: { cols: number; rows: number }) {
  const sun = useRef<THREE.DirectionalLight>(null!)
  const tier = useTier()
  useLayoutEffect(() => {
    const l = sun.current
    const s = Math.max(cols, rows) * 0.62 + 4
    const cam = l.shadow.camera
    cam.left = -s
    cam.right = s
    cam.top = s
    cam.bottom = -s
    cam.near = 1
    cam.far = 160
    cam.updateProjectionMatrix()
    const size = tier === 'high' ? 4096 : 2048
    if (l.shadow.mapSize.x !== size) {
      l.shadow.mapSize.set(size, size)
      l.shadow.map?.dispose()
      l.shadow.map = null
    }
  }, [cols, rows, tier])
  // light from the front left: tops and fronts stay bright, shadows fall away to the right
  return (
    <>
      <hemisphereLight args={['#ffffff', '#d9cfbf', 1.7]} />
      <directionalLight ref={sun} position={[-18, 30, 20]} intensity={2.2} castShadow shadow-bias={-0.0004} shadow-normalBias={0.03} shadow-radius={4} />
    </>
  )
}

// --- Roads, bridges and roundabouts ----------------------------------------------------------------

function disc(r: number, x: number, y: number, z: number) {
  return new THREE.CircleGeometry(r, 20).rotateX(-Math.PI / 2).translate(x, y, z)
}

function bar(ax: number, az: number, bx: number, bz: number, w: number, y: number) {
  return new THREE.PlaneGeometry(Math.hypot(bx - ax, bz - az), w)
    .rotateX(-Math.PI / 2)
    .rotateY(-Math.atan2(bz - az, bx - ax))
    .translate((ax + bx) / 2, y, (az + bz) / 2)
}

function block(ax: number, az: number, bx: number, bz: number, w: number, h: number, y: number, side = 0) {
  const len = Math.hypot(bx - ax, bz - az)
  const nx = -(bz - az) / len
  const nz = (bx - ax) / len
  return new THREE.BoxGeometry(len, h, w)
    .rotateY(-Math.atan2(bz - az, bx - ax))
    .translate((ax + bx) / 2 + nx * side, y, (az + bz) / 2 + nz * side)
}

const merged = (list: THREE.BufferGeometry[]) => {
  if (!list.length) return null
  const g = mergeGeometries(list)
  list.forEach((x) => x.dispose())
  return g
}

function Roads({ ix }: { ix: Index }) {
  const geo = useMemo(() => {
    const m = ix.map
    const kerb: THREE.BufferGeometry[] = []
    const top: THREE.BufferGeometry[] = []
    const deck: THREE.BufferGeometry[] = []
    const rail: THREE.BufferGeometry[] = []
    const isle: THREE.BufferGeometry[] = []
    const bush: THREE.BufferGeometry[] = []
    for (const t of ix.adj.keys()) {
      const [x, z] = tileAt(m, t)
      if (ix.water.has(t)) deck.push(new THREE.CylinderGeometry(0.31, 0.31, 0.07, 20).translate(x, 0.075, z))
      else {
        kerb.push(disc(0.35, x, 0.006, z))
        top.push(disc(0.29, x, 0.012, z))
      }
    }
    for (const l of m.roads) {
      const [a, b] = ends(l)
      const [ax, az] = tileAt(m, a)
      const [bx, bz] = tileAt(m, b)
      if (ix.water.has(a) || ix.water.has(b)) {
        // a bridge: a raised deck with a rail down each side
        deck.push(block(ax, az, bx, bz, 0.62, 0.07, 0.075))
        rail.push(block(ax, az, bx, bz, 0.05, 0.06, 0.14, 0.3), block(ax, az, bx, bz, 0.05, 0.06, 0.14, -0.3))
      } else {
        kerb.push(bar(ax, az, bx, bz, 0.7, 0.006))
        top.push(bar(ax, az, bx, bz, 0.58, 0.012))
      }
    }
    for (const t of ix.roundabouts) {
      if (!ix.adj.has(t) || ix.water.has(t)) continue
      const [x, z] = tileAt(m, t)
      kerb.push(disc(0.62, x, 0.007, z))
      top.push(disc(0.55, x, 0.013, z))
      isle.push(new THREE.CylinderGeometry(0.21, 0.23, 0.05, 24).translate(x, 0.035, z))
      bush.push(new THREE.IcosahedronGeometry(0.11, 1).translate(x, 0.12, z))
    }
    return { kerb: merged(kerb), top: merged(top), deck: merged(deck), rail: merged(rail), isle: merged(isle), bush: merged(bush) }
  }, [ix])
  useEffect(() => () => Object.values(geo).forEach((g) => g?.dispose()), [geo])
  return (
    <group>
      {geo.kerb && <mesh geometry={geo.kerb} material={lambert(MINI.kerb)} receiveShadow raycast={noRay} />}
      {geo.top && <mesh geometry={geo.top} material={lambert(MINI.road)} receiveShadow raycast={noRay} />}
      {geo.deck && <mesh geometry={geo.deck} material={lambert(MINI.bridge)} castShadow receiveShadow raycast={noRay} />}
      {geo.rail && <mesh geometry={geo.rail} material={lambert(MINI.rail)} castShadow raycast={noRay} />}
      {geo.isle && <mesh geometry={geo.isle} material={lambert(MINI.grass)} receiveShadow raycast={noRay} />}
      {geo.bush && <mesh geometry={geo.bush} material={lambert(MINI.trees[1])} castShadow raycast={noRay} />}
    </group>
  )
}

// --- Trees --------------------------------------------------------------------------------------

const TREE = new THREE.IcosahedronGeometry(0.27, 1)

function Trees({ map }: { map: MiniMap }) {
  const ref = useRef<THREE.InstancedMesh>(null!)
  const n = map.trees.length
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const o = new THREE.Object3D()
    const c = new THREE.Color()
    map.trees.forEach((k, i) => {
      const [x, z] = tileAt(map, k)
      const r = hash(k)
      const s = 0.8 + r * 0.45
      o.position.set(x + (hash(`${k}x`) - 0.5) * 0.22, 0.24 * s, z + (hash(`${k}z`) - 0.5) * 0.22)
      o.scale.set(s, s * 0.88, s)
      o.rotation.set(0, r * 6, 0)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
      mesh.setColorAt(i, c.set(MINI.trees[Math.floor(r * 3) % 3]))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [map.trees, map.cols, map.rows]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) return null
  return (
    <instancedMesh key={n} ref={ref} args={[TREE, undefined, n]} castShadow raycast={noRay}>
      <meshLambertMaterial flatShading />
    </instancedMesh>
  )
}

// --- Editing: the grid, the tile under the pointer, and a ghost of what you're placing ----------------

const gridVert = 'varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }'
const gridFrag = `varying vec2 vW; uniform vec2 uSize; uniform float uA;
  void main(){
    vec2 p = vW + uSize * .5;
    if (p.x < 0. || p.y < 0. || p.x > uSize.x || p.y > uSize.y) discard;
    vec2 g = abs(fract(p) - .5);
    vec2 fw = fwidth(p);
    vec2 l = smoothstep(vec2(.5) - fw * 1.2, vec2(.5), g);
    gl_FragColor = vec4(vec3(.42, .38, .32), max(l.x, l.y) * uA);
  }`
const tileFrag = `varying vec2 vUv; uniform vec3 uColor; uniform vec2 uSize; uniform float uA;
  void main(){
    vec2 p = (vUv - .5) * uSize;
    vec2 q = abs(p) - (uSize * .5 - .16);
    float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - .16;
    float aa = fwidth(d) * 1.2;
    float fill = 1. - smoothstep(-aa, 0., d);
    float edge = fill * smoothstep(-.07 - aa, -.07, d);
    gl_FragColor = vec4(uColor, (fill * .22 + edge * .75) * uA);
  }`
const tileVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }'

function okFor(tool: Tool, ix: Index, t: string): boolean {
  const [x, z] = xz(t)
  if (!inside(ix.map, x, z)) return false
  switch (tool) {
    case 'road':
      return true
    case 'roundabout':
      return canRoundabout(ix, t) || ix.roundabouts.has(t)
    case 'house':
      return canHome(ix, t)
    case 'tree':
      return ix.trees.has(t) || (!ix.occ.has(t) && !ix.adj.has(t) && !ix.water.has(t))
    case 'water':
      return !ix.occ.has(t)
    case 'erase':
      return topLayer(ix, t) !== null
    case 'move':
      return ix.occ.has(t)
    default:
      return false
  }
}

function EditLayer({ ixRef, map }: { ixRef: MutableRefObject<Index>; map: MiniMap }) {
  const tool = useMini((s) => s.tool)
  const carry = useMini((s) => s.carry)
  const brush = useMini((s) => s.brush)
  const selectedId = useApp((s) => s.selectedId)
  const editing = tool !== 'look'
  const grid = useMemo(() => new THREE.ShaderMaterial({ uniforms: { uSize: { value: new THREE.Vector2() }, uA: { value: 0 } }, vertexShader: gridVert, fragmentShader: gridFrag, transparent: true, depthWrite: false }), [])
  const cursor = useMemo(() => new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color() }, uSize: { value: new THREE.Vector2(1, 1) }, uA: { value: 0 } }, vertexShader: tileVert, fragmentShader: tileFrag, transparent: true, depthWrite: false }), [])
  const foot = useMemo(() => new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color() }, uSize: { value: new THREE.Vector2(1, 1) }, uA: { value: 1 } }, vertexShader: tileVert, fragmentShader: tileFrag, transparent: true, depthWrite: false }), [])
  useEffect(
    () => () => {
      grid.dispose()
      cursor.dispose()
      foot.dispose()
    },
    [grid, cursor, foot],
  )
  const cur = useRef<THREE.Mesh>(null!)
  const ghost = useRef<THREE.Group>(null!)

  useFrame((_, dt) => {
    const ix = ixRef.current
    grid.uniforms.uSize.value.set(ix.map.cols, ix.map.rows)
    grid.uniforms.uA.value = damp(grid.uniforms.uA.value, editing ? 0.16 : 0, 8, dt)
    const t = pointer.tile
    const st = useMini.getState()
    const show = editing && !!t && !st.carry
    cursor.uniforms.uA.value = damp(cursor.uniforms.uA.value, show ? 1 : 0, 14, dt)
    if (t) {
      const [x, z] = tileAt(ix.map, t)
      cur.current.position.set(x, 0.03, z)
      cursor.uniforms.uColor.value.set(okFor(st.tool, ix, t) ? MINI.ok : MINI.bad)
      ghost.current.position.set(x, 0, z)
      ghost.current.visible = st.tool === 'house' && show && canHome(ix, t)
    } else ghost.current.visible = false
  })

  const site = brush && map.sites[brush] ? brush : selectedId && map.sites[selectedId] ? selectedId : Object.keys(map.sites)[0]
  const color = colorOf(map.sites[site ?? '']?.color ?? 0)
  const plot = carry?.kind === 'site' ? map.sites[carry.id] : null
  if (carry) foot.uniforms.uColor.value.set(carry.ok ? MINI.ok : MINI.bad)
  if (plot) foot.uniforms.uSize.value.set(plot.w, plot.d)
  else foot.uniforms.uSize.value.set(1, 1)
  const [fx, fz] = carry ? centre(map, carry.x + (plot ? plot.w / 2 - 0.5 : 0), carry.z + (plot ? plot.d / 2 - 0.5 : 0)) : [0, 0]

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} material={grid} raycast={noRay} renderOrder={1}>
        <planeGeometry args={[map.cols, map.rows]} />
      </mesh>
      <mesh ref={cur} rotation={[-Math.PI / 2, 0, 0]} material={cursor} raycast={noRay} renderOrder={3}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      {carry && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[fx, 0.035, fz]} material={foot} raycast={noRay} renderOrder={3}>
          <planeGeometry args={[plot ? plot.w : 1, plot ? plot.d : 1]} />
        </mesh>
      )}
      {/* a see-through house where a new home would go */}
      <group ref={ghost} visible={false}>
        <mesh geometry={BOX} position={[-0.15, 0.16, 0]} scale={[0.36, 0.26, 0.44]} raycast={noRay}>
          <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <mesh geometry={ROOF} position={[-0.15, 0.29, 0]} raycast={noRay}>
          <meshBasicMaterial color={mix(color, '#000000', 0.2)} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <mesh geometry={slab(0.84, 0.84, 0.16, 0.03)} raycast={noRay}>
          <meshBasicMaterial color={mix(color, '#ffffff', 0.6)} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      </group>
    </group>
  )
}

// --- Camera and controls ---------------------------------------------------------------------------

/** Camera height for each unit out: about 67 degrees down, nearly top-down like the game. */
const RISE = 2.4
const SIN_EL = RISE / Math.hypot(1, RISE)

/** Tiles from a to b one step at a time (diagonal steps allowed), not counting a. */
function steps(a: string, b: string): string[] {
  const [x0, z0] = xz(a)
  const [x1, z1] = xz(b)
  const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0))
  const out: string[] = []
  for (let i = 1; i <= n; i++) out.push(tk(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(z0 + ((z1 - z0) * i) / n)))
  return out
}

type Gesture =
  | { kind: 'pan'; x: number; y: number; sx: number; sy: number; click?: () => void }
  | { kind: 'stroke'; tool: 'road' | 'tree' | 'water' | 'erase'; last: string | null; on: boolean; layer: Layer | null }
  | { kind: 'carry'; what: 'site' | 'home'; id: string; dx: number; dz: number; sx: number; sy: number; moved: boolean }

function Rig({ turn, ixRef, active, pick }: { turn: MutableRefObject<number>; ixRef: MutableRefObject<Index>; active: MutableRefObject<Set<string>>; pick: MutableRefObject<THREE.Group> }) {
  const { camera, gl, size } = useThree()
  const az = useRef(Math.PI / 2)
  const pan = useRef(new THREE.Vector3())
  const panGoal = useRef(new THREE.Vector3())
  const fit = useRef(30)
  const zoomGoal = useRef(30)
  const offset = useRef(0)
  const { cols, rows } = ixRef.current.map

  // zoom that fits the whole map
  useEffect(() => {
    fit.current = THREE.MathUtils.clamp(Math.min(size.width / (cols + 4), size.height / ((rows + 4) * SIN_EL + 1)), 8, 120)
    if (!useApp.getState().selectedId) zoomGoal.current = fit.current
  }, [cols, rows, size])

  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    let g: Gesture | null = null

    const aim = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
    }
    const tileOf = (e: PointerEvent) => {
      aim(e)
      if (!ray.ray.intersectPlane(plane, hit)) return null
      const m = ixRef.current.map
      const x = Math.floor(hit.x + m.cols / 2)
      const z = Math.floor(hit.z + m.rows / 2)
      return { x, z, k: tk(x, z), in: inside(m, x, z) }
    }
    /** The building or home under the pointer: the meshes first (a tall building's roof), else the tile. */
    const pickAt = (e: PointerEvent, t: ReturnType<typeof tileOf>) => {
      aim(e)
      for (const h of ray.intersectObjects(pick.current?.children ?? [], true))
        for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick as { kind: 'site' | 'home'; id: string }
      return t ? (ixRef.current.occ.get(t.k) ?? null) : null
    }
    const siteOf = (p: { kind: 'site' | 'home'; id: string } | null) => (p?.kind === 'site' ? p.id : p ? (ixRef.current.homes.find((h) => h.id === p.id)?.site ?? null) : null)
    const ix = () => indexFor(useMini.getState().maps[useMini.getState().world!]!, active.current)

    const panBy = (dx: number, dy: number) => {
      const zoom = (camera as THREE.OrthographicCamera).zoom
      const a = az.current
      const right = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a))
      const fwd = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a))
      panGoal.current.addScaledVector(right, -dx / zoom).addScaledVector(fwd, dy / zoom / SIN_EL)
      const m = ixRef.current.map
      panGoal.current.x = THREE.MathUtils.clamp(panGoal.current.x, -m.cols / 2, m.cols / 2)
      panGoal.current.z = THREE.MathUtils.clamp(panGoal.current.z, -m.rows / 2, m.rows / 2)
    }

    const look = (e: PointerEvent, t: ReturnType<typeof tileOf>) => {
      const site = siteOf(pickAt(e, t))
      const app = useApp.getState()
      const bp = useBp.getState()
      if (!site) return bp.dissect ? bp.setDissect(false) : app.select(null)
      if (app.selectedId !== site) app.select(site)
      else if (!bp.dissect) bp.setDissect(true)
    }

    const place = (tool: Tool, t: ReturnType<typeof tileOf>) => {
      if (!t?.in) return
      const st = useMini.getState()
      const x = ix()
      if (tool === 'roundabout') st.commit(toggleRoundabout(x, t.k))
      if (tool === 'house') {
        const sel = useApp.getState().selectedId
        // with a site open in the panel the picker is hidden, so its homes are for that site
        const site = sel && x.map.sites[sel] ? sel : st.brush && x.map.sites[st.brush] && active.current.has(st.brush) ? st.brush : x.sites[0]?.[0]
        if (site) st.commit(addHome(x, t.k, site, active.current))
      }
    }

    const paint = (s: Extract<Gesture, { kind: 'stroke' }>, k: string) => {
      const st = useMini.getState()
      const x = ix()
      const [tx, tz] = xz(k)
      if (!inside(x.map, tx, tz)) {
        s.last = null
        return
      }
      if (s.tool === 'road') {
        if (s.last && s.last !== k) st.commit(addLink(x, s.last, k), 'stroke')
        s.last = k
        return
      }
      s.last = k
      if (s.tool === 'tree') st.commit(setTree(x, k, s.on), 'stroke')
      else if (s.tool === 'water') st.commit(setWater(x, k, s.on), 'stroke')
      else {
        s.layer ??= topLayer(x, k)
        if (s.layer) st.commit(erase(x, k, s.layer), 'stroke')
      }
    }

    const strokeTo = (s: Extract<Gesture, { kind: 'stroke' }>, k: string) => {
      for (const step of s.last ? steps(s.last, k) : [k]) paint(s, step)
    }

    const down = (e: PointerEvent) => {
      if (g || !useMini.getState().world) return
      const tool = useMini.getState().tool
      const t = tileOf(e)
      const start = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }
      el.setPointerCapture?.(e.pointerId)
      if (e.button === 1 || (e.button === 2 && tool === 'look')) {
        g = { kind: 'pan', ...start }
        return
      }
      if (e.button === 2 || (e.button === 0 && (tool === 'road' || tool === 'tree' || tool === 'water' || tool === 'erase'))) {
        // right-drag rubs out, whatever's in your hand, as in the game
        const st = useMini.getState()
        const s: Extract<Gesture, { kind: 'stroke' }> = { kind: 'stroke', tool: e.button === 2 ? 'erase' : (tool as 'road'), last: null, on: true, layer: null }
        if (t?.in) {
          const x = ix()
          if (s.tool === 'tree') s.on = !x.trees.has(t.k)
          if (s.tool === 'water') s.on = !x.water.has(t.k)
        }
        st.beginStroke()
        g = s
        if (t) strokeTo(s, t.k)
        return
      }
      if (e.button !== 0) return
      if (tool === 'move') {
        const p = pickAt(e, t)
        const x = ix()
        const o = p?.kind === 'site' ? x.map.sites[p.id] : p ? x.map.homes.find((h) => h.id === p.id) : null
        if (p && o && t) {
          g = { kind: 'carry', what: p.kind, id: p.id, dx: t.x - o.x, dz: t.z - o.z, sx: e.clientX, sy: e.clientY, moved: false }
          return
        }
      }
      g = { kind: 'pan', ...start, click: tool === 'look' || tool === 'move' ? () => look(e, t) : () => place(tool, t) }
    }

    const hover = (e: PointerEvent, t: ReturnType<typeof tileOf>) => {
      const tool = useMini.getState().tool
      const site = tool === 'look' || tool === 'move' ? siteOf(pickAt(e, t)) : null
      if (site !== useApp.getState().hoveredId) useApp.getState().hover(site)
      el.style.cursor = tool === 'look' ? (site ? 'pointer' : '') : tool === 'move' ? (site ? 'grab' : '') : 'crosshair'
    }

    const move = (e: PointerEvent) => {
      const t = tileOf(e)
      pointer.tile = t?.in ? t.k : null
      if (!g) return hover(e, t)
      if (g.kind === 'pan') {
        panBy(e.clientX - g.x, e.clientY - g.y)
        g.x = e.clientX
        g.y = e.clientY
      } else if (g.kind === 'stroke') {
        if (t && t.k !== g.last) strokeTo(g, t.k)
      } else if (t) {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 5) return
        g.moved = true
        el.style.cursor = 'grabbing'
        const x = ix()
        const nx = t.x - g.dx
        const nz = t.z - g.dz
        const ok = g.what === 'site' ? canPlot(x, g.id, nx, nz) : canHome(x, tk(nx, nz), g.id) && !x.adj.has(tk(nx, nz))
        const c = useMini.getState().carry
        if (!c || c.x !== nx || c.z !== nz || c.ok !== ok) useMini.getState().setCarry({ kind: g.what, id: g.id, x: nx, z: nz, ok })
      }
    }

    const up = (e: PointerEvent) => {
      if (!g) return
      const done = g
      g = null
      el.releasePointerCapture?.(e.pointerId)
      const st = useMini.getState()
      if (done.kind === 'pan') {
        if (done.click && Math.hypot(e.clientX - done.sx, e.clientY - done.sy) < 6) done.click()
      } else if (done.kind === 'stroke') st.endStroke()
      else {
        const c = st.carry
        st.setCarry(null)
        if (!done.moved) look(e, tileOf(e))
        else if (c?.ok) {
          const x = ix()
          st.commit(done.what === 'site' ? moveSite(x, done.id, c.x, c.z, active.current) : moveHome(x, done.id, c.x, c.z, active.current))
        }
        el.style.cursor = ''
      }
    }

    const leave = () => {
      pointer.tile = null
      if (!g && useApp.getState().hoveredId) useApp.getState().hover(null)
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomGoal.current = THREE.MathUtils.clamp(zoomGoal.current * (1 - e.deltaY * 0.0012), fit.current * 0.75, fit.current * 6)
    }
    const menu = (e: Event) => e.preventDefault()
    const frame = () => {
      const id = useApp.getState().selectedId
      const m = ixRef.current.map
      const p = id ? m.sites[id] : null
      if (!p) {
        panGoal.current.set(0, 0, 0)
        zoomGoal.current = fit.current
        return
      }
      panGoal.current.set(p.x + p.w / 2 - m.cols / 2, 0.4, p.z + p.d / 2 - m.rows / 2)
      zoomGoal.current = THREE.MathUtils.clamp(size.height / (useBp.getState().dissect ? 8 : 12), fit.current, fit.current * 6)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('contextmenu', menu)
    const un1 = useApp.subscribe((s, prev) => s.selectedId !== prev.selectedId && frame())
    const un2 = useBp.subscribe((s, prev) => s.dissect !== prev.dissect && frame())
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('contextmenu', menu)
      el.style.cursor = ''
      if (g?.kind === 'stroke') useMini.getState().endStroke()
      useMini.getState().setCarry(null)
      un1()
      un2()
    }
  }, [camera, gl, size, ixRef, active, pick])

  useFrame((s, dt) => {
    const cam = camera as THREE.OrthographicCamera
    az.current = damp(az.current, Math.PI / 2 + turn.current * (Math.PI / 2), 4, dt)
    pan.current.x = damp(pan.current.x, panGoal.current.x, 5, dt)
    pan.current.y = damp(pan.current.y, panGoal.current.y, 5, dt)
    pan.current.z = damp(pan.current.z, panGoal.current.z, 5, dt)
    const intro = Math.min(1, s.clock.elapsedTime / 1.4)
    cam.zoom = damp(cam.zoom, zoomGoal.current * (0.8 + 0.2 * (1 - Math.pow(1 - intro, 3))), 4, dt)
    // the detail callout sits on the right: shift the map left to make room
    offset.current = damp(offset.current, useApp.getState().selectedId ? Math.min(300, size.width * 0.19) : 0, 4, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
    cam.updateProjectionMatrix()
    const r = 30
    cam.position.set(pan.current.x + Math.cos(az.current) * r, pan.current.y + r * RISE, pan.current.z + Math.sin(az.current) * r)
    cam.lookAt(pan.current)
  })
  return null
}

// --- The scene ----------------------------------------------------------------------------------

export function MiniScene({ turn }: { turn: MutableRefObject<number> }) {
  const projects = useData((s) => s.projects)
  const mode = useData((s) => s.mode)
  const api = useData((s) => s.api)
  const ready = useMini((s) => s.ready)
  const map = useMap()
  const impulses = useImpulses()

  const activeKey = projects.map((p) => p.id).join('\n')
  const active = useMemo(() => new Set(projects.map((p) => p.id)), [activeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const activeRef = useRef(active)
  activeRef.current = active
  const pick = useRef<THREE.Group>(null!)

  // read the saved maps once we know whether the local API is there, then check now and then for the other computer's changes
  useEffect(() => {
    if (mode === 'loading') return
    if (!ready) pullMini()
    if (!api) return
    const again = () => pullMini()
    const timer = window.setInterval(again, 30_000)
    window.addEventListener('focus', again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [mode, api, ready])

  // a city the first time, and room for new sites after
  const shape = projects.map((p) => p.id).join('|')
  useEffect(() => {
    if (ready && mode !== 'loading') settleMap(projects)
  }, [ready, mode, shape, map ? null : 'none']) // eslint-disable-line react-hooks/exhaustive-deps

  const ix = useMemo(() => (map ? indexFor(map, active) : null), [map, active])
  const ixRef = useRef(ix!)
  if (ix) ixRef.current = ix

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  return (
    <>
      <color attach="background" args={[MINI.beyond]} />
      <OrthographicCamera makeDefault position={[0, 52, 30]} zoom={24} near={-200} far={300} />
      {ix && (
        <>
          <Lights cols={ix.map.cols} rows={ix.map.rows} />
          <Rig turn={turn} ixRef={ixRef} active={activeRef} pick={pick} />
          <Ground map={ix.map} />
          <Roads ix={ix} />
          <Trees map={ix.map} />
          <group ref={pick}>
            {ix.sites.map(([id, plot], i) => {
              const p = byId.get(id)
              return p ? <Site key={id} project={p} plot={plot} ix={ix} impulses={impulses} index={i} /> : null
            })}
            {ix.homes.map((h) => (
              <House key={h.id} home={h} ix={ix} />
            ))}
          </group>
          <Cars ix={ix} projects={projects} impulses={impulses} />
          <EditLayer ixRef={ixRef} map={ix.map} />
        </>
      )}
    </>
  )
}
