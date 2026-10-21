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

// Gallery: your sites hung as paintings in a quiet museum. Each canvas is
// generated from the project itself (its colour, its last two weeks of
// commits, its pages and pull requests), and the room tells you what's
// happening: the spotlight, a drape while it deploys, a velvet rope when
// it's broken, notes pinned to the wall for issues, and Claude at an easel.

export const SPACING = 4.8
const WALL_Z = -2
const ART_Y = 1.75
const LEVEL: Record<string, string> = { info: '#9fb4e8', progress: '#ffcf7a', success: '#9be3bf', warning: '#ffcf7a', critical: '#ff8a80' }
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))
const noRay = () => null

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

/** Canvas size in world units for a project: wider for sites with more pages. */
export function artSize(p: Project): [number, number] {
  const w = 2.3 + Math.min(p.pages.length, 8) * 0.08
  return [w, w * 0.72]
}

// --- generative paintings ----------------------------------------------------------------------

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  c.setHSL((hsl.h + k * 0.08 + 1) % 1, Math.min(1, hsl.s * (0.7 + k * 0.2)), Math.min(0.92, Math.max(0.08, hsl.l + k * 0.18)))
  return `#${c.getHexString()}`
}

function paint(p: Project, canvas: HTMLCanvasElement) {
  const W = 640
  const H = 460
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')!
  const rnd = hash(p.id)
  const ac = p.accent
  const style = Math.floor(rnd() * 3)
  const act = p.activity.length ? p.activity : [0]
  const max = Math.max(1, ...act)
  g.fillStyle = '#f3efe6'
  g.fillRect(0, 0, W, H)
  if (style === 0) {
    // colour fields, one band per day of activity (Rothko-ish)
    const bands = [shade(ac, -1.2), shade(ac, 0), shade(ac, 0.9)]
    let y = 24
    const total = act.reduce((a, b) => a + b + 1, 0)
    act.forEach((v, i) => {
      const h = ((v + 1) / total) * (H - 48)
      g.fillStyle = bands[i % 3]
      g.globalAlpha = 0.55 + (v / max) * 0.45
      g.beginPath()
      g.roundRect(26 + rnd() * 6, y, W - 52 - rnd() * 8, Math.max(2, h - 4), 6)
      g.fill()
      y += h
    })
    g.globalAlpha = 1
  } else if (style === 1) {
    // a grid of pages, the busiest cells filled with colour (Mondrian-ish)
    const cols = 4
    const rows = 3
    const xs = [0, ...Array.from({ length: cols - 1 }, () => 0.15 + rnd() * 0.7).sort(), 1]
    const ys = [0, ...Array.from({ length: rows - 1 }, () => 0.15 + rnd() * 0.7).sort(), 1]
    const fills = [ac, shade(ac, 1), '#1d1d1f', '#f2c14e', '#3c5a99']
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const filled = rnd() < 0.18 + Math.min(p.pages.length, 10) * 0.03
        g.fillStyle = filled ? fills[Math.floor(rnd() * fills.length)] : '#f6f3ea'
        g.fillRect(xs[c] * W, ys[r] * H, (xs[c + 1] - xs[c]) * W, (ys[r + 1] - ys[r]) * H)
      }
    g.strokeStyle = '#1d1d1f'
    g.lineWidth = 10
    xs.slice(1, -1).forEach((x) => {
      g.beginPath()
      g.moveTo(x * W, 0)
      g.lineTo(x * W, H)
      g.stroke()
    })
    ys.slice(1, -1).forEach((y) => {
      g.beginPath()
      g.moveTo(0, y * H)
      g.lineTo(W, y * H)
      g.stroke()
    })
  } else {
    // circles and arcs: commits as discs along a line, pull requests as rings (Kandinsky-ish)
    g.fillStyle = shade(ac, 1.6)
    g.fillRect(0, 0, W, H)
    g.lineCap = 'round'
    act.forEach((v, i) => {
      const x = 50 + (i / Math.max(1, act.length - 1)) * (W - 100)
      const y = H * 0.62 - (v / max) * H * 0.35
      g.fillStyle = i % 3 ? ac : shade(ac, -1)
      g.globalAlpha = 0.85
      g.beginPath()
      g.arc(x, y, 6 + (v / max) * 34, 0, Math.PI * 2)
      g.fill()
    })
    g.globalAlpha = 1
    g.strokeStyle = '#1d1d1f'
    g.lineWidth = 3
    p.pulls.slice(0, 5).forEach((_, i) => {
      g.beginPath()
      g.arc(W * (0.2 + rnd() * 0.6), H * (0.2 + rnd() * 0.3), 18 + i * 12, rnd() * 3, rnd() * 3 + 4)
      g.stroke()
    })
    g.lineWidth = 6
    g.beginPath()
    g.moveTo(30, H * 0.85)
    g.bezierCurveTo(W * 0.3, H * 0.6, W * 0.6, H * 1.05, W - 30, H * 0.75)
    g.stroke()
  }
  // canvas texture and a signature
  g.globalAlpha = 0.06
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = rnd() > 0.5 ? '#000' : '#fff'
    g.fillRect(rnd() * W, rnd() * H, 2, 2)
  }
  g.globalAlpha = 0.8
  g.fillStyle = '#1d1d1f'
  g.font = 'italic 22px "Bodoni Moda", serif'
  g.textAlign = 'right'
  g.fillText(p.name.split(' ')[0], W - 26, H - 22)
  g.globalAlpha = 1
}

