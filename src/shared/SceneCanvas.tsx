import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Canvas, useThree, type CanvasProps } from '@react-three/fiber'
import { Bloom, EffectComposer, SMAA } from '@react-three/postprocessing'
import { useApp } from '../store'
import { TIERS, useTier, type Tier } from './quality'

// Every concept renders through this Canvas. It drives the frame loop itself so
// it can:
//  - pause completely while a fullscreen site preview covers the scene,
//  - drop to 30fps after 20s without input on laptop tiers (saves battery,
//    and the slow ambient motion looks the same),
//  - step resolution down at most twice if frames are really slipping, and
//    never flip back and forth (resizing the canvas is what caused flashes).
// Scene time keeps counting smoothly through all of that.

type Mode = 'run' | 'throttle' | 'pause'

function Driver({ mode, onSlow }: { mode: Mode; onSlow: () => void }) {
  const advance = useThree((s) => s.advance)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const slowRef = useRef(onSlow)
  slowRef.current = onSlow

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let t = 0
    let acc = 0
    // frame-time watchdog
    let n = 0
    let sum = 0
    let strikes = 0
    let cooldown = performance.now() + 6000
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      // the first rAF timestamp can be earlier than the performance.now() taken
      // when the effect ran, so clamp: scene time must never run backwards
      const raw = Math.max(0, now - last)
      last = Math.max(last, now)
      const dt = Math.min(0.1, raw / 1000)
      const m = modeRef.current
      if (m === 'pause') return
      acc += dt
      if (m === 'throttle' && acc < 1 / 30 - 0.004) return
      t += acc
      acc = 0
      advance(t)
      if (m === 'run' && now > cooldown) {
        n++
        sum += raw
        if (n >= 90) {
          const avg = sum / n
          strikes = avg > 26 ? strikes + 1 : 0
          if (strikes >= 2) {
            slowRef.current()
            strikes = 0
            cooldown = now + 8000
          }
          n = 0
          sum = 0
        }
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [advance])
  return null
}

function useIdle(ms: number) {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), ms)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), ms)
    }
    const evs = ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const
    evs.forEach((e) => window.addEventListener(e, wake, { passive: true }))
    return () => {
      window.clearTimeout(timer)
      evs.forEach((e) => window.removeEventListener(e, wake))
    }
  }, [ms])
  return idle
}

export interface SceneCanvasProps extends Omit<CanvasProps, 'children' | 'dpr' | 'frameloop'> {
  children: ReactNode
  /** postprocessing, given the active tier (return null to skip) */
  effects?: (tier: Tier) => ReactNode
  maxDpr?: number
  /** keep full frame rate even when idle (e.g. scenes with lots of walking characters) */
  alwaysSmooth?: boolean
}

export function SceneCanvas({ children, effects, maxDpr = 2, alwaysSmooth = false, gl, onCreated, ...rest }: SceneCanvasProps) {
  const tier = useTier()
  const staged = useApp((s) => !!s.stage)
  const idle = useIdle(20_000)
  const [drop, setDrop] = useState(0)
  useEffect(() => setDrop(0), [tier])
  const base = Math.min(window.devicePixelRatio || 1, TIERS[tier].dpr, maxDpr)
  const dpr = Math.max(0.75, base - drop * 0.25)
  const mode: Mode = staged ? 'pause' : idle && tier !== 'high' && !alwaysSmooth ? 'throttle' : 'run'
  const withEffects = effects && TIERS[tier].effects !== 'none'

  return (
    <Canvas
      {...rest}
      dpr={dpr}
      frameloop="never"
      onCreated={(state) => {
        if (import.meta.env.DEV) (window as unknown as { __r3f: unknown }).__r3f = state
        onCreated?.(state)
      }}
      gl={{ antialias: !withEffects, powerPreference: 'high-performance', stencil: false, ...(typeof gl === 'object' ? gl : {}) }}
    >
      <Driver mode={mode} onSlow={() => setDrop((d) => (d < 2 && base - (d + 1) * 0.25 >= 0.75 ? d + 1 : d))} />
      {children}
      {withEffects ? effects(tier) : null}
    </Canvas>
  )
}

/**
 * The bloom pass every concept shares. No MSAA inside the composer (it turned
 * the brightest pixels into white blobs); SMAA smooths edges on the high tier,
 * and laptop tiers render the glow at reduced resolution.
 */
export function Glow({ tier, intensity = 0.9, threshold = 0.55, smoothing = 0.35, radius = 0.75 }: { tier: Tier; intensity?: number; threshold?: number; smoothing?: number; radius?: number }) {
  const bloom = <Bloom mipmapBlur intensity={intensity} luminanceThreshold={threshold} luminanceSmoothing={smoothing} radius={radius} />
  return tier === 'high' ? (
    <EffectComposer multisampling={0}>
      {bloom}
      <SMAA />
    </EffectComposer>
  ) : (
    <EffectComposer multisampling={0} resolutionScale={0.6}>
      {bloom}
    </EffectComposer>
  )
}
