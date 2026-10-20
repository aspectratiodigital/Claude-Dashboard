import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { SITES, STATUS_LABEL, type Site } from '../../data/mock'
import { useApp } from '../../store'

export const STEP_ANGLE = 0.82
export const STEP_Y = 1.6
const RADIUS = 4.2
export const HX_STATUS: Record<Site['status'], string> = {
  live: '#1f9d6b',
  building: '#d98a00',
  attention: '#e5484d',
}

// --- Card face, drawn once into a canvas texture ---------------------------

function drawFace(site: Site): THREE.CanvasTexture {
  const W = 1024
  const H = 640
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.clearRect(0, 0, W, H)
  const ink = '#1b1e2e'
  // status
  g.fillStyle = HX_STATUS[site.status]
  g.beginPath()
  g.arc(64, 70, 9, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(27,30,46,.72)'
  g.font = '600 26px Manrope'
  g.fillText(`${STATUS_LABEL[site.status]}  ·  ${site.framework}`, 86, 79)
  g.textAlign = 'right'
  g.fillText(site.domain, W - 60, 79)
  g.textAlign = 'left'
  // name
  g.fillStyle = ink
  g.font = 'italic 112px "Instrument Serif"'
  const words = site.name.split(' ')
  let line = ''
  let y = 250
  for (const w of words) {
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
    [site.visitors7d.toLocaleString(), 'visitors'],
    [String(site.lighthouse || '–'), 'lighthouse'],
    [String(site.openPRs), 'open PRs'],
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
  // sparkline
  const d = site.traffic
  const max = Math.max(...d)
  const min = Math.min(...d)
  const x0 = W - 320
  const w = 260
  g.strokeStyle = '#2e4bff'
  g.lineWidth = 5
  g.lineJoin = 'round'
  g.beginPath()
  d.forEach((v, i) => {
    const x = x0 + (i / (d.length - 1)) * w
    const yy = H - 60 - ((v - min) / (max - min || 1)) * 90
    if (i) g.lineTo(x, yy)
    else g.moveTo(x, yy)
  })
  g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function useFonts() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    Promise.all([
      document.fonts.load('italic 112px "Instrument Serif"'),
      document.fonts.load('600 26px Manrope'),
      document.fonts.load('500 24px Manrope'),
    ]).finally(() => setReady(true))
  }, [])
  return ready
}

// --- Cards -----------------------------------------------------------------

function Card({
  site,
  index,
  scroll,
  pointer,
  onPick,
}: {
  site: Site
  index: number
  scroll: MutableRefObject<number>
  pointer: MutableRefObject<{ x: number; y: number }>
  onPick: (i: number) => void
}) {
  const fontsReady = useFonts()
  const tex = useMemo(() => (fontsReady ? drawFace(site) : null), [fontsReady, site])
  const group = useRef<THREE.Group>(null!)
  const tilt = useRef<THREE.Group>(null!)
  const face = useRef<THREE.MeshBasicMaterial>(null!)
  const [hot, setHot] = useState(false)
  const hoverId = useApp((s) => s.hover)

  useFrame((_, dt) => {
    const rel = index - scroll.current
    const a = rel * STEP_ANGLE
    group.current.position.set(Math.sin(a) * RADIUS, -rel * STEP_Y, Math.cos(a) * RADIUS - RADIUS)
    group.current.rotation.y = a
    const near = Math.max(0, 1 - Math.abs(rel) * 0.42)
    const k = Math.min(1, dt * 8)
    const s = 0.86 + near * 0.18 + (hot ? 0.04 : 0)
    group.current.scale.setScalar(group.current.scale.x + (s - group.current.scale.x) * k)
    // hover tilt toward the pointer
    const tx = hot ? -pointer.current.y * 0.18 : 0
    const ty = hot ? pointer.current.x * 0.22 : 0
    tilt.current.rotation.x += (tx - tilt.current.rotation.x) * k
    tilt.current.rotation.y += (ty - tilt.current.rotation.y) * k
    tilt.current.position.z += ((hot ? 0.25 : 0) - tilt.current.position.z) * k
    if (face.current) face.current.opacity = 0.25 + near * 0.75
  })

  return (
    <group ref={group}>
      <group
        ref={tilt}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHot(true)
          hoverId(site.id)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHot(false)
          hoverId(null)
          document.body.style.cursor = ''
        }}
        onClick={(e) => {
          e.stopPropagation()
          onPick(index)
        }}
      >
        <RoundedBox args={[3.4, 2.12, 0.14]} radius={0.12} smoothness={4}>
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
            envMapIntensity={1}
            attenuationColor="#dfe5ff"
            attenuationDistance={2}
          />
        </RoundedBox>
        {tex && (
          <mesh position={[0, 0, 0.075]}>
            <planeGeometry args={[3.2, 2]} />
            <meshBasicMaterial ref={face} map={tex} transparent toneMapped={false} depthWrite={false} />
          </mesh>
        )}
        {/* brand edge */}
        <mesh position={[-1.7 + 0.02, 0, 0.075]}>
          <planeGeometry args={[0.03, 1.4]} />
          <meshBasicMaterial color={site.brand.accent} toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

