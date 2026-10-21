import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Note, NoteLevel, Project } from '../../data/types'
import { useData } from '../../data/store'
import { domainOf, relTime, signals, type Signals } from '../../data/derive'
import { useApp, prefersReducedMotion } from '../../store'
import type { Tier } from '../../shared/quality'
import { Anchor } from '../../shared/Labels'
import { since, useImpulses, type Impulses } from '../../shared/pulse'

// Arcade: every site is a cabinet in a neon arcade. The screen plays the
// project's state (attract mode, NOW LOADING, LEVEL UP, GAME OVER), the
// marquee lights race when something happens, space invaders hover over
// sites with open issues, coins pile up for pull requests, and Claude turns
// up as player 2. Screens are tiny canvases redrawn a few times a second,
// and only while they're on screen.

const GAP = 1.6
export const CLAUDE = '#d97757'
export const LEVEL: Record<NoteLevel, string> = { info: '#3df5ff', progress: '#ffe53d', success: '#3dff8b', warning: '#ff9d3d', critical: '#ff3d5e' }
const AMBER = '#ffb23d'
const GREEN = '#3dff8b'
const RED = '#ff2d55'
const PX = '"Press Start 2P", monospace'
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))
const noRay = () => null
type V3 = [number, number, number]

export interface Slot {
  project: Project
  index: number
  angle: number
  x: number
  z: number
}

/** Cabinets stand on an arc facing the middle of the room. */
export function useSlots() {
  const projects = useData((s) => s.projects)
  return useMemo(() => {
    const n = projects.length
    const want = Math.min(Math.PI * 0.8, Math.max(0.6, (n - 1) * 0.22))
    const radius = Math.max(6.5, ((n - 1) * GAP) / want)
    const span = n > 1 ? ((n - 1) * GAP) / radius : 0
    const slots: Slot[] = projects.map((p, i) => {
      const angle = n > 1 ? -span / 2 + (i / (n - 1)) * span : 0
      return { project: p, index: i, angle, x: Math.sin(angle) * radius, z: -Math.cos(angle) * radius }
    })
    return { slots, radius, span }
  }, [projects])
}

// --- the cabinet's geometry, built once and shared ----------------------------------------------

const W = 1.1
// side silhouette as (z, y): base, control-panel lip, screen, marquee overhang
const PROFILE: [number, number][] = [
  [-0.42, 0],
  [0.36, 0],
  [0.36, 0.96],
  [0.5, 1.04],
  [0.46, 1.12],
  [0.12, 1.22],
  [0.08, 2.08],
  [0.22, 2.12],
  [0.22, 2.46],
  [-0.42, 2.46],
]
const DECK_POS: V3 = [0, 1.133, 0.29]
const DECK_ROT: V3 = [0.286, 0, 0]
const DECK = new THREE.Matrix4().compose(new THREE.Vector3(...DECK_POS), new THREE.Quaternion().setFromEuler(new THREE.Euler(...DECK_ROT)), new THREE.Vector3(1, 1, 1))

function placed(geo: THREE.BufferGeometry, color: string, pos: V3, rot: V3 = [0, 0, 0], parent?: THREE.Matrix4) {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1))
  if (parent) m.premultiply(parent)
  g.applyMatrix4(m)
  const c = new THREE.Color(color)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.clearGroups()
  return g
}

let shared: { shell: THREE.BufferGeometry; neon: THREE.BufferGeometry } | null = null

function cabinetGeometry() {
  if (shared) return shared
  const BODY = '#241338'
  const SIDE = '#1a0d2b'
  const shape = new THREE.Shape(PROFILE.map(([z, y]) => new THREE.Vector2(z, y)))
  const side = () => new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false }).rotateY(-Math.PI / 2)
  const parts = [
    placed(side(), SIDE, [W / 2 + 0.05, 0, 0]),
    placed(side(), SIDE, [-W / 2, 0, 0]),
    placed(new THREE.BoxGeometry(W, 0.96, 0.78), BODY, [0, 0.48, -0.03]),
    placed(new THREE.BoxGeometry(W, 0.14, 0.16), BODY, [0, 1.03, 0.42]),
    placed(new THREE.BoxGeometry(W, 0.07, 0.42), '#140a22', [0, 0, 0], [0, 0, 0], DECK),
    placed(new THREE.BoxGeometry(W, 0.9, 0.5), BODY, [0, 1.65, -0.17]),
    placed(new THREE.BoxGeometry(W - 0.04, 0.84, 0.02), '#050208', [0, 1.65, 0.09]),
    placed(new THREE.BoxGeometry(W, 0.34, 0.64), BODY, [0, 2.29, -0.1]),
    placed(new THREE.BoxGeometry(0.34, 0.38, 0.02), '#2b2140', [0, 0.52, 0.37]),
    // player 1 stick, buttons, start buttons and player 2's stick base
    placed(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 16), '#0b0710', [-0.32, 0.041, 0.02], [0, 0, 0], DECK),
    placed(new THREE.CylinderGeometry(0.011, 0.011, 0.1, 8), '#c9c3d6', [-0.32, 0.09, 0.02], [0, 0, 0], DECK),
    placed(new THREE.SphereGeometry(0.034, 12, 8), '#ff2d55', [-0.32, 0.145, 0.02], [0, 0, 0], DECK),
    ...['#3df5ff', '#ffe53d', '#3dff8b'].map((c, i) => placed(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 14), c, [-0.17 + i * 0.075, 0.045, i === 1 ? -0.01 : 0.03], [0, 0, 0], DECK)),
    placed(new THREE.BoxGeometry(0.05, 0.015, 0.03), '#f4ecff', [-0.05, 0.043, -0.13], [0, 0, 0], DECK),
    placed(new THREE.BoxGeometry(0.05, 0.015, 0.03), CLAUDE, [0.05, 0.043, -0.13], [0, 0, 0], DECK),
    placed(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 16), '#0b0710', [0.3, 0.041, 0.02], [0, 0, 0], DECK),
  ]
  const shell = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())

  // neon trim along both front edges, a kick strip, the marquee's underline and the coin slots
  const path = new THREE.CurvePath<THREE.Vector3>()
  const edge = PROFILE.slice(0, 9).slice(1)
  for (let i = 0; i < edge.length - 1; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(0, edge[i][1], edge[i][0] + 0.012), new THREE.Vector3(0, edge[i + 1][1], edge[i + 1][0] + 0.012)))
  const tube = () => new THREE.TubeGeometry(path, 120, 0.014, 6, false)
  const glow = [
    placed(tube(), '#ffffff', [W / 2 + 0.025, 0, 0]),
    placed(tube(), '#ffffff', [-W / 2 - 0.025, 0, 0]),
    placed(new THREE.BoxGeometry(W - 0.02, 0.024, 0.02), '#ffffff', [0, 0.05, 0.37]),
    placed(new THREE.BoxGeometry(W, 0.02, 0.02), '#ffffff', [0, 2.115, 0.225]),
    placed(new THREE.BoxGeometry(0.025, 0.07, 0.01), '#ffffff', [-0.07, 0.57, 0.385]),
    placed(new THREE.BoxGeometry(0.025, 0.07, 0.01), '#ffffff', [0.07, 0.57, 0.385]),
  ]
  const neon = mergeGeometries(glow)!
  glow.forEach((p) => p.dispose())
  shared = { shell, neon }
  return shared
}

