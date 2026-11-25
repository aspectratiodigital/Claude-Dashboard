import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import type { PhoneState } from '../data/studio-api'
import { Icon } from './icons'
import { Modal, Seg, Spin, Toggle, download, getJson, post, postBlob, type StudioCtx } from './StudioUi'

// Showing the site to someone: a screenshot for a client (any size, the whole
// page, sharp, optionally in a phone, laptop or browser frame) and the
// preview on your own phone (a QR code for a small server on this computer's
// Wi-Fi address, showing your unsaved edits too).

type Device = 'phone' | 'tablet' | 'laptop' | 'canvas'
type Frame = 'none' | 'device' | 'browser'
type Back = 'white' | 'grey' | 'dark' | 'none'

const DEVICES: Record<Exclude<Device, 'canvas'>, { w: number; h: number; mobile: boolean }> = {
  phone: { w: 390, h: 844, mobile: true },
  tablet: { w: 820, h: 1180, mobile: true },
  laptop: { w: 1440, h: 900, mobile: false },
}
const BACKS: Record<Back, string | null> = { white: '#ffffff', grey: '#eceef2', dark: '#16171b', none: null }

const loadImg = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('The screenshot couldn’t be read'))
    i.src = src
  })

function roundRect(x: CanvasRenderingContext2D, l: number, t: number, w: number, h: number, r: number) {
  x.beginPath()
  x.roundRect(l, t, w, h, r)
}

