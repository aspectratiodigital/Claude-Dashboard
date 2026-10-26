import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Project } from '../../data/types'
import { floorsIn, signals } from '../../data/derive'
import { useApp } from '../../store'
import { Anchor } from '../../shared/Labels'
import { since, type Impulses } from '../../shared/pulse'
import { colorOf, facing, type Home, type Index, type Plot } from './map'
import { centre } from './drive'
import { useMini } from './state'
import { BOX, MINI, ROOF, damp, lambert, mix, noRay, slab } from './look'

// A site's building and the homes its cars come from. A site is a block in its
// own colour on a lighter lot: footprint from how busy it is, one storey per
// page. Pins on the roof are its open issues, and a badge over it shows a build
// running (yellow), a deploy (green) or trouble (red), as Mini Motorways shows
// a building that needs you.

const LOT_H = 0.05
const FLOOR = 0.13

export const siteHeight = (p: Project) => 0.34 + Math.max(1, Math.min(10, floorsIn(p) || 1)) * FLOOR

const PIN_BASE = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 18)
const PIN_TOP = new THREE.CylinderGeometry(0.07, 0.07, 0.04, 18)
const DOT = new THREE.SphereGeometry(0.07, 12, 10)
const COIN = new THREE.CylinderGeometry(0.09, 0.09, 0.02, 18)
const RING = new THREE.RingGeometry(0.96, 1, 64).rotateX(-Math.PI / 2)
const BADGE = new THREE.PlaneGeometry(0.8, 0.8)
const WHITE = new THREE.MeshBasicMaterial({ color: '#ffffff' })
const CLAUDE = new THREE.MeshBasicMaterial({ color: MINI.claude })

const badgeVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }'
// a white disc with a coloured ring that fills clockwise from `uFrom`, like a Mini Motorways timer
const badgeFrag = `varying vec2 vUv; uniform vec3 uColor; uniform float uFrom; uniform float uFill; uniform float uAlpha;
  void main(){
    vec2 p = vUv * 2. - 1.;
    float r = length(p);
    float aa = fwidth(r) * 1.3;
    float disc = 1. - smoothstep(1. - aa, 1., r);
    float ring = smoothstep(.5 - aa, .5, r) * (1. - smoothstep(.82, .82 + aa, r));
    float a = fract(atan(p.x, p.y) / 6.2831853 + 1.);
    float on = step(fract(a - uFrom + 1.), uFill);
    float dot = 1. - smoothstep(.2, .2 + aa, r);
    vec3 col = mix(vec3(1.), mix(vec3(.89, .87, .83), uColor, on), ring);
    col = mix(col, uColor, dot);
    gl_FragColor = vec4(col, disc * uAlpha);
  }`

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export function Site({ project, plot, ix, impulses, index }: { project: Project; plot: Plot; ix: Index; impulses: Impulses; index: number }) {
  const id = project.id
  const color = colorOf(plot.color)
  const carry = useMini((s) => (s.carry?.kind === 'site' && s.carry.id === id ? s.carry : null))
  const hovered = useApp((s) => s.hoveredId === id)
  const selected = useApp((s) => s.selectedId === id)
  const { camera } = useThree()
  const sig = signals(project)
  const store = project.store
  const H = siteHeight(project)
  const floors = Math.round((H - 0.34) / FLOOR)
  const px = carry ? carry.x : plot.x
  const pz = carry ? carry.z : plot.z
  const cx = px + plot.w / 2 - ix.map.cols / 2
  const cz = pz + plot.d / 2 - ix.map.rows / 2
  const bw = plot.w - 0.84
  const bd = plot.d - 0.84
  const top = LOT_H + H
  const pinCount = Math.min(6, sig.issues)

  const root = useRef<THREE.Group>(null!)
  const lift = useRef<THREE.Group>(null!)
  const badge = useRef<THREE.Mesh>(null!)
  const pins = useRef<THREE.Group>(null!)
  const orbit = useRef<THREE.Group>(null!)
  const ping = useRef<THREE.Mesh>(null!)
  const alarm = useRef<THREE.Mesh>(null!)
  const coin = useRef<THREE.Mesh>(null!)
  const tag = useRef<THREE.Group>(null!)
  const lastOrder = useRef<{ id: string | null; at: number }>({ id: null, at: -99 })
  const born = useRef<number | null>(null)

  const mats = useMemo(
    () => ({
      lot: lambert(mix(color, '#ffffff', 0.6)),
      wall: lambert(color),
      cap: lambert(mix(color, '#000000', 0.14)),
      band: lambert(mix(color, '#000000', 0.2)),
      pin: new THREE.MeshBasicMaterial({ color }),
      badge: new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uFrom: { value: 0 }, uFill: { value: 1 }, uAlpha: { value: 1 } },
        vertexShader: badgeVert,
        fragmentShader: badgeFrag,
        transparent: true,
        depthWrite: false,
      }),
      ping: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      alarm: new THREE.MeshBasicMaterial({ color: MINI.bad, transparent: true, opacity: 0, depthWrite: false }),
      coin: new THREE.MeshBasicMaterial({ color: MINI.deploy, transparent: true, opacity: 0 }),
    }),
    [color],
  )
  useEffect(
    () => () => {
      mats.pin.dispose()
      mats.badge.dispose()
      mats.ping.dispose()
      mats.alarm.dispose()
      mats.coin.dispose()
    },
    [mats],
  )

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    if (born.current === null) born.current = t
    // rises out of the ground the first time it's shown
    const k = clamp((t - born.current - 0.2 - index * 0.07) / 0.5, 0, 1)
    root.current.scale.y = Math.max(0.001, 1 - Math.pow(1 - k, 3))
    lift.current.position.y = damp(lift.current.position.y, carry ? 0.4 : hovered || selected ? 0.14 : 0, 10, dt)

    const kind = sig.broken || sig.down ? 'bad' : sig.building ? 'build' : sig.deploying ? 'deploy' : null
    badge.current.visible = !!kind && !carry
    if (kind) {
      badge.current.quaternion.copy(camera.quaternion)
      const u = mats.badge.uniforms
      u.uColor.value.set(kind === 'bad' ? MINI.bad : kind === 'build' ? MINI.build : MINI.deploy)
      u.uFrom.value = kind === 'build' ? (t * 0.8) % 1 : 0
      u.uFill.value = kind === 'build' ? 0.32 : kind === 'deploy' ? (t * 0.4) % 1 : 1
      badge.current.scale.setScalar(kind === 'bad' ? 1 + Math.sin(t * 5) * 0.07 : 1)
      badge.current.position.y = top + 0.6 + Math.sin(t * 2 + index) * 0.03
    }
    alarm.current.visible = kind === 'bad'
    if (kind === 'bad') mats.alarm.opacity = 0.32 + Math.sin(t * 4) * 0.18

    pins.current.children.forEach((p, i) => (p.position.y = top + 0.04 + Math.max(0, Math.sin(t * 2.6 - i * 0.7)) * 0.05))
    // the name tag sits on the lot's edge nearest the camera, below the building on screen
    const ax = s.camera.position.x - cx
    const az = s.camera.position.z - cz
    const al = Math.hypot(ax, az) || 1
    const reach = Math.abs(ax / al) * (plot.w / 2) + Math.abs(az / al) * (plot.d / 2) + 0.25
    tag.current.position.set((ax / al) * reach, 0.1, (az / al) * reach)

    orbit.current.visible = sig.claude
    if (sig.claude) orbit.current.rotation.y = t * 1.3

    // a ring spreads across the ground when something happens here
    const e = since(impulses, id, t) / 1.8
    ping.current.visible = e < 1
    if (e < 1) {
      const r = Math.max(plot.w, plot.d) * (0.6 + e * 1.4)
      ping.current.scale.set(r, 1, r)
      mats.ping.opacity = (1 - e) * (1 - e) * 0.9
      const lvl = impulses.get(id)!.level
      mats.ping.color.set(lvl === 'critical' ? MINI.bad : lvl === 'success' ? MINI.deploy : lvl === 'warning' || lvl === 'progress' ? MINI.build : '#ffffff')
    }

    // a coin pops out of the shopfront on each new order
    if (coin.current) {
      const o = store?.orders[0]?.id ?? null
      if (o !== lastOrder.current.id) {
        if (lastOrder.current.id !== null) lastOrder.current.at = t
        lastOrder.current.id = o
      }
      const c = (t - lastOrder.current.at) / 1.6
      coin.current.visible = c < 1
      if (c < 1) {
        coin.current.position.y = 0.4 + c * 0.8
        coin.current.rotation.z = t * 6
        mats.coin.opacity = 1 - c * c
      }
    }
  })

  const pinCols = Math.min(3, pinCount)
  const pinRows = Math.ceil(pinCount / 3)

  return (
    <group ref={root} position={[cx, 0, cz]}>
      <group ref={lift} userData={{ pick: { kind: 'site', id } }}>
        {/* the white edge round a picked building */}
        <mesh geometry={slab(plot.w + 0.22, plot.d + 0.22, 0.26, 0.012)} material={WHITE} visible={selected || !!carry} raycast={noRay} />
        <mesh geometry={slab(plot.w - 0.08, plot.d - 0.08, 0.18, LOT_H)} material={mats.lot} receiveShadow />
        <mesh geometry={BOX} material={mats.wall} position={[0, LOT_H + H / 2, 0]} scale={[bw, H, bd]} castShadow receiveShadow />
        {/* a band at each floor: one per page */}
        {Array.from({ length: floors }, (_, j) => (
          <mesh key={j} geometry={BOX} material={mats.band} position={[0, LOT_H + 0.2 + j * FLOOR, 0]} scale={[bw + 0.02, 0.018, bd + 0.02]} raycast={noRay} />
        ))}
        <mesh geometry={slab(bw - 0.14, bd - 0.14, 0.06, 0.035)} material={mats.cap} position={[0, top, 0]} castShadow raycast={noRay} />
        <mesh geometry={BOX} material={lambert(MINI.unit)} position={[bw * 0.22, top + 0.08, -bd * 0.18]} scale={[Math.min(0.32, bw * 0.3), 0.1, Math.min(0.24, bd * 0.26)]} castShadow />
        {/* pins on the roof: one per open issue */}
        <group ref={pins}>
          {Array.from({ length: pinCount }, (_, i) => (
            <group key={i} position={[((i % 3) - (pinCols - 1) / 2) * 0.27 - bw * 0.08, top + 0.04, (Math.floor(i / 3) - (pinRows - 1) / 2) * 0.27 + bd * 0.12]}>
              <mesh geometry={PIN_BASE} material={WHITE} raycast={noRay} />
              <mesh geometry={PIN_TOP} material={mats.pin} position={[0, 0.01, 0]} raycast={noRay} />
            </group>
          ))}
        </group>
        {store && (
          <group position={[-plot.w / 2 + 0.36, LOT_H, plot.d / 2 - 0.3]}>
            <mesh geometry={BOX} material={lambert('#ffffff')} position={[0, 0.12, 0]} scale={[0.4, 0.24, 0.28]} castShadow />
            <mesh geometry={BOX} material={lambert(store.error ? MINI.bad : MINI.deploy)} position={[0, 0.25, 0.04]} scale={[0.46, 0.04, 0.36]} castShadow />
            <mesh ref={coin} geometry={COIN} material={mats.coin} rotation={[Math.PI / 2, 0, 0]} visible={false} raycast={noRay} />
          </group>
        )}
        <mesh ref={badge} geometry={BADGE} material={mats.badge} visible={false} raycast={noRay} renderOrder={2} />
        <group ref={orbit} position={[0, top + 0.35, 0]} visible={false}>
          <mesh geometry={DOT} material={CLAUDE} position={[Math.max(bw, bd) / 2 + 0.3, 0, 0]} castShadow raycast={noRay} />
        </group>
        <group ref={tag}>
          <Anchor id={`lbl-mini-${id}`} />
        </group>
      </group>
      <mesh ref={alarm} geometry={RING} material={mats.alarm} position={[0, 0.02, 0]} scale={[Math.max(plot.w, plot.d) * 0.78, 1, Math.max(plot.w, plot.d) * 0.78]} visible={false} raycast={noRay} />
      <mesh ref={ping} geometry={RING} material={mats.ping} position={[0, 0.03, 0]} visible={false} raycast={noRay} />
    </group>
  )
}