// --- Background: slow drifting colour field -------------------------------

const bgFrag = /* glsl */ `
  uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
  vec3 blob(vec2 uv, vec2 c, float r, vec3 col) { float d = length((uv - c) * vec2(uRes.x / uRes.y, 1.0)); return col * smoothstep(r, 0.0, d); }
  void main() {
    vec2 uv = vUv; float t = uTime * 0.05;
    vec3 col = vec3(0.905, 0.918, 0.957);
    col += blob(uv, vec2(0.72 + sin(t * 3.0) * 0.08, 0.62 + cos(t * 2.0) * 0.1), 0.75, vec3(-0.12, -0.07, 0.04));
    col += blob(uv, vec2(0.25 + cos(t * 2.4) * 0.1, 0.25 + sin(t * 1.7) * 0.08), 0.6, vec3(0.05, -0.02, -0.06));
    col += blob(uv, vec2(0.55 + sin(t * 1.3) * 0.12, 0.05), 0.5, vec3(-0.2, -0.15, 0.02));
    col += blob(uv, vec2(0.95, 0.95), 0.5, vec3(0.04, 0.04, 0.04));
    float grain = fract(sin(dot(uv * uRes + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    gl_FragColor = vec4(col + (grain - 0.5) * 0.018, 1.0);
  }`

function Backdrop() {
  const { size } = useThree()
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } }), [])
  useFrame((s) => {
    uniforms.uTime.value = s.clock.elapsedTime
    uniforms.uRes.value.set(size.width, size.height)
  })
  return (
    <mesh position={[0, 0, -14]} scale={[60, 36, 1]} renderOrder={-1}>
      <planeGeometry />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader="varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }"
        fragmentShader={bgFrag}
        depthWrite={false}
      />
    </mesh>
  )
}

/** Thin spine running down the helix so the spiral reads between cards. */
function Spine({ scroll }: { scroll: MutableRefObject<number> }) {
  const ref = useRef<THREE.Group>(null!)
  const line = useMemo(() => {
    const pts: THREE.Vector3[] = []
    const r = RADIUS - 1.9
    for (let i = -3; i <= SITES.length + 2; i += 0.05) {
      const a = i * STEP_ANGLE
      pts.push(new THREE.Vector3(Math.sin(a) * r, -i * STEP_Y, Math.cos(a) * r))
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts)
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#2e4bff', transparent: true, opacity: 0.22 }))
  }, [])
  useFrame(() => {
    // spin and lift the spine with the scroll so it stays attached to the cards
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
  const { camera } = useThree()
  useFrame((state, dt) => {
    const k = Math.min(1, dt * 2.5)
    const intro = Math.min(1, state.clock.elapsedTime / 1.8)
    const ez = 1 - Math.pow(1 - intro, 3)
    const tx = (drawer ? 1.6 : -1.9) + pointer.current.x * 0.35
    const ty = -pointer.current.y * 0.25
    const tz = 9.5 + (1 - ez) * 6
    camera.position.x += (tx - camera.position.x) * k
    camera.position.y += (ty - camera.position.y) * k
    camera.position.z += (tz - camera.position.z) * k
    camera.lookAt(camera.position.x, camera.position.y * 0.5, 0)
  })
  return null
}

export function HelixScene({
  scroll,
  pointer,
  onPick,
  drawer,
}: {
  scroll: MutableRefObject<number>
  pointer: MutableRefObject<{ x: number; y: number }>
  onPick: (i: number) => void
  drawer: boolean
}) {
  return (
    <>
      <Rig pointer={pointer} drawer={drawer} />
      <Backdrop />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={3} position={[0, 5, 4]} scale={[10, 3, 1]} color="#ffffff" />
        <Lightformer form="rect" intensity={2} position={[-6, 0, 2]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} color="#b9c2ff" />
        <Lightformer form="ring" intensity={2.5} position={[6, 1, 1]} rotation-y={-Math.PI / 2} scale={3} color="#ffd9c7" />
        <Lightformer form="rect" intensity={1} position={[0, -5, 2]} scale={[10, 2, 1]} color="#2e4bff" />
      </Environment>
      <ambientLight intensity={0.6} />
      <group position={[0, 0, 0]}>
        {SITES.map((s, i) => (
          <Card key={s.id} site={s} index={i} scroll={scroll} pointer={pointer} onPick={onPick} />
        ))}
        <Spine scroll={scroll} />
      </group>
    </>
  )
}