/** the screenshot inside a phone, laptop or browser window, on a background */
async function framed(shot: Blob, o: { frame: Frame; device: 'phone' | 'tablet' | 'laptop'; back: Back; scale: number; address: string }): Promise<Blob> {
  const url = URL.createObjectURL(shot)
  try {
    const img = await loadImg(url)
    const s = o.scale
    const W = img.naturalWidth
    const H = img.naturalHeight
    const pad = o.frame === 'none' ? 0 : 56 * s
    let bodyW = W
    let bodyH = H
    let sx = 0
    let sy = 0
    const phone = o.frame === 'device' && o.device !== 'laptop'
    const laptop = o.frame === 'device' && o.device === 'laptop'
    // a phone's status bar sits above the page, as on a real phone, so the camera doesn't cover the page's top
    const status = phone && o.device === 'phone' ? 50 * s : 0
    if (phone) {
      const b = (o.device === 'phone' ? 14 : 20) * s
      bodyW = W + b * 2
      bodyH = H + status + b * 2
      sx = b
      sy = b + status
    } else if (laptop) {
      const b = 16 * s
      bodyW = W + b * 2
      bodyH = H + b + 26 * s
      sx = b
      sy = 26 * s
    } else if (o.frame === 'browser') {
      bodyH = H + 44 * s
      sy = 44 * s
    }
    const base = laptop ? 22 * s : 0
    const c = document.createElement('canvas')
    c.width = bodyW + pad * 2 + (laptop ? 80 * s : 0)
    c.height = bodyH + base + pad * 2
    const x = c.getContext('2d')!
    const bg = BACKS[o.back]
    if (bg && o.frame !== 'none') {
      x.fillStyle = bg
      x.fillRect(0, 0, c.width, c.height)
    }
    const left = (c.width - bodyW) / 2
    const top = pad
    if (o.frame !== 'none') {
      x.save()
      x.shadowColor = 'rgba(0,0,0,.28)'
      x.shadowBlur = 40 * s
      x.shadowOffsetY = 16 * s
      x.fillStyle = phone || laptop ? '#111214' : '#ffffff'
      roundRect(x, left, top, bodyW, bodyH, phone ? (o.device === 'phone' ? 54 : 34) * s : laptop ? 18 * s : 12 * s)
      x.fill()
      x.restore()
    }
    if (o.frame === 'browser') {
      x.fillStyle = '#f1f2f5'
      roundRect(x, left, top, bodyW, 44 * s, 12 * s)
      x.fill()
      x.fillRect(left, top + 30 * s, bodyW, 14 * s)
      ;['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
        x.fillStyle = col
        x.beginPath()
        x.arc(left + (20 + i * 18) * s, top + 22 * s, 6 * s, 0, Math.PI * 2)
        x.fill()
      })
      x.fillStyle = '#ffffff'
      const aw = Math.min(bodyW * 0.55, 560 * s)
      roundRect(x, left + (bodyW - aw) / 2, top + 10 * s, aw, 24 * s, 12 * s)
      x.fill()
      x.fillStyle = '#5f6368'
      x.font = `${13 * s}px system-ui, sans-serif`
      x.textAlign = 'center'
      x.textBaseline = 'middle'
      x.fillText(o.address.slice(0, 70), left + bodyW / 2, top + 22 * s)
    }
    // the page itself, with rounded screen corners inside a device
    x.save()
    roundRect(x, left + sx, top + sy - status, W, H + status, phone ? (o.device === 'phone' ? 40 : 18) * s : o.frame === 'browser' ? 0 : laptop ? 4 * s : 0)
    if (o.frame === 'browser') {
      x.beginPath()
      x.roundRect(left, top + sy, W, H, [0, 0, 12 * s, 12 * s])
    }
    x.clip()
    let ink = '#111214'
    if (status) {
      // the status bar takes the colour of the page's top edge
      const px = document.createElement('canvas')
      px.width = px.height = 1
      const pc = px.getContext('2d')!
      pc.drawImage(img, 0, 0, W, Math.min(H, 4 * s), 0, 0, 1, 1)
      const [r, g, bl] = pc.getImageData(0, 0, 1, 1).data
      x.fillStyle = `rgb(${r},${g},${bl})`
      x.fillRect(left + sx, top + sy - status, W, status)
      ink = 0.299 * r + 0.587 * g + 0.114 * bl > 140 ? '#111214' : '#ffffff'
    }
    x.drawImage(img, left + sx, top + sy)
    x.restore()
    if (status) {
      // the camera, the time and the battery
      const mid = top + sy - status / 2 + 2 * s
      x.fillStyle = '#111214'
      roundRect(x, left + bodyW / 2 - 52 * s, mid - 15 * s, 104 * s, 30 * s, 15 * s)
      x.fill()
      x.fillStyle = ink
      x.font = `600 ${15 * s}px system-ui, sans-serif`
      x.textAlign = 'center'
      x.textBaseline = 'middle'
      x.fillText('9:41', left + sx + 52 * s, mid)
      x.globalAlpha = 0.9
      roundRect(x, left + sx + W - 62 * s, mid - 6 * s, 24 * s, 12 * s, 3.5 * s)
      x.fill()
      x.globalAlpha = 1
    }
    if (laptop) {
      x.fillStyle = '#c9ccd3'
      roundRect(x, left - 40 * s, top + bodyH, bodyW + 80 * s, base, 6 * s)
      x.fill()
      x.fillStyle = '#a9adb6'
      roundRect(x, left + bodyW / 2 - 60 * s, top + bodyH, 120 * s, 8 * s, 4 * s)
      x.fill()
    }
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('The picture couldn’t be made'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function ShotDialog({ ctx, size, onClose }: { ctx: StudioCtx; size: { w: number; h: number }; onClose: () => void }) {
  const [device, setDevice] = useState<Device>('phone')
  const [full, setFull] = useState(false)
  const [sharp, setSharp] = useState(true)
  const [frame, setFrame] = useState<Frame>('device')
  const [back, setBack] = useState<Back>('grey')
  const [edits, setEdits] = useState(true)
  const [shot, setShot] = useState<Blob | null>(null)
  const [out, setOut] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const dims = device === 'canvas' ? { w: size.w, h: size.h, mobile: size.w < 900 } : DEVICES[device]
  const kind: 'phone' | 'tablet' | 'laptop' = device === 'canvas' ? (size.w < 600 ? 'phone' : size.w < 1100 ? 'tablet' : 'laptop') : device
  const address = useMemo(() => {
    try {
      return `${new URL(ctx.project?.url ?? ctx.project?.previewUrl ?? 'https://example.com').host}${ctx.path === '/' ? '' : ctx.path}`
    } catch {
      return ctx.path
    }
  }, [ctx.project, ctx.path])

  const take = async () => {
    setBusy(true)
    setError(null)
    setShot(null)
    setOut(null)
    try {
      const b = await postBlob('./api/studio/shot', { projectId: ctx.projectId, page: ctx.path, width: dims.w, height: dims.h, full, scale: sharp ? 2 : 1, type: 'png', mobile: dims.mobile, source: 'studio', ops: edits ? ctx.ops : [] })
      setShot(b)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // the frame is drawn here, so changing it doesn't take the screenshot again
  useEffect(() => {
    if (!shot) return setOut(null)
    let gone = false
    framed(shot, { frame, device: kind, back, scale: sharp ? 2 : 1, address })
      .then((b) => !gone && setOut(b))
      .catch((e) => !gone && setError((e as Error).message))
    return () => {
      gone = true
    }
  }, [shot, frame, kind, back, sharp, address])
  const preview = useMemo(() => (out ? URL.createObjectURL(out) : null), [out])
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  // a new set-up needs a new screenshot
  useEffect(() => setShot(null), [device, full, sharp, edits])

  const name = `${(ctx.project?.name ?? 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${ctx.path === '/' ? 'home' : ctx.path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-')}-${kind}.png`
  const copy = async () => {
    if (!out) return
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': out })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copying pictures isn’t allowed here: download it instead.')
    }
  }

  return (
    <Modal
      title="Screenshot for a client"
      onClose={onClose}
      wide
      tall
      footer={
        <>
          <span className="st-muted">{out ? `${name}` : `${dims.w} × ${full ? 'whole page' : dims.h}${sharp ? ', sharp (2×)' : ''}`}</span>
          <span className="st-gap" />
          {out && (
            <>
              <button className="st-pill" onClick={copy}>
                {copied ? <Icon.check size={13} /> : <Icon.copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="st-pill" onClick={() => download(out, name)}>
                <Icon.download size={13} /> Download
              </button>
            </>
          )}
          <button className="st-primary" onClick={take} disabled={busy}>
            {busy ? 'Taking it…' : shot ? 'Take it again' : 'Take the screenshot'}
          </button>
        </>
      }
    >
      <div className="st-shot">
        <div className="st-shot-form">
          <div className="st-cfield">
            <span>Screen</span>
            <Seg
              small
              value={device}
              label="Screen"
              onChange={setDevice}
              options={[
                ['phone', 'Phone', '390 × 844'],
                ['tablet', 'Tablet', '820 × 1180'],
                ['laptop', 'Laptop', '1440 × 900'],
                ['canvas', 'As shown', `${size.w} × ${size.h}`],
              ]}
            />
          </div>
          <div className="st-cfield">
            <span>Frame</span>
            <Seg
              small
              value={frame}
              label="Frame"
              onChange={setFrame}
              options={[
                ['device', kind === 'laptop' ? 'Laptop' : kind === 'tablet' ? 'Tablet' : 'Phone'],
                ['browser', 'Browser'],
                ['none', 'None'],
              ]}
            />
          </div>
          {frame !== 'none' && (
            <div className="st-cfield">
              <span>Background</span>
              <Seg
                small
                value={back}
                label="Background"
                onChange={setBack}
                options={[
                  ['grey', 'Grey'],
                  ['white', 'White'],
                  ['dark', 'Dark'],
                  ['none', 'See-through'],
                ]}
              />
            </div>
          )}
          <Toggle on={full} onChange={setFull}>
            The whole page, top to bottom
          </Toggle>
          <Toggle on={sharp} onChange={setSharp}>
            Sharp (twice the pixels)
          </Toggle>
          <Toggle on={edits && ctx.ops.length > 0} onChange={setEdits} disabled={!ctx.ops.length}>
            With my unsaved edits{ctx.ops.length ? ` (${ctx.ops.length})` : ''}
          </Toggle>
          <p className="st-tip">Taken from Studio’s copy of {ctx.path === '/' ? 'the home page' : ctx.path}, with saved edits that aren’t live yet.</p>
        </div>
        <div className="st-shot-view" data-full={(full && !!preview) || undefined}>
          {busy && <Spin>Loading the page at {dims.w}px and taking the picture…</Spin>}
          {error && <p className="st-error">{error}</p>}
          {preview && !busy && <img src={preview} alt="The screenshot" />}
          {!preview && !busy && !error && <p className="st-muted">Pick the screen and frame, then take the screenshot.</p>}
        </div>
      </div>
    </Modal>
  )
}

// --- Phone preview -----------------------------------------------------------------------------

export function PhoneDialog({ ctx, onState, onClose }: { ctx: StudioCtx; onState: (on: boolean) => void; onClose: () => void }) {
  const [state, setState] = useState<PhoneState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const start = async () => {
    setError(null)
    try {
      const s = await post<PhoneState>('./api/studio/phone', { on: true, projectId: ctx.projectId, page: ctx.path, ops: ctx.ops })
      setState(s)
      onState(s.on)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    getJson<PhoneState>('./api/studio/phone')
      .then((s) => {
        // already showing this site: just point it at this page
        if (s.on && s.projectId === ctx.projectId) {
          setState(s)
          onState(true)
          void post<PhoneState>('./api/studio/phone', { projectId: ctx.projectId, page: ctx.path, ops: ctx.ops }).then(setState)
        } else void start()
      })
      .catch(() => void start())
    // once, when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!state?.url) return setQr(null)
    QRCode.toDataURL(state.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch(() => setQr(null))
  }, [state?.url])
  const stop = async () => {
    try {
      setState(await post<PhoneState>('./api/studio/phone', { on: false }))
    } catch {
      /* it turns itself off anyway */
    }
    onState(false)
  }
  return (
    <Modal title="Preview on your phone" onClose={onClose}>
      {error && <p className="st-error">{error}</p>}
      {!state && !error && <Spin>Starting the phone preview…</Spin>}
      {state?.on && state.url && (
        <div className="st-phone">
          {qr ? <img src={qr} alt="QR code for the phone preview" width={240} height={240} /> : <Spin />}
          <div>
            <p>
              <b>Scan this with your phone’s camera.</b> It opens {ctx.path === '/' ? 'the home page' : ctx.path} with your edits, and follows you as you edit and change pages.
            </p>
            <code className="st-selector">{state.url.replace(/\?k=.*/, '')}</code>
            <ul className="st-plain-list st-muted">
              <li>Your phone needs to be on the same Wi-Fi as this computer.</li>
              <li>If Windows asks about the firewall, allow Blueprint on private networks.</li>
              <li>Only someone with the code can see it, and it turns itself off after 30 minutes with nothing to do.</li>
            </ul>
            <button className="st-pill" data-tone="bad" onClick={stop}>
              Stop the phone preview
            </button>
          </div>
        </div>
      )}
      {state && !state.on && (
        <div className="st-row">
          <p className="st-muted">The phone preview is off.</p>
          <button className="st-primary" onClick={start}>
            Start it again
          </button>
        </div>
      )}
    </Modal>
  )
}
