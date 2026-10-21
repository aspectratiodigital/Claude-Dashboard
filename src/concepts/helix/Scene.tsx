import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { Project, Status } from '../../data/types'
import { useData } from '../../data/store'
import { STATUS_LABEL, domainOf, fmtMs, signals } from '../../data/derive'
import { useApp } from '../../store'
import type { Tier } from '../../shared/quality'
import { Anchor } from '../../shared/Labels'
import { since, useImpulses, type Impulses } from '../../shared/pulse'

export const STEP_ANGLE = 0.82
export const STEP_Y = 1.6
const RADIUS = 4.2

export const HX_STATUS: Record<Status, string> = {
  live: '#1f9d6b',
  building: '#d98a00',
  deploying: '#6a4bff',
  attention: '#c98a00',
  broken: '#e5484d',
  quiet: '#8a8fa6',
}
const LEVEL: Record<string, string> = { info: '#2e4bff', progress: '#d98a00', success: '#1f9d6b', warning: '#c98a00', critical: '#e5484d' }

const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))

// --- Card face, drawn into a canvas texture whenever its numbers change ----------------------

function faceKey(p: Project) {
  const s = signals(p)
  return [p.name, p.status, p.framework, domainOf(p), p.commitsWeek, p.health.ms, s.prs, s.issues, p.activity.join(',')].join('|')
}

function drawFace(p: Project, tex: THREE.CanvasTexture | null): THREE.CanvasTexture {
  const W = 1024
  const H = 640
  const c = (tex?.image as HTMLCanvasElement | undefined) ?? document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.clearRect(0, 0, W, H)
  const ink = '#1b1e2e'
  const s = signals(p)
  g.fillStyle = HX_STATUS[p.status]
  g.beginPath()
  g.arc(64, 70, 9, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(27,30,46,.72)'
  g.font = '600 26px Manrope'
  g.fillText(`${STATUS_LABEL[p.status]}  ·  ${p.framework}`, 86, 79)
  g.textAlign = 'right'
  g.fillText(domainOf(p), W - 60, 79)
  g.textAlign = 'left'
  // name, wrapped
  g.fillStyle = ink
  g.font = 'italic 112px "Instrument Serif"'
  let line = ''
  let y = 250
  for (const w of p.name.split(' ')) {
    const test = line ? `${line} ${w}` : w
    if (g.measureText(test).width > W - 120 && line) {
      g.fillText(line, 58, y)
      line = w
      y += 104
    } else line = test
  }
  g.fillText(line, 58, y)
  // stats
  const stats: [string, string][] = [
    [String(p.commitsWeek), 'commits / wk'],
    [p.health.ms === null ? '–' : fmtMs(p.health.ms), 'response'],
    [String(s.prs), 'open PRs'],
  ]
  stats.forEach(([v, l], i) => {
    const x = 60 + i * 210
    g.fillStyle = ink
    g.font = '600 48px Manrope'
    g.fillText(v, x, H - 92)
    g.fillStyle = 'rgba(27,30,46,.55)'
    g.font = '500 24px Manrope'
    g.fillText(l, x, H - 56)
  })
  // issues pill
  if (s.issues) {
    const label = `${s.issues} issue${s.issues === 1 ? '' : 's'}`
    g.font = '700 24px Manrope'
    const w = g.measureText(label).width + 36
    g.fillStyle = 'rgba(229,72,77,.12)'
    g.beginPath()
    g.roundRect(W - 60 - w, 112, w, 44, 22)
    g.fill()
    g.fillStyle = '#c4343a'
    g.fillText(label, W - 60 - w + 18, 142)
  }
  // activity sparkline
  const d = p.activity.length ? p.activity : [0, 0]
  const max = Math.max(1, ...d)
  const x0 = W - 320
  const sw = 260
  g.strokeStyle = '#2e4bff'
  g.lineWidth = 5
  g.lineJoin = 'round'
  g.beginPath()
  d.forEach((v, i) => {
    const x = x0 + (i / (d.length - 1)) * sw
    const yy = H - 60 - (v / max) * 90
    if (i) g.lineTo(x, yy)
    else g.moveTo(x, yy)
  })
  g.stroke()
  if (tex) {
    tex.needsUpdate = true
    return tex
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function useFonts() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    Promise.all([document.fonts.load('italic 112px "Instrument Serif"'), document.fonts.load('600 26px Manrope'), document.fonts.load('500 24px Manrope')]).finally(() => setReady(true))
  }, [])
  return ready
}