// marquee bulbs, in loop order: top row, right side, bottom row, left side
const BULBS: V3[] = [
  ...Array.from({ length: 8 }, (_, i): V3 => [-0.48 + i * 0.137, 2.445, 0.23]),
  [0.53, 2.34, 0.23],
  [0.53, 2.24, 0.23],
  ...Array.from({ length: 8 }, (_, i): V3 => [0.48 - i * 0.137, 2.135, 0.23]),
  [-0.53, 2.24, 0.23],
  [-0.53, 2.34, 0.23],
]

// --- screens --------------------------------------------------------------------------------------

const SW = 160
const SH = 120
export type ScreenMode = 'attract' | 'quiet' | 'loading' | 'levelup' | 'gameover' | 'nosignal' | 'highscore'

export function screenMode(s: Signals, p: Project): ScreenMode {
  if (s.down) return 'nosignal'
  if (s.broken) return 'gameover'
  if (s.deploying) return 'levelup'
  if (s.building) return 'loading'
  if (s.fresh) return 'highscore'
  if (p.status === 'quiet') return 'quiet'
  return 'attract'
}

const INVADER = ['..X.....X..', '...X...X...', '..XXXXXXX..', '.XX.XXX.XX.', 'XXXXXXXXXXX', 'X.XXXXXXX.X', 'X.X.....X.X', '...XX.XX...']
const INVADER_B = ['..X.....X..', 'X..X...X..X', 'X.XXXXXXX.X', 'XXX.XXX.XXX', 'XXXXXXXXXXX', '.XXXXXXXXX.', '..X.....X..', '.X.......X.']

function sprite(g: CanvasRenderingContext2D, rows: string[], x: number, y: number, px: number, color: string) {
  g.fillStyle = color
  rows.forEach((r, j) => {
    for (let i = 0; i < r.length; i++) if (r[i] === 'X') g.fillRect(x + i * px, y + j * px, px, px)
  })
}

