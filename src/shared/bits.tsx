import { useEffect, useRef, useState } from 'react'

/** Tiny SVG line chart; colour comes from currentColor. */
export function Sparkline({
  data,
  width = 80,
  height = 22,
  fill = false,
  strokeWidth = 1.25,
}: {
  data: number[]
  width?: number
  height?: number
  fill?: boolean
  strokeWidth?: number
}) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="spark">
      {fill && <path d={`${d}L${width},${height}L0,${height}Z`} fill="currentColor" opacity={0.15} />}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    </svg>
  )
}

/** Animates a number from its previous value to `value`. */
export function CountUp({ value, decimals = 0, duration = 1200 }: { value: number; decimals?: number; duration?: number }) {
  const [v, setV] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration)
      const e = 1 - Math.pow(1 - k, 4)
      setV(a + (value - a) * e)
      if (k < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>
}

/** Circular gauge 0..100. */
export function Gauge({ value, size = 64, stroke = 4, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="gauge" role="img" aria-label={label ?? `${value} of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="currentColor" fontSize={size * 0.28}>
        {value}
      </text>
    </svg>
  )
}

/** Live clock string, updates every second. */
export function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** Pointer position normalised to -1..1, stored in a ref (no re-renders). */
export function usePointer() {
  const p = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const on = (e: PointerEvent) => {
      p.current.x = (e.clientX / window.innerWidth) * 2 - 1
      p.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', on)
    return () => window.removeEventListener('pointermove', on)
  }, [])
  return p
}

/** Tilts an element toward the pointer for a cheap 3D hover feel. */
export function useTilt<T extends HTMLElement>(max = 8) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5
      const y = (e.clientY - r.top) / r.height - 0.5
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--tx', `${(-y * max).toFixed(2)}deg`)
        el.style.setProperty('--ty', `${(x * max).toFixed(2)}deg`)
        el.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`)
        el.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`)
      })
    }
    const leave = () => {
      el.style.setProperty('--tx', '0deg')
      el.style.setProperty('--ty', '0deg')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      cancelAnimationFrame(raf)
    }
  }, [max])
  return ref
}