// --- Notification shaders ------------------------------------------------------------------------

const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

// A rounded-rect outline that grows out of the card and fades: the "something happened" ping.
const pingFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uK; uniform vec2 uSize; varying vec2 vUv;
  float box(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main(){
    vec2 p = (vUv - 0.5) * uSize;
    float grow = uK * 0.5;
    float d = abs(box(p, vec2(1.7, 1.06) + grow, 0.14 + grow * 0.5));
    float a = smoothstep(0.06, 0.0, d) * (1.0 - uK) * (1.0 - uK);
    float fill = smoothstep(0.0, -0.3, box(p, vec2(1.7, 1.06), 0.14)) * (1.0 - uK) * 0.25;
    gl_FragColor = vec4(uColor, a + fill * step(uK, 0.6));
  }`

// Moving diagonal stripes for the build/deploy progress bar.
const barFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
  void main(){
    float s = step(0.5, fract((vUv.x * 40.0 + vUv.y * 2.0) - uTime * 1.6));
    float sweep = smoothstep(0.25, 0.0, abs(fract(vUv.x - uTime * 0.35) - 0.5) - 0.25);
    vec3 col = mix(uColor, vec3(1.0), s * 0.25 + sweep * 0.25);
    float ends = smoothstep(0.0, 0.02, vUv.x) * smoothstep(1.0, 0.98, vUv.x);
    gl_FragColor = vec4(col, uAlpha * ends);
  }`

// Soft coloured shadow under a broken card, breathing.
const glowFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    vec2 p = (vUv - 0.5) * 2.0;
    float d = length(max(abs(p) - vec2(0.62, 0.5), 0.0));
    float a = exp(-d * d * 22.0) * uAlpha;
    gl_FragColor = vec4(uColor, a);
  }`

// --- Cards ---------------------------------------------------------------------------------------

function Glass({ tier }: { tier: Tier }) {
  // Real transmission costs a second render pass: only on the high tier.
  if (tier === 'high')
    return (
      <meshPhysicalMaterial
        transmission={1}
        thickness={0.35}
        roughness={0.08}
        ior={1.45}
        iridescence={0.55}
        iridescenceIOR={1.3}
        clearcoat={1}
        clearcoatRoughness={0.1}
        color="#ffffff"
        attenuationColor="#dfe5ff"
        attenuationDistance={2}
      />
    )
  if (tier === 'balanced') return <meshPhysicalMaterial transparent opacity={0.62} roughness={0.15} clearcoat={1} clearcoatRoughness={0.15} iridescence={0.4} color="#f4f6ff" depthWrite={false} />
  return <meshStandardMaterial transparent opacity={0.66} roughness={0.25} color="#f4f6ff" depthWrite={false} />
}

function Card({
  project,
  index,
  scroll,
  pointer,
  onPick,
  impulses,
  tier,
  fonts,
}: {
  project: Project
  index: number
  scroll: MutableRefObject<number>
  pointer: MutableRefObject<{ x: number; y: number }>
  onPick: (i: number) => void
  impulses: Impulses
  tier: Tier
  fonts: boolean
}) {
  const key = faceKey(project)
  const texRef = useRef<THREE.CanvasTexture | null>(null)
  const tex = useMemo(() => {
    if (!fonts) return null
    texRef.current = drawFace(project, texRef.current)
    return texRef.current
  }, [fonts, key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => texRef.current?.dispose(), [])

  const group = useRef<THREE.Group>(null!)
  const tilt = useRef<THREE.Group>(null!)
  const face = useRef<THREE.MeshBasicMaterial>(null!)
  const ping = useRef<THREE.Mesh>(null!)
  const bar = useRef<THREE.Mesh>(null!)
  const glow = useRef<THREE.Mesh>(null!)
  const dots = useRef<THREE.Group>(null!)
  const [hot, setHot] = useState(false)
  const hover = useApp((s) => s.hover)
  const sig = signals(project)

  const pingMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: pingFrag, uniforms: { uColor: { value: new THREE.Color() }, uK: { value: 1 }, uSize: { value: new THREE.Vector2(5, 3.6) } }, transparent: true, depthWrite: false }), [])
  const barMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: barFrag, uniforms: { uColor: { value: new THREE.Color('#d98a00') }, uTime: { value: 0 }, uAlpha: { value: 0 } }, transparent: true, depthWrite: false }), [])
  const glowMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: glowFrag, uniforms: { uColor: { value: new THREE.Color('#e5484d') }, uAlpha: { value: 0 } }, transparent: true, depthWrite: false }), [])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const rel = index - scroll.current
    // far cards are skipped entirely (and their labels hide with them)
    group.current.visible = Math.abs(rel) < 3.2
    if (!group.current.visible) return
    const a = rel * STEP_ANGLE
    group.current.position.set(Math.sin(a) * RADIUS, -rel * STEP_Y, Math.cos(a) * RADIUS - RADIUS)
    group.current.rotation.y = a
    const near = Math.max(0, 1 - Math.abs(rel) * 0.42)
    const s = 0.86 + near * 0.18 + (hot ? 0.04 : 0)
    group.current.scale.setScalar(damp(group.current.scale.x, s, 8, dt))
    const tx = hot ? -pointer.current.y * 0.18 : 0
    const ty = hot ? pointer.current.x * 0.22 : 0
    tilt.current.rotation.x = damp(tilt.current.rotation.x, tx, 8, dt)
    tilt.current.rotation.y = damp(tilt.current.rotation.y, ty, 8, dt)
    tilt.current.position.z = damp(tilt.current.position.z, hot ? 0.25 : 0, 8, dt)
    if (face.current) face.current.opacity = 0.25 + near * 0.75

    // event ping
    const k = since(impulses, project.id, t) / 1.4
    ping.current.visible = k < 1
    if (k < 1) {
      pingMat.uniforms.uK.value = k
      pingMat.uniforms.uColor.value.set(LEVEL[impulses.get(project.id)!.level])
    }
    // build / deploy progress bar
    const busy = sig.building || sig.deploying
    barMat.uniforms.uTime.value = t
    barMat.uniforms.uAlpha.value = damp(barMat.uniforms.uAlpha.value, busy ? 0.95 * (0.3 + near * 0.7) : 0, 4, dt)
    barMat.uniforms.uColor.value.set(sig.deploying && !sig.building ? HX_STATUS.deploying : HX_STATUS.building)
    bar.current.visible = barMat.uniforms.uAlpha.value > 0.01
    // broken: the card sits in a breathing red glow
    glowMat.uniforms.uAlpha.value = damp(glowMat.uniforms.uAlpha.value, sig.broken || sig.down ? 0.55 + Math.sin(t * 2.6) * 0.2 : 0, 3, dt)
    glow.current.visible = glowMat.uniforms.uAlpha.value > 0.01
    // Claude working: three bouncing dots in the corner
    dots.current.visible = sig.claude
    if (sig.claude) dots.current.children.forEach((d, i) => (d.position.y = Math.max(0, Math.sin(t * 5 - i * 0.7)) * 0.07))
  })

  return (
    <group ref={group}>
      <mesh ref={glow} material={glowMat} position={[0, -0.1, -0.2]} scale={[5.4, 3.8, 1]} renderOrder={-1}>
        <planeGeometry />
      </mesh>
      <group
        ref={tilt}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHot(true)
          hover(project.id)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHot(false)
          hover(null)
          document.body.style.cursor = ''
        }}
        onClick={(e) => {
          e.stopPropagation()
          onPick(index)
        }}
      >
        <RoundedBox args={[3.4, 2.12, 0.14]} radius={0.12} smoothness={tier === 'high' ? 4 : 2}>
          <Glass tier={tier} />
        </RoundedBox>
        {tex && (
          <mesh position={[0, 0, 0.075]}>
            <planeGeometry args={[3.2, 2]} />
            <meshBasicMaterial ref={face} map={tex} transparent toneMapped={false} depthWrite={false} />
          </mesh>
        )}
        {/* brand edge */}
        <mesh position={[-1.68, 0, 0.076]}>
          <planeGeometry args={[0.03, 1.4]} />
          <meshBasicMaterial color={project.accent} toneMapped={false} />
        </mesh>
        <mesh ref={bar} material={barMat} position={[0, -1.0, 0.078]}>
          <planeGeometry args={[3.0, 0.05]} />
        </mesh>
        <group ref={dots} position={[1.26, 0.62, 0.08]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[i * 0.11, 0, 0]}>
              <circleGeometry args={[0.035, 16]} />
              <meshBasicMaterial color="#2e4bff" toneMapped={false} />
            </mesh>
          ))}
        </group>
        <mesh ref={ping} material={pingMat} position={[0, 0, 0.09]} scale={[5, 3.6, 1]} visible={false}>
          <planeGeometry />
        </mesh>
        <Anchor id={`lbl-hx-${project.id}`} position={[1.2, 1.25, 0.1]} />
      </group>
    </group>
  )
}

// --- Background: slow drifting colour field ------------------------------------------------------

const bgFrag = /* glsl */ `
  uniform float uTime; uniform vec2 uRes; uniform vec3 uTint; uniform float uTintA; varying vec2 vUv;
  vec3 blob(vec2 uv, vec2 c, float r, vec3 col) { float d = length((uv - c) * vec2(uRes.x / uRes.y, 1.0)); return col * smoothstep(r, 0.0, d); }
  void main() {
    vec2 uv = vUv; float t = uTime * 0.05;
    vec3 col = vec3(0.905, 0.918, 0.957);
    col += blob(uv, vec2(0.72 + sin(t * 3.0) * 0.08, 0.62 + cos(t * 2.0) * 0.1), 0.75, vec3(-0.12, -0.07, 0.04));
    col += blob(uv, vec2(0.25 + cos(t * 2.4) * 0.1, 0.25 + sin(t * 1.7) * 0.08), 0.6, vec3(0.05, -0.02, -0.06));
    col += blob(uv, vec2(0.55 + sin(t * 1.3) * 0.12, 0.05), 0.5, vec3(-0.2, -0.15, 0.02));
    col += blob(uv, vec2(0.95, 0.95), 0.5, vec3(0.04, 0.04, 0.04));
    // a wash of colour from the bottom edge when something happens
    col = mix(col, uTint, uTintA * smoothstep(0.55, 0.0, uv.y));
    float grain = fract(sin(dot(uv * uRes + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    gl_FragColor = vec4(col + (grain - 0.5) * 0.018, 1.0);
  }`

function Backdrop({ wash }: { wash: MutableRefObject<{ at: number; color: string }> }) {
  const { size } = useThree()
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uTint: { value: new THREE.Color() }, uTintA: { value: 0 } }), [])
  useFrame((s) => {
    uniforms.uTime.value = s.clock.elapsedTime
    uniforms.uRes.value.set(size.width, size.height)
    const k = (s.clock.elapsedTime - wash.current.at) / 2.4
    uniforms.uTintA.value = k >= 0 && k < 1 ? Math.sin(k * Math.PI) * 0.16 : 0
    uniforms.uTint.value.set(wash.current.color)
  })
  return (
    <mesh position={[0, 0, -14]} scale={[60, 36, 1]} renderOrder={-2}>
      <planeGeometry />
      <shaderMaterial uniforms={uniforms} vertexShader={quadVert} fragmentShader={bgFrag} depthWrite={false} />
    </mesh>
  )
}

/** Thin spine running down the helix so the spiral reads between cards. */
function Spine({ scroll, count }: { scroll: MutableRefObject<number>; count: number }) {
  const ref = useRef<THREE.Group>(null!)
  const line = useMemo(() => {
    const pts: THREE.Vector3[] = []
    const r = RADIUS - 1.9
    for (let i = -3; i <= count + 2; i += 0.05) {
      const a = i * STEP_ANGLE
      pts.push(new THREE.Vector3(Math.sin(a) * r, -i * STEP_Y, Math.cos(a) * r))
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts)
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#2e4bff', transparent: true, opacity: 0.22 }))
  }, [count])
  useFrame(() => {
    ref.current.rotation.y = -scroll.current * STEP_ANGLE
    ref.current.position.y = scroll.current * STEP_Y
  })
  return (
    <group position={[0, 0, -RADIUS]}>
      <group ref={ref}>
        <primitive object={line} />
      </group>
    </group>
  )
}

function Rig({ pointer, drawer }: { pointer: MutableRefObject<{ x: number; y: number }>; drawer: boolean }) {
  const { camera, size } = useThree()
  useFrame((state, dt) => {
    const intro = Math.min(1, state.clock.elapsedTime / 1.8)
    const ez = 1 - Math.pow(1 - intro, 3)
    // narrower windows: step back a little so the front card still fits
    const aspect = size.width / size.height
    const back = THREE.MathUtils.clamp((1.7 - aspect) * 4, 0, 4)
    const tx = (drawer ? 3.7 : -1.9) + pointer.current.x * 0.35
    const ty = -pointer.current.y * 0.25
    const tz = 9.5 + back + (drawer ? 1.2 : 0) + (1 - ez) * 6
    camera.position.x = damp(camera.position.x, tx, 2.5, dt)
    camera.position.y = damp(camera.position.y, ty, 2.5, dt)
    camera.position.z = damp(camera.position.z, tz, 2.5, dt)
    camera.lookAt(camera.position.x, camera.position.y * 0.5, 0)
  })
  return null
}

export function HelixScene({
  scroll,
  pointer,
  onPick,
  drawer,
  tier,
}: {
  scroll: MutableRefObject<number>
  pointer: MutableRefObject<{ x: number; y: number }>
  onPick: (i: number) => void
  drawer: boolean
  tier: Tier
}) {
  const projects = useData((s) => s.projects)
  const fonts = useFonts()
  const wash = useRef({ at: -99, color: '#2e4bff' })
  const impulses = useImpulses(
    useMemo(
      () => (n: { level: string }, at: number) => {
        if (n.level === 'critical' || n.level === 'success') wash.current = { at, color: LEVEL[n.level] }
      },
      [],
    ),
  )
  return (
    <>
      <Rig pointer={pointer} drawer={drawer} />
      <Backdrop wash={wash} />
      <Environment resolution={tier === 'high' ? 256 : 64} frames={1}>
        <Lightformer form="rect" intensity={3} position={[0, 5, 4]} scale={[10, 3, 1]} color="#ffffff" />
        <Lightformer form="rect" intensity={2} position={[-6, 0, 2]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} color="#b9c2ff" />
        <Lightformer form="ring" intensity={2.5} position={[6, 1, 1]} rotation-y={-Math.PI / 2} scale={3} color="#ffd9c7" />
        <Lightformer form="rect" intensity={1} position={[0, -5, 2]} scale={[10, 2, 1]} color="#2e4bff" />
      </Environment>
      <ambientLight intensity={0.6} />
      {projects.map((p, i) => (
        <Card key={p.id} project={p} index={i} scroll={scroll} pointer={pointer} onPick={onPick} impulses={impulses} tier={tier} fonts={fonts} />
      ))}
      <Spine scroll={scroll} count={projects.length} />
    </>
  )
}