function say(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center') {
  g.font = `${size}px ${PX}`
  g.textAlign = align
  g.textBaseline = 'top'
  g.fillStyle = color
  g.fillText(s, x, y)
}

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}.` : s)
const frac = (x: number) => x - Math.floor(x)

function stars(g: CanvasRenderingContext2D, t: number, seed: number, speed: number) {
  for (let i = 0; i < 36; i++) {
    const a = frac(Math.sin((i + seed) * 12.9898) * 43758.5453)
    const b = frac(Math.sin((i + seed) * 78.233) * 12345.678)
    g.fillStyle = b > 0.7 ? '#ffffff' : '#4d3f6b'
    g.fillRect(Math.floor((a * SW + t * speed * (0.4 + b)) % SW), Math.floor(14 + b * (SH - 28)), 1, 1)
  }
}

function skyline(g: CanvasRenderingContext2D, p: Project, t: number) {
  const act = p.activity.length ? p.activity : [0]
  const max = Math.max(1, ...act)
  const n = act.length
  const bw = Math.floor((SW - 16) / n)
  const x0 = Math.floor((SW - bw * n) / 2)
  const base = SH - 30
  const tops: number[] = []
  act.forEach((v, i) => {
    const h = 3 + Math.round((v / max) * 40)
    tops.push(base - h)
    g.globalAlpha = i === n - 1 ? 1 : 0.5 + 0.5 * (i / n)
    g.fillStyle = p.accent
    g.fillRect(x0 + i * bw, base - h, bw - 1, h)
  })
  g.globalAlpha = 1
  g.fillStyle = '#3df5ff'
  g.fillRect(4, base, SW - 8, 1)
  // a little runner hops along the rooftops
  const u = frac(t * 0.08)
  const xi = Math.min(n - 1, Math.floor(u * n))
  const x = Math.floor(x0 + u * n * bw)
  const y = Math.floor(tops[xi] - 6 - Math.abs(Math.sin(t * 8)) * 3)
  g.fillStyle = '#ffffff'
  g.fillRect(x, y, 3, 4)
  g.fillRect(x + 1, y - 2, 2, 2)
}

function rainbow(g: CanvasRenderingContext2D, s: string, y: number, size: number, t: number) {
  g.font = `${size}px ${PX}`
  g.textAlign = 'left'
  g.textBaseline = 'top'
  const x = (SW - s.length * size) / 2
  for (let i = 0; i < s.length; i++) {
    g.fillStyle = `hsl(${Math.floor(i * 40 + t * 200) % 360} 100% 62%)`
    g.fillText(s[i], x + i * size, y)
  }
}

export function drawScreen(g: CanvasRenderingContext2D, p: Project, s: Signals, mode: ScreenMode, t: number) {
  const name = p.name.toUpperCase()
  g.globalAlpha = 1
  g.fillStyle = '#04010a'
  g.fillRect(0, 0, SW, SH)
  switch (mode) {
    case 'attract': {
      stars(g, t, 1, 6)
      say(g, fit(name, 18), SW / 2, 16, 8, p.accent)
      say(g, `SCORE ${String(p.commitsWeek * 100).padStart(6, '0')}`, SW / 2, 29, 8, '#ffffff')
      skyline(g, p, t)
      g.globalAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 2.4))
      say(g, s.attention ? 'PLAYER NEEDED' : 'PRESS START', SW / 2, SH - 24, 8, s.attention ? '#ff9d3d' : '#ffe53d')
      break
    }
    case 'quiet': {
      stars(g, t, 2, 3)
      g.globalAlpha = 0.6
      say(g, fit(name, 18), SW / 2, 30, 8, p.accent)
      say(g, fit(`LAST PLAYED ${relTime(p.pushedAt).toUpperCase()}`, 19), SW / 2, 46, 8, '#8a7aa8')
      g.globalAlpha = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * 1.5))
      say(g, 'INSERT COIN', SW / 2, 76, 8, '#ffe53d')
      break
    }
    case 'loading': {
      say(g, `NOW LOADING${'.'.repeat(Math.floor(t * 2) % 4)}`, 20, 22, 8, '#ffe53d', 'left')
      const run = p.runs.find((r) => r.status === 'running' || r.status === 'queued')
      say(g, fit((run?.name ?? 'BUILD').toUpperCase(), 18), SW / 2, 38, 8, '#c18fe0')
      g.strokeStyle = '#ffe53d'
      g.lineWidth = 2
      g.strokeRect(17, 56, 126, 14)
      const k = frac(t * 0.14)
      g.fillStyle = '#ffe53d'
      for (let i = 0; i < Math.floor(k * 15); i++) g.fillRect(21 + i * 8, 59, 6, 8)
      say(g, `${Math.floor(k * 100)}%`, SW / 2, 76, 8, '#ffffff')
      say(g, fit(name, 18), SW / 2, SH - 24, 8, p.accent)
      break
    }
    case 'levelup': {
      g.lineWidth = 4
      for (let i = 0; i < 4; i++) {
        const y = SH + 10 - ((t * 36 + i * 34) % (SH + 30))
        g.globalAlpha = 0.18 + 0.08 * i
        g.strokeStyle = GREEN
        g.beginPath()
        g.moveTo(SW / 2 - 34, y + 16)
        g.lineTo(SW / 2, y)
        g.lineTo(SW / 2 + 34, y + 16)
        g.stroke()
      }
      g.globalAlpha = 1
      say(g, 'LEVEL UP!', SW / 2, 28 + Math.round(Math.sin(t * 3) * 2), 16, GREEN)
      say(g, 'SHIPPING TO', SW / 2, 58, 8, '#ffffff')
      say(g, fit((p.host ?? domainOf(p)).toUpperCase(), 18), SW / 2, 72, 8, '#3df5ff')
      break
    }
    case 'gameover': {
      // slow pulse, never a flash
      const k = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.6))
      g.fillStyle = `rgba(255,45,85,${0.1 * k})`
      g.fillRect(0, 0, SW, SH)
      g.globalAlpha = k
      say(g, 'GAME', SW / 2, 18, 16, RED)
      say(g, 'OVER', SW / 2, 38, 16, RED)
      g.globalAlpha = 1
      say(g, `CONTINUE? ${9 - (Math.floor(t) % 10)}`, SW / 2, 64, 8, '#ffffff')
      say(g, fit(p.reason.toUpperCase(), 19), SW / 2, 80, 8, '#c18fe0')
      break
    }
    case 'nosignal': {
      for (let i = 0; i < 240; i++) {
        g.fillStyle = `rgba(160,150,190,${Math.random() * 0.2})`
        g.fillRect((Math.random() * SW) | 0, (Math.random() * SH) | 0, 2, 1)
      }
      say(g, 'NO SIGNAL', SW / 2, 54, 8, '#8a7aa8')
      break
    }
    case 'highscore': {
      rainbow(g, 'NEW HIGH', 18, 16, t)
      rainbow(g, 'SCORE!', 38, 16, t + 0.4)
      say(g, String(p.commitsWeek * 100).padStart(6, '0'), SW / 2, 62, 8, '#ffffff')
      const d = p.deployments.find((x) => x.state === 'success')
      say(g, fit(`SHIPPED ${relTime(d?.created).toUpperCase()}`, 19), SW / 2, 76, 8, '#3dff8b')
      say(g, fit(name, 18), SW / 2, SH - 24, 8, p.accent)
      break
    }
  }
  g.globalAlpha = 1
  if (mode !== 'nosignal') {
    // top HUD: credits are pull requests waiting, invaders are open issues
    if (s.prs) say(g, `CREDIT ${s.prs}`, 4, 3, 8, '#3df5ff', 'left')
    if (s.issues) {
      const label = `x${s.issues}`
      say(g, label, SW - 3, 3, 8, s.bugs ? '#ff3d5e' : '#ff9d3d', 'right')
      sprite(g, Math.floor(t * 2) % 2 ? INVADER : INVADER_B, SW - 3 - label.length * 8 - 14, 3, 1, s.bugs ? '#ff3d5e' : '#ff9d3d')
    }
    if (s.claude) {
      g.fillStyle = 'rgba(217,119,87,0.18)'
      g.fillRect(0, SH - 12, SW, 12)
      say(g, '2P CLAUDE PLAYING', SW / 2, SH - 10, 8, CLAUDE)
    }
  }
  // scanlines
  g.fillStyle = 'rgba(0,0,0,0.22)'
  for (let y = 1; y < SH; y += 2) g.fillRect(0, y, SW, 1)
}

function useScreen() {
  const res = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = SW
    c.height = SH
    const g = c.getContext('2d')!
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.LinearMipmapLinearFilter
    return { g, tex }
  }, [])
  useEffect(() => () => res.tex.dispose(), [res])
  return res
}

function hexA(hex: string, a: number) {
  const c = new THREE.Color(hex)
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
}

function drawMarquee(c: HTMLCanvasElement, p: Project) {
  const MW = 512
  const MH = 128
  c.width = MW
  c.height = MH
  const g = c.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, 0, MH)
  grd.addColorStop(0, '#12021f')
  grd.addColorStop(1, hexA(p.accent, 0.55))
  g.fillStyle = grd
  g.fillRect(0, 0, MW, MH)
  // sunburst behind the title
  g.save()
  g.translate(MW / 2, MH * 1.15)
  g.fillStyle = hexA(p.accent, 0.18)
  for (let i = 0; i < 13; i++) {
    g.save()
    g.rotate(-Math.PI / 2 + ((i - 6) * Math.PI) / 13)
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(MH * 2, -14)
    g.lineTo(MH * 2, 14)
    g.fill()
    g.restore()
  }
  g.restore()
  const text = p.name.toUpperCase()
  let size = 40
  g.font = `${size}px ${PX}`
  while (g.measureText(text).width > MW - 48 && size > 12) {
    size -= 2
    g.font = `${size}px ${PX}`
  }
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.shadowColor = p.accent
  g.shadowBlur = 18
  g.fillStyle = '#ffffff'
  g.fillText(text, MW / 2, MH / 2 + 3)
  g.shadowBlur = 0
  g.lineWidth = 1.5
  g.strokeStyle = p.accent
  g.strokeText(text, MW / 2, MH / 2 + 3)
}

function useMarquee(p: Project) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    drawMarquee(c, p)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [p.name, p.accent]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => tex.dispose(), [tex])
  useEffect(() => {
    document.fonts.load(`32px ${PX}`).then(() => {
      drawMarquee(tex.image as HTMLCanvasElement, p)
      tex.needsUpdate = true
    })
  }, [tex]) // eslint-disable-line react-hooks/exhaustive-deps
  return tex
}

// shared textures: an invader sprite sheet (two frames) and the OUT OF ORDER sign
let invaderTex: THREE.CanvasTexture | null = null
function invaderSheet() {
  if (invaderTex) return invaderTex
  const c = document.createElement('canvas')
  c.width = 24
  c.height = 8
  const g = c.getContext('2d')!
  sprite(g, INVADER, 0, 0, 1, '#ffffff')
  sprite(g, INVADER_B, 12, 0, 1, '#ffffff')
  invaderTex = new THREE.CanvasTexture(c)
  invaderTex.magFilter = THREE.NearestFilter
  invaderTex.minFilter = THREE.NearestFilter
  invaderTex.generateMipmaps = false
  invaderTex.repeat.set(0.5, 1)
  return invaderTex
}

let signTex: THREE.CanvasTexture | null = null
function drawSign(c: HTMLCanvasElement) {
  c.width = 256
  c.height = 124
  const g = c.getContext('2d')!
  g.fillStyle = '#efe6c8'
  g.fillRect(0, 0, 256, 124)
  g.fillStyle = 'rgba(120,90,40,0.12)'
  for (let i = 0; i < 40; i++) g.fillRect((i * 53) % 256, (i * 31) % 124, 6, 2)
  g.fillStyle = '#1a1a1a'
  g.font = '900 40px Archivo, Impact, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('OUT OF', 128, 42)
  g.fillText('ORDER', 128, 88)
  g.fillStyle = 'rgba(255,255,255,0.6)'
  g.fillRect(0, 0, 44, 16)
  g.fillRect(212, 108, 44, 16)
}
function outOfOrder() {
  if (signTex) return signTex
  const c = document.createElement('canvas')
  drawSign(c)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  signTex = t
  document.fonts.load('900 40px Archivo').then(() => {
    drawSign(c)
    t.needsUpdate = true
  })
  return t
}

// --- shaders --------------------------------------------------------------------------------------

const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

// light from the screen spilling onto the floor
const spillFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main(){
    vec2 p = (vUv - vec2(0.5, 0.62)) * vec2(1.0, 1.2);
    float a = exp(-dot(p, p) * 9.0) * uAlpha;
    gl_FragColor = vec4(uColor * a, a);
  }`

