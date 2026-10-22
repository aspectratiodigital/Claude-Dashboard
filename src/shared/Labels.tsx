import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// Lightweight 3D-anchored DOM labels. An <Anchor> inside the scene projects its
// world position every frame and writes a transform straight onto the label
// element with the matching id, so labels track the 3D scene without any React
// re-renders (and without the nested React roots drei's <Html> creates).

const v = new THREE.Vector3()

export function Anchor({ id, position = [0, 0, 0] }: { id: string; position?: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null!)
  const el = useRef<HTMLElement | null>(null)
  const { camera, size } = useThree()
  const last = useMemo(() => ({ x: NaN, y: NaN, hidden: null as boolean | null }), [])

  useFrame(() => {
    if (!el.current || !el.current.isConnected) {
      el.current = document.getElementById(id)
      last.x = NaN
      last.hidden = null
    }
    const e = el.current
    if (!e) return
    camera.updateMatrixWorld()
    ref.current.getWorldPosition(v)
    // hide when the anchor (or any parent) is hidden, or it's behind the camera
    let shown = true
    for (let o: THREE.Object3D | null = ref.current; o; o = o.parent) if (!o.visible) shown = false
    v.project(camera)
    const hidden = !shown || v.z > 1
    const x = Math.round((v.x * 0.5 + 0.5) * size.width * 10) / 10
    const y = Math.round((-v.y * 0.5 + 0.5) * size.height * 10) / 10
    if (x !== last.x || y !== last.y) {
      e.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
      last.x = x
      last.y = y
    }
    if (hidden !== last.hidden) {
      e.style.visibility = hidden ? 'hidden' : 'visible'
      last.hidden = hidden
    }
  })
  return <group ref={ref} position={position} />
}

/** Positioned container for labels; place it right after the <Canvas>. */
export function LabelLayer({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`label-layer ${className}`} aria-hidden>
      {children}
    </div>
  )
}