function useArt(p: Project) {
  const key = `${p.id}|${p.accent}|${p.activity.join(',')}|${p.pages.length}|${p.pulls.length}`
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    paint(p, c)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => tex.dispose(), [tex])
  // repaint once the display font has loaded
  useEffect(() => {
    document.fonts.load('italic 22px "Bodoni Moda"').then(() => {
      paint(p, tex.image as HTMLCanvasElement)
      tex.needsUpdate = true
    })
  }, [tex]) // eslint-disable-line react-hooks/exhaustive-deps
  return tex
}

// --- shaders --------------------------------------------------------------------------------------

const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

// soft pool of light on the wall
const poolFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    vec2 p = (vUv - vec2(0.5, 0.62)) * vec2(1.0, 1.25);
    float a = exp(-dot(p, p) * 7.0) * uAlpha;
    gl_FragColor = vec4(uColor * a, a);
  }`

// the beam from the ceiling: brighter at the top, fading down
const beamFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    float x = abs(vUv.x - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.2 + vUv.y * 0.6, 1.0, x)) * mix(0.15, 1.0, vUv.y) * uAlpha * 0.16;
    gl_FragColor = vec4(uColor * a, a);
  }`

// a gold glint sweeping across the frame on events
const glintFrag = /* glsl */ `
  uniform float uK; uniform vec3 uColor; varying vec2 vUv;
  void main(){
    float d = vUv.x + vUv.y * 0.6 - uK * 2.4 + 0.3;
    float a = exp(-d * d * 60.0) * (1.0 - uK);
    gl_FragColor = vec4(uColor * a, a);
  }`

// the drape: a cloth over the painting while it deploys, rippling and lifting
const drapeVert = /* glsl */ `
  uniform float uTime; uniform float uLift; varying vec2 vUv; varying float vShade;
  void main(){
    vUv = uv;
    vec3 p = position;
    float w = sin(p.x * 6.0 + uTime * 1.3) * 0.03 + sin(p.y * 9.0 - uTime * 0.9) * 0.02;
    float fold = sin(uv.x * 18.0) * 0.04 * (1.0 - uv.y);
    p.z += w + fold + 0.06;
    // lift from the bottom edge up
    float lift = clamp(uLift * 1.6 - (1.0 - uv.y) * 0.6, 0.0, 1.0);
    p.y += lift * (1.0 - uv.y) * 2.2;
    p.z += lift * (1.0 - uv.y) * 0.5;
    vShade = 0.75 + (w + fold) * 4.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`
const drapeFrag = /* glsl */ `
  uniform vec3 uColor; varying vec2 vUv; varying float vShade;
  void main(){ gl_FragColor = vec4(uColor * vShade, 1.0); }`

// --- a single exhibit ------------------------------------------------------------------------------