// a ring that runs out across the floor on events
const ringFrag = /* glsl */ `
  uniform float uK; uniform vec3 uColor; varying vec2 vUv;
  void main(){
    float r = length(vUv - 0.5) * 2.0;
    float a = smoothstep(uK - 0.08, uK, r) * (1.0 - smoothstep(uK, uK + 0.03, r)) * (1.0 - uK);
    gl_FragColor = vec4(uColor * a * 1.6, a);
  }`

// LEVEL UP: bands of light climbing out of the cabinet
const beamFrag = /* glsl */ `
  uniform float uTime; uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;
  void main(){
    float c = fract(vUv.y * 5.0 - uTime * 1.1);
    float band = smoothstep(0.0, 0.12, c) * (1.0 - smoothstep(0.3, 0.45, c));
    float a = (0.2 + band * 0.8) * pow(1.0 - vUv.y, 1.4) * uAlpha * 0.5;
    gl_FragColor = vec4(uColor * a, a);
  }`

// --- one cabinet ----------------------------------------------------------------------------------

interface Kit {
  shell: THREE.BufferGeometry
  neon: THREE.BufferGeometry
  body: THREE.Material
  invader: THREE.MeshBasicMaterial
  sign: THREE.Material
  coin: THREE.Material
  plane: THREE.PlaneGeometry
}

export const frustum = new THREE.Frustum()
const _pm = new THREE.Matrix4()
const _o = new THREE.Object3D()
const _c = new THREE.Color()

