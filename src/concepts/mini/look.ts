import * as THREE from 'three'

// The Mini theme's colours and the shared pieces its scene is built from.

/** A cream city with a pale blue river, after Mini Motorways. */
export const MINI = {
  outside: '#e2dacb',
  /** the outside as it looks lit, for the sky past the ground's edge */
  beyond: '#e9e1d1',
  ground: '#efe9de',
  bank: '#c9e3ec',
  water: '#93c9e0',
  kerb: '#d5ccbd',
  road: '#fbfaf6',
  bridge: '#f4f1ea',
  rail: '#b3ab9d',
  trees: ['#68a76c', '#5a9b61', '#7ab676'],
  grass: '#a9d196',
  unit: '#f4f1ea',
  ok: '#ffffff',
  bad: '#e8574a',
  build: '#f2bd3d',
  deploy: '#4fae69',
  claude: '#8f63d6',
}

const mats = new Map<string, THREE.MeshLambertMaterial>()

/** One shared lit material per colour. */
export function lambert(color: string): THREE.MeshLambertMaterial {
  let m = mats.get(color)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color })
    mats.set(color, m)
  }
  return m
}

/** A colour mixed towards another (white to lighten, black to darken), as hex. */
export function mix(color: string, to: string, k: number): string {
  return `#${new THREE.Color(color).lerp(new THREE.Color(to), k).getHexString()}`
}

const slabs = new Map<string, THREE.BufferGeometry>()

/** A flat slab with rounded corners, w by d and h high, sitting on y = 0. */
export function slab(w: number, d: number, r: number, h: number): THREE.BufferGeometry {
  const key = `${w}:${d}:${r}:${h}`
  let g = slabs.get(key)
  if (!g) {
    const x0 = -w / 2
    const z0 = -d / 2
    const rr = Math.min(r, w / 2, d / 2)
    const s = new THREE.Shape()
    s.moveTo(x0 + rr, z0)
    s.lineTo(x0 + w - rr, z0)
    s.quadraticCurveTo(x0 + w, z0, x0 + w, z0 + rr)
    s.lineTo(x0 + w, z0 + d - rr)
    s.quadraticCurveTo(x0 + w, z0 + d, x0 + w - rr, z0 + d)
    s.lineTo(x0 + rr, z0 + d)
    s.quadraticCurveTo(x0, z0 + d, x0, z0 + d - rr)
    s.lineTo(x0, z0 + rr)
    s.quadraticCurveTo(x0, z0, x0 + rr, z0)
    // the shape is drawn on x/y; turned so y runs along z and the extrusion goes up
    g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 5 }).rotateX(Math.PI / 2).translate(0, h, 0)
    slabs.set(key, g)
  }
  return g
}

export const BOX = new THREE.BoxGeometry(1, 1, 1)

/** A pitched roof: a triangular prism along z, base on y = 0. */
export const ROOF = new THREE.CylinderGeometry(0.25, 0.25, 0.5, 3).rotateX(-Math.PI / 2).translate(0, 0.125, 0).scale(1, 0.72, 1)

export const noRay = () => null

export const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))

/** A steady 0..1 from a string, for per-tile variety that doesn't change between renders. */
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}