function Exhibit({ project, index, impulses }: { project: Project; index: number; impulses: Impulses }) {
  const id = project.id
  const sig = signals(project)
  const art = useArt(project)
  const [w, h] = artSize(project)
  const hovered = useApp((s) => s.hoveredId === id)
  const selected = useApp((s) => s.selectedId === id)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const x = index * SPACING

  const canvasMat = useRef<THREE.MeshBasicMaterial>(null!)
  const pool = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: poolFrag, uniforms: { uColor: { value: new THREE.Color('#fff1d6') }, uAlpha: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const beam = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: beamFrag, uniforms: { uColor: { value: new THREE.Color('#fff1d6') }, uAlpha: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), [])
  const glint = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: glintFrag, uniforms: { uK: { value: 1 }, uColor: { value: new THREE.Color('#fff4c2') } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const drape = useMemo(() => new THREE.ShaderMaterial({ vertexShader: drapeVert, fragmentShader: drapeFrag, uniforms: { uTime: { value: 0 }, uLift: { value: 1 }, uColor: { value: new THREE.Color('#7a2333') } } }), [])
  const drapeGeo = useMemo(() => new THREE.PlaneGeometry(w + 0.5, h + 0.5, 24, 24), [w, h])
  useEffect(() => () => [pool, beam, glint, drape].forEach((m) => m.dispose()), [pool, beam, glint, drape])

  const beamRef = useRef<THREE.Group>(null!)
  const drapeRef = useRef<THREE.Mesh>(null!)
  const glintRef = useRef<THREE.Mesh>(null!)
  const easel = useRef<THREE.Group>(null!)
  const brush = useRef<THREE.Mesh>(null!)
  const strokes = useRef<THREE.Mesh>(null!)
  const lift = useRef(1)
  const dim = useMemo(() => ({ on: new THREE.Color('#ffffff'), off: new THREE.Color('#5d5a55') }), [])
  const tints = useMemo(() => ({ warm: new THREE.Color('#fff1d6'), amber: new THREE.Color('#ffc46b'), red: new THREE.Color('#ff7c6b'), cool: new THREE.Color('#d6e6ff') }), [])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const active = hovered || selected
    // spotlight: warm by default, amber and sweeping while building, low and red when broken
    const tint = sig.broken || sig.down ? tints.red : sig.building ? tints.amber : active ? tints.cool : tints.warm
    pool.uniforms.uColor.value.lerp(tint, 1 - Math.exp(-dt * 3))
    beam.uniforms.uColor.value.copy(pool.uniforms.uColor.value)
    const strength = sig.down ? 0.25 : sig.broken ? 0.45 : project.status === 'quiet' ? 0.6 : 1
    pool.uniforms.uAlpha.value = damp(pool.uniforms.uAlpha.value, strength * (active ? 1.25 : 0.95), 3, dt)
    beam.uniforms.uAlpha.value = pool.uniforms.uAlpha.value
    beamRef.current.rotation.z = sig.building && !prefersReducedMotion ? Math.sin(t * 0.9) * 0.18 : damp(beamRef.current.rotation.z, 0, 3, dt)
    canvasMat.current?.color.lerp(sig.down ? dim.off : dim.on, 1 - Math.exp(-dt * 3))

    // drape over the canvas while it deploys; it lifts away when the deploy lands
    lift.current = damp(lift.current, sig.deploying ? 0 : 1, sig.deploying ? 2.5 : 1.2, dt)
    drape.uniforms.uLift.value = lift.current
    drape.uniforms.uTime.value = t
    drapeRef.current.visible = lift.current < 0.98

    // frame glint on any event
    const k = since(impulses, id, t) / 1.3
    glintRef.current.visible = k < 1
    if (k < 1) {
      glint.uniforms.uK.value = k
      glint.uniforms.uColor.value.set(LEVEL[impulses.get(id)!.level])
    }

    // Claude at the easel: strokes appear on the little canvas, the brush dabs
    easel.current.visible = sig.claude
    if (sig.claude) {
      brush.current.position.set(Math.sin(t * 2.3) * 0.22, 1.32 + Math.sin(t * 3.1) * 0.16, 0.1 + Math.max(0, Math.sin(t * 6)) * 0.03)
      strokes.current.scale.x = 0.2 + ((t * 0.12) % 1) * 0.8
    }
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 6) return
    select(selected ? null : id)
  }

  const frame = 0.12
  const notes = Math.min(5, sig.issues)
  const rope = sig.broken || sig.down

  return (
    <group position={[x, 0, WALL_Z]}>
      {/* light pool on the wall, and the beam from the ceiling */}
      <mesh material={pool} position={[0, ART_Y + 0.2, 0.01]} scale={[w * 2.4, h * 2.6, 1]} raycast={noRay}>
        <planeGeometry />
      </mesh>
      <group ref={beamRef} position={[0, 4.2, 1.6]}>
        <mesh material={beam} position={[0, -1.3, -0.8]} rotation={[0.55, 0, 0]} scale={[w * 1.3, 3, 1]} raycast={noRay}>
          <planeGeometry />
        </mesh>
      </group>
      <group
        position={[0, ART_Y, 0.06]}
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
        {/* frame */}
        {[
          [0, h / 2 + frame / 2, w + frame * 2, frame],
          [0, -h / 2 - frame / 2, w + frame * 2, frame],
          [-w / 2 - frame / 2, 0, frame, h],
          [w / 2 + frame / 2, 0, frame, h],
        ].map(([fx, fy, fw, fh], i) => (
          <mesh key={i} position={[fx, fy, 0.04]} scale={[fw, fh, 0.1]}>
            <boxGeometry />
            <meshLambertMaterial color={index % 2 ? '#1d1d1f' : '#b08d57'} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial ref={canvasMat} map={art} toneMapped={false} />
        </mesh>
        <mesh ref={glintRef} material={glint} position={[0, 0, 0.1]} scale={[w + 0.3, h + 0.3, 1]} visible={false} raycast={noRay}>
          <planeGeometry />
        </mesh>
        <mesh ref={drapeRef} geometry={drapeGeo} material={drape} visible={false} raycast={noRay} />
        <Anchor id={`lbl-ga-${id}`} position={[w / 2 + 0.35, -h / 2 + 0.25, 0.05]} />
      </group>

      {/* notes pinned to the wall: open issues */}
      {Array.from({ length: notes }, (_, i) => (
        <mesh key={i} position={[-w / 2 - 0.55 - (i % 2) * 0.32, ART_Y + 0.55 - Math.floor(i / 2) * 0.36, 0.02]} rotation={[0, 0, (i % 3) * 0.08 - 0.08]} raycast={noRay}>
          <planeGeometry args={[0.26, 0.26]} />
          <meshLambertMaterial color={i % 2 ? '#ffe680' : '#ffb3a7'} />
        </mesh>
      ))}

      {/* velvet rope: broken or down */}
      {rope && (
        <group position={[0, 0, 1.1]}>
          {[-1, 1].map((sx) => (
            <group key={sx} position={[sx * (w / 2 + 0.2), 0, 0]}>
              <mesh position={[0, 0.45, 0]} raycast={noRay}>
                <cylinderGeometry args={[0.03, 0.03, 0.9, 10]} />
                <meshLambertMaterial color="#b08d57" />
              </mesh>
              <mesh position={[0, 0.92, 0]} raycast={noRay}>
                <sphereGeometry args={[0.06, 12, 8]} />
                <meshLambertMaterial color="#b08d57" />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 0.78, 0]} rotation={[0, 0, Math.PI / 2]} raycast={noRay}>
            <cylinderGeometry args={[0.025, 0.025, w + 0.4, 8]} />
            <meshLambertMaterial color="#8a1c2b" />
          </mesh>
        </group>
      )}

      {/* Claude's easel */}
      <group ref={easel} position={[w / 2 + 0.9, 0, 0.9]} rotation={[0, -0.5, 0]} visible={false}>
        {[-0.22, 0.22].map((lx) => (
          <mesh key={lx} position={[lx, 0.75, 0]} rotation={[0.08, 0, lx > 0 ? -0.08 : 0.08]} raycast={noRay}>
            <boxGeometry args={[0.04, 1.5, 0.04]} />
            <meshLambertMaterial color="#8d6443" />
          </mesh>
        ))}
        <mesh position={[0, 1.3, 0.04]} raycast={noRay}>
          <boxGeometry args={[0.66, 0.5, 0.03]} />
          <meshLambertMaterial color="#f6f3ea" />
        </mesh>
        <mesh ref={strokes} position={[-0.25, 1.32, 0.06]} raycast={noRay}>
          <planeGeometry args={[0.5, 0.06]} />
          <meshBasicMaterial color="#d97757" />
        </mesh>
        <mesh ref={brush} rotation={[0, 0, 0.6]} raycast={noRay}>
          <cylinderGeometry args={[0.012, 0.02, 0.32, 8]} />
          <meshBasicMaterial color="#d97757" />
        </mesh>
      </group>
    </group>
  )
}

// --- the room -------------------------------------------------------------------------------------

function Room({ length, shadows }: { length: number; shadows: boolean }) {
  const span = length + 30
  const floorMat = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 512
    const g = c.getContext('2d')!
    // oak boards
    for (let i = 0; i < 16; i++) {
      const l = 70 + ((i * 37) % 9)
      g.fillStyle = `hsl(32, 38%, ${l}%)`
      g.fillRect(0, i * 32, 512, 32)
      g.fillStyle = 'rgba(80,50,20,.18)'
      g.fillRect(0, i * 32, 512, 1.5)
      g.fillRect(((i * 173) % 512) | 0, i * 32, 1.5, 32)
    }
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(span / 4, 3)
    t.anisotropy = 8
    return new THREE.MeshLambertMaterial({ map: t })
  }, [span])
  return (
    <group position={[length / 2, 0, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 2]} material={floorMat} receiveShadow={shadows} raycast={noRay}>
        <planeGeometry args={[span, 12]} />
      </mesh>
      <mesh position={[0, 2.6, WALL_Z]} receiveShadow={shadows} raycast={noRay}>
        <planeGeometry args={[span, 5.2]} />
        <meshLambertMaterial color="#f4f1ea" />
      </mesh>
      {/* skirting and a picture rail */}
      <mesh position={[0, 0.08, WALL_Z + 0.02]} raycast={noRay}>
        <boxGeometry args={[span, 0.16, 0.04]} />
        <meshLambertMaterial color="#e6dfd2" />
      </mesh>
      <mesh position={[0, 3.55, WALL_Z + 0.02]} raycast={noRay}>
        <boxGeometry args={[span, 0.05, 0.04]} />
        <meshLambertMaterial color="#d8cfbf" />
      </mesh>
      {/* ceiling */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 5.2, 2]} raycast={noRay}>
        <planeGeometry args={[span, 12]} />
        <meshLambertMaterial color="#efebe3" />
      </mesh>
    </group>
  )
}