function Cabinet({ slot, impulses, kit, tier, tight }: { slot: Slot; impulses: Impulses; kit: Kit; tier: Tier; tight: boolean }) {
  const { project } = slot
  const id = project.id
  const sig = signals(project)
  const mode = screenMode(sig, project)
  const hover = useApp((s) => s.hover)
  const select = useApp((s) => s.select)
  const screen = useScreen()
  const marquee = useMarquee(project)

  const mats = useMemo(
    () => ({
      neon: new THREE.MeshBasicMaterial({ color: project.accent, toneMapped: false }),
      screen: new THREE.MeshBasicMaterial({ map: screen.tex, toneMapped: false }),
      marquee: new THREE.MeshBasicMaterial({ map: marquee, toneMapped: false }),
      spill: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: spillFrag, uniforms: { uColor: { value: new THREE.Color(project.accent) }, uAlpha: { value: 0.5 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      ring: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: ringFrag, uniforms: { uK: { value: 1 }, uColor: { value: new THREE.Color('#fff') } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      beam: new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: beamFrag, uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(GREEN) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  useEffect(() => {
    mats.marquee.map = marquee
    mats.marquee.needsUpdate = true
  }, [marquee, mats])
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])

  const p2 = useRef<THREE.Group>(null!)
  const claude = useRef<THREE.Group>(null!)
  const bugs = useRef<THREE.InstancedMesh>(null!)
  const beam = useRef<THREE.Mesh>(null!)
  const ring = useRef<THREE.Mesh>(null!)
  const centre = useMemo(() => new THREE.Vector3(slot.x, 1.4, slot.z), [slot.x, slot.z])
  const sphere = useMemo(() => new THREE.Sphere(centre, 1.6), [centre])
  const drawn = useRef(-1)
  const dirty = useRef(true)
  const cols = useMemo(() => ({ accent: new THREE.Color(project.accent), amber: new THREE.Color(AMBER), green: new THREE.Color(GREEN), red: new THREE.Color(RED), off: new THREE.Color('#2a1d3a'), white: new THREE.Color('#ffffff') }), [project.accent])

  useEffect(() => {
    dirty.current = true
  }, [mode, project])
  useEffect(() => {
    document.fonts.load(`8px ${PX}`).then(() => (dirty.current = true))
  }, [])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const app = useApp.getState()
    const active = app.hoveredId === id || app.selectedId === id
    const seen = frustum.intersectsSphere(sphere)

    // redraw the screen a few times a second, and only while it's on screen
    const fps = tier === 'battery' ? 4 : mode === 'quiet' ? 4 : 8
    if (dirty.current || (seen && t - drawn.current > 1 / fps)) {
      drawScreen(screen.g, project, sig, mode, prefersReducedMotion ? 0 : t)
      screen.tex.needsUpdate = true
      drawn.current = t
      dirty.current = false
    }
    if (!seen) return

    // neon trim: accent when all's well, amber building, green shipping, a slow red pulse when broken, dark when down
    const slow = 0.5 + 0.5 * Math.sin(t * 1.6)
    if (sig.down) _c.copy(cols.off)
    else if (sig.broken) _c.copy(cols.red).multiplyScalar(0.55 + 0.6 * slow)
    else if (sig.deploying) _c.copy(cols.green).multiplyScalar(1.2)
    else if (sig.building) _c.copy(cols.amber).multiplyScalar(1.2)
    else _c.copy(cols.accent).multiplyScalar(project.status === 'quiet' ? 0.7 : 1.25)
    if (active) _c.multiplyScalar(1.5)
    mats.neon.color.lerp(_c, 1 - Math.exp(-dt * 6))
    mats.screen.color.setScalar(sig.down ? 0.55 : active ? 1.25 : 1.05)
    mats.marquee.color.setScalar(sig.down ? 0.2 : sig.broken ? 0.55 + 0.25 * slow : active ? 1.35 : 1)

    // screen light on the floor
    const spill = sig.down ? cols.off : sig.broken ? cols.red : sig.deploying ? cols.green : sig.building ? cols.amber : cols.accent
    mats.spill.uniforms.uColor.value.lerp(spill, 1 - Math.exp(-dt * 4))
    mats.spill.uniforms.uAlpha.value = damp(mats.spill.uniforms.uAlpha.value, sig.down ? 0.05 : (active ? 0.8 : 0.5) * (sig.broken ? 0.6 + 0.4 * slow : 1), 4, dt)

    // event ring on the floor
    const k = since(impulses, id, t) / 1.8
    ring.current.visible = k < 1
    if (k < 1) {
      mats.ring.uniforms.uK.value = k
      mats.ring.uniforms.uColor.value.set(LEVEL[impulses.get(id)!.level])
    }

    // LEVEL UP beam while deploying
    mats.beam.uniforms.uAlpha.value = damp(mats.beam.uniforms.uAlpha.value, sig.deploying ? 1 : 0, 2, dt)
    mats.beam.uniforms.uTime.value = t
    beam.current.visible = mats.beam.uniforms.uAlpha.value > 0.01

    // player 2 is Claude: stick wiggles, the player bobs
    claude.current.visible = sig.claude
    if (sig.claude && !prefersReducedMotion) {
      p2.current.rotation.set(Math.sin(t * 7.3) * 0.35, 0, Math.sin(t * 5.1) * 0.35)
      claude.current.position.y = Math.abs(Math.sin(t * 4)) * 0.03
      claude.current.rotation.z = Math.sin(t * 2.2) * 0.04
    } else p2.current.rotation.set(0, 0, 0)

    // invaders march over the marquee, one per open issue (red ones are bugs)
    const n = Math.min(8, sig.issues)
    bugs.current.count = n
    if (n) {
      const step = prefersReducedMotion ? 2 : Math.floor(t * 2) % 8
      const march = ((step < 4 ? step : 8 - step) - 2) * 0.04
      const perRow = Math.min(4, n)
      for (let i = 0; i < n; i++) {
        const col = i % 4
        const row = Math.floor(i / 4)
        _o.position.set((col - (perRow - 1) / 2) * 0.3 + march, 2.8 + row * 0.22, 0.12)
        _o.scale.set(0.22, 0.16, 1)
        _o.updateMatrix()
        bugs.current.setMatrixAt(i, _o.matrix)
        _c.set(i < sig.bugs ? '#ff3d5e' : '#ff9d3d').multiplyScalar(1.5)
        bugs.current.setColorAt(i, _c)
      }
      bugs.current.instanceMatrix.needsUpdate = true
      if (bugs.current.instanceColor) bugs.current.instanceColor.needsUpdate = true
    }
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 6) return
    select(useApp.getState().selectedId === id ? null : id)
  }

  const coins = Math.min(6, sig.prs)

  return (
    <group position={[slot.x, 0, slot.z]} rotation={[0, -slot.angle, 0]}>
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
        <mesh geometry={kit.shell} material={kit.body} />
        <mesh geometry={kit.neon} material={mats.neon} raycast={noRay} />
        <mesh material={mats.screen} position={[0, 1.655, 0.104]}>
          <planeGeometry args={[0.88, 0.66]} />
        </mesh>
        <mesh material={mats.marquee} position={[0, 2.29, 0.222]}>
          <planeGeometry args={[W - 0.08, 0.26]} />
        </mesh>
        {sig.down && <mesh material={kit.sign} geometry={kit.plane} position={[0, 1.63, 0.12]} rotation={[0, 0, 0.16]} scale={[0.62, 0.3, 1]} raycast={noRay} />}
      </group>

      {/* player 2's stick on the control panel */}
      <group position={DECK_POS} rotation={DECK_ROT}>
        <group ref={p2} position={[0.3, 0.045, 0.02]}>
          <mesh position={[0, 0.045, 0]} raycast={noRay}>
            <cylinderGeometry args={[0.011, 0.011, 0.09, 8]} />
            <meshBasicMaterial color="#c9c3d6" />
          </mesh>
          <mesh position={[0, 0.1, 0]} raycast={noRay}>
            <sphereGeometry args={[0.034, 12, 8]} />
            <meshBasicMaterial color={CLAUDE} toneMapped={false} />
          </mesh>
        </group>
        {coins > 0 && (
          <mesh material={kit.coin} position={[0.15, 0.035 + coins * 0.007, -0.12]} scale={[1, coins * 0.014, 1]} raycast={noRay}>
            <cylinderGeometry args={[0.036, 0.036, 1, 16]} />
          </mesh>
        )}
      </group>

      {/* Claude, standing at the cabinet as player 2 */}
      <group ref={claude} position={[0.7, 0, 0.62]} visible={false}>
        <mesh position={[0, 0.4, 0]} raycast={noRay}>
          <capsuleGeometry args={[0.13, 0.46, 4, 12]} />
          <meshLambertMaterial color={CLAUDE} />
        </mesh>
        <mesh position={[0, 0.92, 0]} raycast={noRay}>
          <sphereGeometry args={[0.13, 16, 12]} />
          <meshLambertMaterial color="#f3d2b5" />
        </mesh>
        <mesh position={[0, 1.02, 0]} rotation={[0, 0, 0.12]} raycast={noRay}>
          <cylinderGeometry args={[0.135, 0.135, 0.06, 16]} />
          <meshLambertMaterial color="#b5573a" />
        </mesh>
      </group>

      <instancedMesh ref={bugs} args={[kit.plane, kit.invader, 8]} scale={[1, 1, 1]} frustumCulled={false} raycast={noRay}>
        <instancedBufferAttribute attach="instanceColor" args={[new Float32Array(8 * 3), 3]} />
      </instancedMesh>

      <mesh material={mats.spill} position={[0, 0.012, 0.75]} rotation={[-Math.PI / 2, 0, 0]} scale={[2.6, 2.6, 1]} raycast={noRay}>
        <planeGeometry />
      </mesh>
      <mesh ref={ring} material={mats.ring} position={[0, 0.02, 0.2]} rotation={[-Math.PI / 2, 0, 0]} scale={[5, 5, 1]} visible={false} raycast={noRay}>
        <planeGeometry />
      </mesh>
      <mesh ref={beam} material={mats.beam} position={[0, 2.46 + 2.6, -0.1]} visible={false} raycast={noRay}>
        <cylinderGeometry args={[0.38, 0.56, 5.2, 24, 1, true]} />
      </mesh>

      {/* on narrow screens every other plate goes above the marquee so neighbours never collide */}
      <Anchor id={`lbl-ar-${id}`} position={tight && slot.index % 2 ? [0, 3.42, 0.1] : [0, 0.02, 0.95]} />
    </group>
  )
}

// --- marquee bulbs for every cabinet, in one draw call --------------------------------------------

function Bulbs({ slots, impulses }: { slots: Slot[]; impulses: Impulses }) {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const count = slots.length * BULBS.length
  const geo = useMemo(() => new THREE.SphereGeometry(0.024, 8, 6), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), [])
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat])
  const state = useMemo(() => slots.map((s) => ({ id: s.project.id, sig: signals(s.project), quiet: s.project.status === 'quiet', accent: new THREE.Color(s.project.accent) })), [slots])
  const tones = useMemo(() => ({ amber: new THREE.Color(AMBER), green: new THREE.Color(GREEN), red: new THREE.Color(RED), off: new THREE.Color('#1a1024'), white: new THREE.Color('#ffffff'), level: new THREE.Color() }), [])

  useEffect(() => {
    slots.forEach((s, i) => {
      BULBS.forEach((b, j) => {
        const c = Math.cos(-s.angle)
        const sn = Math.sin(-s.angle)
        // rotate the local bulb position by the cabinet's turn, then move it into place
        _o.position.set(s.x + b[0] * c + b[2] * sn, b[1], s.z - b[0] * sn + b[2] * c)
        _o.updateMatrix()
        mesh.current.setMatrixAt(i * BULBS.length + j, _o.matrix)
      })
    })
    mesh.current.instanceMatrix.needsUpdate = true
  }, [slots])

  useFrame((s) => {
    const t = prefersReducedMotion ? 0 : s.clock.elapsedTime
    const app = useApp.getState()
    state.forEach((st, i) => {
      const k = since(impulses, st.id, s.clock.elapsedTime)
      const boost = app.hoveredId === st.id || app.selectedId === st.id ? 1.4 : 1
      if (k < 3.5) tones.level.set(LEVEL[impulses.get(st.id)!.level])
      for (let j = 0; j < BULBS.length; j++) {
        let v = 1
        const sg = st.sig
        if (sg.down) {
          _c.copy(tones.off)
        } else if (k < 3.5) {
          // something just happened: lights race round fast in the event's colour
          _c.copy(tones.level)
          v = (((j - Math.floor(t * 16)) % 4) + 4) % 4 < 2 ? 2.2 : 0.25
        } else if (sg.broken) {
          _c.copy(tones.red)
          v = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.6))
        } else if (sg.building) {
          _c.copy(tones.amber)
          v = (((j - Math.floor(t * 7)) % 5) + 5) % 5 < 2 ? 1.8 : 0.3
        } else if (sg.deploying) {
          _c.copy(tones.green)
          v = (((j - Math.floor(t * 9)) % 4) + 4) % 4 < 2 ? 1.8 : 0.3
        } else if (st.quiet) {
          _c.copy(st.accent)
          v = 0.35
        } else {
          // attract mode: a gentle alternating twinkle
          const on = (j + Math.floor(t * 2)) % 2 === 0
          _c.copy(on ? st.accent : tones.white)
          v = on ? 1.5 : 0.6
        }
        mesh.current.setColorAt(i * BULBS.length + j, _c.multiplyScalar(v * boost))
      }
    })
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh key={count} ref={mesh} args={[geo, mat, Math.max(1, count)]} frustumCulled={false} raycast={noRay}>
      <instancedBufferAttribute attach="instanceColor" args={[new Float32Array(Math.max(1, count) * 3), 3]} />
    </instancedMesh>
  )
}

