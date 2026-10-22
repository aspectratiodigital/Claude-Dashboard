import { useEffect, useRef } from 'react'
import { useApp } from '../store'
import { TIERS, useTier } from './quality'

// Press F to show a frame-rate readout. Measures the page's real rAF cadence.
export function FpsMeter() {
  const show = useApp((s) => s.showFps)
  const tier = useTier()
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!show) return
    let frames = 0
    let last = performance.now()
    let raf = 0
    const tick = (t: number) => {
      frames++
      if (t - last >= 500) {
        const fps = Math.round((frames * 1000) / (t - last))
        if (el.current) el.current.textContent = `${fps} fps · ${TIERS[tier].label}`
        frames = 0
        last = t
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [show, tier])

  return show ? <div className="fps" ref={el} /> : null
}