function Benches({ count }: { count: number }) {
  return (
    <group>
      {Array.from({ length: Math.ceil(count / 2) }, (_, i) => (
        <group key={i} position={[(i * 2 + 0.5) * SPACING, 0, 0.9]}>
          <mesh position={[0, 0.42, 0]} raycast={noRay}>
            <boxGeometry args={[1.6, 0.08, 0.45]} />
            <meshLambertMaterial color="#3a2f28" />
          </mesh>
          {[-0.66, 0.66].map((bx) => (
            <mesh key={bx} position={[bx, 0.2, 0]} raycast={noRay}>
              <boxGeometry args={[0.08, 0.4, 0.42]} />
              <meshLambertMaterial color="#2a221d" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

function Rig({ scroll, pointer }: { scroll: MutableRefObject<number>; pointer: MutableRefObject<{ x: number; y: number }> }) {
  const { camera, size } = useThree()
  const offset = useRef(0)
  const look = useMemo(() => new THREE.Vector3(), [])
  useFrame((s, dt) => {
    const cam = camera as THREE.PerspectiveCamera
    const sel = useApp.getState().selectedId
    const x = scroll.current * SPACING
    const intro = 1 - Math.pow(1 - Math.min(1, s.clock.elapsedTime / 2), 3)
    const aspect = size.width / size.height
    const z = (sel ? 4.6 : 6.4) + Math.max(0, 1.5 - aspect) * 3 + (1 - intro) * 3
    cam.position.x = damp(cam.position.x, x + pointer.current.x * 0.35, 4, dt)
    cam.position.y = damp(cam.position.y, 1.75 - pointer.current.y * 0.12, 3, dt)
    cam.position.z = damp(cam.position.z, z, 3, dt)
    look.set(cam.position.x - pointer.current.x * 0.2, 1.6, WALL_Z)
    cam.lookAt(look)
    offset.current = damp(offset.current, sel ? Math.min(320, size.width * 0.2) : 0, 3, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
  })
  return null
}

export function GalleryScene({ scroll, pointer, tier }: { scroll: MutableRefObject<number>; pointer: MutableRefObject<{ x: number; y: number }>; tier: Tier }) {
  const projects = useData((s) => s.projects)
  const impulses = useImpulses()
  const length = Math.max(1, projects.length - 1) * SPACING
  return (
    <>
      <color attach="background" args={['#efebe3']} />
      <fog attach="fog" args={['#efebe3', 9, 26]} />
      <hemisphereLight args={['#ffffff', '#c9b79c', 1.6]} />
      <directionalLight position={[3, 6, 6]} intensity={0.9} />
      <Rig scroll={scroll} pointer={pointer} />
      <Room length={length} shadows={tier === 'high'} />
      <Benches count={projects.length} />
      {projects.map((p, i) => (
        <Exhibit key={p.id} project={p} index={i} impulses={impulses} />
      ))}
    </>
  )
}