// --- high-score fireworks when something ships ----------------------------------------------------

const FW = 900
const fwVert = /* glsl */ `
  attribute vec3 aColor; attribute float aLife; uniform float uScale;
  varying vec3 vC; varying float vA;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = clamp(aLife, 0.0, 1.0);
    vC = aColor;
    gl_PointSize = aLife > 0.0 ? (0.05 + 0.08 * vA) * uScale / -mv.z : 0.0;
  }`
const fwFrag = /* glsl */ `
  varying vec3 vC; varying float vA;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vA;
    gl_FragColor = vec4(vC * a * 1.8, a);
  }`

export interface FireworksApi {
  show: (x: number, z: number, at: number) => void
}

function Fireworks({ api }: { api: MutableRefObject<FireworksApi | null> }) {
  const sys = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(FW * 3)
    const col = new Float32Array(FW * 3)
    const life = new Float32Array(FW)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage))
    const mat = new THREE.ShaderMaterial({ vertexShader: fwVert, fragmentShader: fwFrag, uniforms: { uScale: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    return { geo, mat, pos, col, life, vel: new Float32Array(FW * 3), left: new Float32Array(FW), span: new Float32Array(FW).fill(1), next: 0, queue: [] as { at: number; x: number; y: number; z: number; hue: number }[] }
  }, [])
  useEffect(() => () => (sys.geo.dispose(), sys.mat.dispose()), [sys])

  useEffect(() => {
    api.current = {
      show: (x, z, at) => {
        if (prefersReducedMotion) return
        for (let b = 0; b < 3; b++) sys.queue.push({ at: at + b * 0.45, x: x + (Math.random() - 0.5) * 1.6, y: 3.6 + Math.random() * 1.2, z: z + (Math.random() - 0.5) * 0.8, hue: Math.random() })
      },
    }
    return () => {
      api.current = null
    }
  }, [api, sys])

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const cam = s.camera as THREE.PerspectiveCamera
    sys.mat.uniforms.uScale.value = (s.size.height * s.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360))
    for (let q = sys.queue.length - 1; q >= 0; q--) {
      const b = sys.queue[q]
      if (b.at > t) continue
      sys.queue.splice(q, 1)
      const a = new THREE.Color().setHSL(b.hue, 1, 0.6)
      const c2 = new THREE.Color().setHSL((b.hue + 0.15) % 1, 1, 0.7)
      for (let i = 0; i < 110; i++) {
        const p = sys.next
        sys.next = (sys.next + 1) % FW
        const u = Math.random() * 2 - 1
        const th = Math.random() * Math.PI * 2
        const r = Math.sqrt(1 - u * u)
        const sp = 1.8 + Math.random() * 1.1
        sys.pos.set([b.x, b.y, b.z], p * 3)
        sys.vel.set([r * Math.cos(th) * sp, u * sp + 0.5, r * Math.sin(th) * sp], p * 3)
        const c = i % 3 ? a : c2
        sys.col.set([c.r, c.g, c.b], p * 3)
        sys.span[p] = sys.left[p] = 1.2 + Math.random() * 0.7
      }
    }
    let any = false
    for (let i = 0; i < FW; i++) {
      if (sys.left[i] <= 0) {
        sys.life[i] = 0
        continue
      }
      any = true
      sys.left[i] -= dt
      const drag = 1 - 1.1 * dt
      sys.vel[i * 3] *= drag
      sys.vel[i * 3 + 1] = sys.vel[i * 3 + 1] * drag - 1.4 * dt
      sys.vel[i * 3 + 2] *= drag
      sys.pos[i * 3] += sys.vel[i * 3] * dt
      sys.pos[i * 3 + 1] += sys.vel[i * 3 + 1] * dt
      sys.pos[i * 3 + 2] += sys.vel[i * 3 + 2] * dt
      sys.life[i] = Math.max(0, sys.left[i] / sys.span[i])
    }
    if (any || sys.queue.length) {
      sys.geo.attributes.position.needsUpdate = true
      sys.geo.attributes.aColor.needsUpdate = true
      sys.geo.attributes.aLife.needsUpdate = true
    }
  })
  return <points geometry={sys.geo} material={sys.mat} frustumCulled={false} />
}