/** A home: a little house in its site's colour, with a drive for its two cars. */
export function House({ home, ix }: { home: Home; ix: Index }) {
  const plot = ix.map.sites[home.site]
  const color = colorOf(plot?.color ?? 0)
  const carry = useMini((s) => (s.carry?.kind === 'home' && s.carry.id === home.id ? s.carry : null))
  const mine = useApp((s) => s.selectedId === home.site || s.hoveredId === home.site)
  const lift = useRef<THREE.Group>(null!)
  useFrame((_, dt) => {
    lift.current.position.y = damp(lift.current.position.y, carry ? 0.35 : 0, 10, dt)
  })
  const [fx, fz] = facing(ix, home)
  const [x, z] = centre(ix.map, carry ? carry.x : home.x, carry ? carry.z : home.z)
  return (
    <group position={[x, 0, z]} rotation={[0, Math.atan2(-fz, fx), 0]}>
      <group ref={lift} userData={{ pick: { kind: 'home', id: home.id } }}>
        <mesh geometry={slab(0.98, 0.98, 0.2, 0.01)} material={WHITE} visible={mine || !!carry} raycast={noRay} />
        <mesh geometry={slab(0.84, 0.84, 0.16, 0.03)} material={lambert(mix(color, '#ffffff', 0.62))} receiveShadow />
        <mesh geometry={BOX} material={lambert(color)} position={[-0.15, 0.16, 0]} scale={[0.36, 0.26, 0.44]} castShadow receiveShadow />
        <mesh geometry={ROOF} material={lambert(mix(color, '#000000', 0.2))} position={[-0.15, 0.29, 0]} castShadow />
      </group>
    </group>
  )
}
