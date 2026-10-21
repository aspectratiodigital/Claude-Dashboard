import { useEffect, useState } from 'react'
import { useApp, type Quality } from '../store'

// Laptop-friendly rendering. "Auto" reads the GPU name once: integrated
// graphics (Intel Iris/UHD/Arc, AMD Radeon Graphics, most laptops) get the
// Balanced tier, which caps resolution, trims effects and turns off CSS blur
// over the 3D canvas, the single most expensive thing on an integrated GPU.

export type Tier = 'high' | 'balanced' | 'battery'

export const TIERS: Record<Tier, { dpr: number; effects: 'full' | 'light' | 'none'; label: string }> = {
  high: { dpr: 2, effects: 'full', label: 'High' },
  balanced: { dpr: 1.25, effects: 'light', label: 'Balanced' },
  battery: { dpr: 1, effects: 'none', label: 'Battery saver' },
}

let detected: { tier: Tier; gpu: string } | null = null

export function detectTier(): { tier: Tier; gpu: string } {
  if (detected) return detected
  let gpu = ''
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    /* no webgl */
  }
  let tier: Tier = 'balanced'
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) tier = 'battery'
  else if (/nvidia|geforce|rtx|quadro|radeon (rx|pro)|apple m\d (pro|max|ultra)/i.test(gpu)) tier = 'high'
  else if (/apple m\d/i.test(gpu) && (navigator.hardwareConcurrency ?? 4) >= 8) tier = 'high'
  detected = { tier, gpu }
  return detected
}

let onBattery = false
let batteryWatched = false

function watchBattery(cb: () => void) {
  if (batteryWatched) return
  batteryWatched = true
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; addEventListener: (e: string, f: () => void) => void }> }
  nav.getBattery?.()
    .then((b) => {
      const sync = () => {
        onBattery = !b.charging
        cb()
      }
      sync()
      b.addEventListener('chargingchange', sync)
    })
    .catch(() => {})
}

export function resolveTier(q: Quality): Tier {
  if (q !== 'auto') return q
  const t = detectTier().tier
  return t === 'high' && onBattery ? 'balanced' : t
}

/** The active tier; also mirrors it onto <html data-tier> for CSS. */
export function useTier(): Tier {
  const q = useApp((s) => s.quality)
  const [, bump] = useState(0)
  useEffect(() => watchBattery(() => bump((n) => n + 1)), [])
  const tier = resolveTier(q)
  useEffect(() => {
    document.documentElement.dataset.tier = tier
  }, [tier])
  return tier
}