// --- the room: a synthwave floor and sky ---------------------------------------------------------

const floorVert = 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }'
const floorFrag = /* glsl */ `
  uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uFog; varying vec3 vW;
  void main(){
    vec2 p = vW.xz / 1.2;
    vec2 fw = fwidth(p);
    vec2 g = abs(fract(p - 0.5) - 0.5) / fw;
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    line *= 1.0 - smoothstep(0.25, 0.8, max(fw.x, fw.y));
    float d = length(vW.xz);
    vec3 col = uBase + uLine * line * (0.35 + 0.65 * exp(-d * 0.045));
    col = mix(uFog, col, smoothstep(58.0, 16.0, d));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`

const skyVert = 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
const skyFrag = /* glsl */ `
  uniform float uTime; varying vec3 vP;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main(){
    float h = vP.y;
    float ang = atan(vP.x, -vP.z);
    vec3 top = vec3(0.004, 0.0, 0.016);
    vec3 mid = vec3(0.05, 0.004, 0.08);
    vec3 hor = vec3(0.42, 0.03, 0.28);
    vec3 col = mix(hor, mid, smoothstep(0.0, 7.0, h));
    col = mix(col, top, smoothstep(6.0, 34.0, h));
    // stars
    vec2 cell = vec2(ang * 140.0, h * 2.2);
    float r = hash(floor(cell));
    float star = step(0.986, r) * smoothstep(0.32, 0.0, length(fract(cell) - 0.5)) * smoothstep(9.0, 16.0, h);
    col += vec3(0.9, 0.85, 1.0) * star * (0.5 + 0.5 * sin(uTime * 1.4 + r * 60.0));
    // the sun, striped across its lower half
    vec2 sp = vec2(ang * 70.0, h - 8.0);
    float d = length(sp) / 10.0;
    float band = fract(sp.y * 0.42);
    float cut = sp.y < 3.0 ? step(band, clamp((3.0 - sp.y) / 16.0, 0.0, 1.0) * 0.75) : 0.0;
    float sun = (1.0 - smoothstep(0.985, 1.0, d)) * (1.0 - cut);
    vec3 sunCol = mix(vec3(1.0, 0.08, 0.42), vec3(1.0, 0.82, 0.18), smoothstep(-10.0, 10.0, sp.y));
    col += vec3(0.6, 0.04, 0.3) * exp(-d * d * 2.0) * 0.35;
    col = mix(col, sunCol, sun);
    // mountains in front of the sun
    float m = 2.2 + 2.6 * abs(sin(ang * 4.0 + 0.6)) * (0.6 + 0.4 * sin(ang * 9.0)) + 0.8 * sin(ang * 17.0 + 1.3);
    if (h < m) {
      col = vec3(0.025, 0.004, 0.05);
      col += vec3(1.0, 0.24, 0.94) * smoothstep(0.18, 0.0, m - h) * 0.9;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`

function Room() {
  const floor = useMemo(() => new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: { uBase: { value: new THREE.Color('#0b0216') }, uLine: { value: new THREE.Color('#ff3df0').multiplyScalar(0.75) }, uFog: { value: new THREE.Color('#14031f') } } }), [])
  const sky = useMemo(() => new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: { uTime: { value: 0 } }, side: THREE.BackSide, depthWrite: false }), [])
  useEffect(() => () => (floor.dispose(), sky.dispose()), [floor, sky])
  useFrame((s) => (sky.uniforms.uTime.value = s.clock.elapsedTime))
  return (
    <>
      <mesh material={sky} position={[0, 0, 0]} raycast={noRay} renderOrder={-1}>
        <cylinderGeometry args={[70, 70, 80, 64, 1, true]} />
      </mesh>
      <mesh material={floor} rotation={[-Math.PI / 2, 0, 0]} raycast={noRay}>
        <circleGeometry args={[70, 64]} />
      </mesh>
    </>
  )
}

