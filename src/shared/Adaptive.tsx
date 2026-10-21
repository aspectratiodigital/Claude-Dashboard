import { useState } from 'react'
import { PerformanceMonitor } from '@react-three/drei'

// Keeps every scene near 60fps: drops the render resolution when frames
// start to slip and raises it again when there's headroom.
export function useAdaptiveDpr(max = 2) {
  const [dpr, setDpr] = useState(Math.min(max, window.devicePixelRatio || 1))
  const monitor = (
    <PerformanceMonitor
      bounds={() => [50, 58]}
      flipflops={4}
      onDecline={() => setDpr((d) => Math.max(0.75, d - 0.25))}
      onIncline={() => setDpr((d) => Math.min(max, d + 0.25))}
    />
  )
  return [dpr, monitor] as const
}