// --- camera ---------------------------------------------------------------------------------------

function rotY(v: THREE.Vector3, a: number) {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const x = v.x * c + v.z * s
  v.z = -v.x * s + v.z * c
  v.x = x
  return v
}

function Rig({ slots, radius, span, pointer }: { slots: Slot[]; radius: number; span: number; pointer: MutableRefObject<{ x: number; y: number }> }) {
  const { camera, gl, size } = useThree()
  const yaw = useRef(0)
  const yawGoal = useRef(0)
  const zoom = useRef(1)
  const offset = useRef(0)
  const pos = useMemo(() => new THREE.Vector3(0, 8, 26), [])
  const look = useMemo(() => new THREE.Vector3(0, 1.3, -6), [])
  const goalPos = useMemo(() => new THREE.Vector3(), [])
  const goalLook = useMemo(() => new THREE.Vector3(), [])
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const spanRef = useRef(span)
  spanRef.current = span

  useEffect(() => {
    const el = gl.domElement
    let drag: number | null = null
    const down = (e: PointerEvent) => (drag = e.clientX)
    const move = (e: PointerEvent) => {
      if (drag === null) return
      const lim = spanRef.current / 2 + 0.15
      yawGoal.current = THREE.MathUtils.clamp(yawGoal.current + (e.clientX - drag) * 0.004, -lim, lim)
      drag = e.clientX
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoom.current = THREE.MathUtils.clamp(zoom.current * (1 + e.deltaY * 0.001), 0.5, 1.3)
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    // leaving a cabinet, keep looking its way
    const un = useApp.subscribe((s, prev) => {
      if (s.selectedId || !prev.selectedId) return
      const was = slotsRef.current.find((x) => x.project.id === prev.selectedId)
      if (was) yawGoal.current = THREE.MathUtils.clamp(-was.angle * 0.6, -spanRef.current / 2, spanRef.current / 2)
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
    const sel = slots.find((x) => x.project.id === useApp.getState().selectedId)
    const intro = 1 - Math.pow(1 - Math.min(1, s.clock.elapsedTime / 2.4), 3)
    yaw.current = damp(yaw.current, yawGoal.current, 3, dt)
    // the scoreboard sits on the left, so frame the arc in the space beside it
    const board = size.width > 900 ? Math.min(340, size.width * 0.24) : 0
    if (sel) {
      const fx = -Math.sin(sel.angle)
      const fz = Math.cos(sel.angle)
      goalPos.set(sel.x + fx * 6.4, 2.05, sel.z + fz * 6.4)
      goalLook.set(sel.x + fx * 0.2, 1.32, sel.z + fz * 0.2)
    } else {
      // stand back far enough to see every cabinet on the arc
      const aspect = (size.width - board) / size.height
      const hh = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * aspect)
      const ext = radius * Math.sin(span / 2) + 1.1
      const zc = Math.max(ext / (Math.tan(hh) * 0.9) - radius * Math.cos(span / 2), 7 - radius)
      const d = (zc + radius) * zoom.current
      goalPos.set(pointer.current.x * 0.5, 2.5 + d * 0.07 - pointer.current.y * 0.25, -radius + d)
      goalLook.set(0, 1.25, -radius)
      rotY(goalPos, yaw.current)
      rotY(goalLook, yaw.current)
    }
    pos.lerp(goalPos, 1 - Math.exp(-dt * 2.6))
    look.lerp(goalLook, 1 - Math.exp(-dt * 3))
    cam.position.set(pos.x, pos.y + (1 - intro) * 4, pos.z + (1 - intro) * 9)
    cam.lookAt(look)
    offset.current = damp(offset.current, sel ? Math.min(330, size.width * 0.2) : -board / 2, 3, dt)
    cam.setViewOffset(size.width, size.height, offset.current, 0, size.width, size.height)
    cam.updateMatrixWorld()
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(_pm)
  })
  return null
}

// --- the arcade -----------------------------------------------------------------------------------

export function ArcadeScene({ tier, pointer }: { tier: Tier; pointer: MutableRefObject<{ x: number; y: number }> }) {
  const { slots, radius, span } = useSlots()
  const fireworks = useRef<FireworksApi | null>(null)
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const onAny = useCallback((n: Note, at: number) => {
    if (n.level !== 'success') return
    const s = slotsRef.current.find((x) => x.project.id === n.projectId)
    if (s) fireworks.current?.show(s.x * 0.97, s.z * 0.97, at)
  }, [])
  const impulses = useImpulses(onAny)
  const size = useThree((st) => st.size)
  const board = size.width > 900 ? Math.min(340, size.width * 0.24) : 0
  const tight = ((size.width - board) * 0.8) / Math.max(1, slots.length) < 145

  const kit = useMemo<Kit>(() => {
    const g = cabinetGeometry()
    const tex = invaderSheet()
    return {
      shell: g.shell,
      neon: g.neon,
      body: tier === 'high' ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }) : new THREE.MeshLambertMaterial({ vertexColors: true }),
      invader: new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, toneMapped: false, side: THREE.DoubleSide }),
      sign: new THREE.MeshLambertMaterial({ map: outOfOrder() }),
      coin: new THREE.MeshStandardMaterial({ color: '#ffcf4a', metalness: 0.8, roughness: 0.3, emissive: '#5a3a00' }),
      plane: new THREE.PlaneGeometry(1, 1),
    }
  }, [tier])
  useEffect(() => () => [kit.body, kit.invader, kit.sign, kit.coin, kit.plane].forEach((x) => x.dispose()), [kit])

  // invaders flap between their two frames together
  useFrame((s) => {
    const tex = kit.invader.map
    if (tex) tex.offset.x = prefersReducedMotion ? 0 : (Math.floor(s.clock.elapsedTime * 2) % 2) * 0.5
  })

  return (
    <>
      <color attach="background" args={['#0b0114']} />
      <fog attach="fog" args={['#14031f', 18, 60]} />
      <hemisphereLight args={['#8a5cff', '#ff3df0', 0.7]} />
      <directionalLight position={[0, 6, 12]} intensity={1.3} color="#d9c8ff" />
      <directionalLight position={[0, 5, -14]} intensity={1.4} color="#ff3df0" />
      <Rig slots={slots} radius={radius} span={span} pointer={pointer} />
      <Room />
      {slots.map((s) => (
        <Cabinet key={s.project.id} slot={s} impulses={impulses} kit={kit} tier={tier} tight={tight} />
      ))}
      <Bulbs slots={slots} impulses={impulses} />
      <Fireworks api={fireworks} />
    </>
  )
}
