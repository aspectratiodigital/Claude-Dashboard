import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioElement } from '../data/types'
import type { LibraryPhoto, StockPhoto, StockResults } from '../data/studio-api'
import { embedOf } from '../data/studio'
import { Icon } from './icons'
import { Modal, Seg, Spin, Toggle, bytes, getJson, post, q, type PhotoPurpose, type StudioCtx, type Uploaded } from './StudioUi'

// Photos and media from anywhere: the photo picker (your computer, the site's
// own photos, or free stock photos), the photo editor (crop, straighten and
// light touch-ups, drawn on a canvas and uploaded as a new photo) and the
// embed dialog (YouTube, Vimeo or a Google map after what's selected).

export interface Picked {
  upload?: Uploaded
  /** a photo already in the site, as the preview serves it */
  src?: string
  name: string
  alt?: string
  /** swap every use of the old photo across the site */
  everywhere?: boolean
}

const TITLE: Record<PhotoPurpose, string> = {
  image: 'Replace the photo',
  'add-image': 'Add a photo',
  bg: 'Replace the background',
  share: 'Choose a share image',
}
const altFrom = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

type Source = 'computer' | 'site' | 'stock'

export function PhotoPicker({ ctx, purpose, onPick, onClose }: { ctx: StudioCtx; purpose: PhotoPurpose; onPick: (p: Picked) => void; onClose: () => void }) {
  const [source, setSource] = useState<Source>(() => (localStorage.getItem('ard.studio.picker') as Source | null) ?? 'computer')
  const [everywhere, setEverywhere] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pick = (s: Source) => {
    setSource(s)
    try {
      localStorage.setItem('ard.studio.picker', s)
    } catch {
      /* storage off */
    }
  }
  const done = (p: Picked) => onPick({ ...p, everywhere: purpose === 'image' && everywhere })

  const fromFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return setError('That isn’t a photo.')
    setBusy('Uploading…')
    setError(null)
    try {
      const u = await ctx.upload(file)
      done({ upload: u, name: u.name, alt: altFrom(file.name) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // paste a photo from the clipboard
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (f) {
        e.preventDefault()
        void fromFile(new File([f], f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}.png`, { type: f.type }))
      }
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  })

  return (
    <Modal
      title={TITLE[purpose]}
      onClose={onClose}
      wide
      tall
      footer={
        purpose === 'image' ? (
          <Toggle on={everywhere} onChange={setEverywhere} title="Every page that shows the old photo gets the new one">
            Swap it on every page that uses this photo
          </Toggle>
        ) : purpose === 'share' ? (
          <span className="st-muted">Best at 1200 × 630. Or make one in Checks → SEO.</span>
        ) : undefined
      }
    >
      <div className="st-review-tabs">
        <Seg
          value={source}
          label="Where from"
          onChange={pick}
          options={[
            [
              'computer',
              <>
                <Icon.desktop size={14} /> Your computer
              </>,
            ],
            [
              'site',
              <>
                <Icon.image size={14} /> This site’s photos
              </>,
            ],
            [
              'stock',
              <>
                <Icon.globe size={14} /> Free stock photos
              </>,
            ],
          ]}
        />
      </div>
      {error && <p className="st-error">{error}</p>}
      {busy && <Spin>{busy}</Spin>}
      {source === 'computer' && <FromComputer ctx={ctx} onFile={fromFile} busy={!!busy} />}
      {source === 'site' && (
        <FromSite
          ctx={ctx}
          onPick={(p) =>
            done({
              src: p.url,
              name: p.path.split('/').pop() ?? 'photo',
              alt: altFrom(p.path.split('/').pop() ?? ''),
            })
          }
        />
      )}
      {source === 'stock' && (
        <FromStock
          onPick={async (p) => {
            setBusy('Downloading the photo…')
            setError(null)
            try {
              const name = `${
                (p.title || 'photo')
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 40) || 'photo'
              }.jpg`
              const u = await post<Uploaded>('./api/studio/stock', {
                full: p.full,
                name,
                ping: p.ping,
              })
              done({ upload: u, name: u.name, alt: p.title })
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(null)
            }
          }}
        />
      )}
    </Modal>
  )
}

function FromComputer({ ctx, onFile, busy }: { ctx: StudioCtx; onFile: (f: File) => void; busy: boolean }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      className="st-drop"
      data-over={over || undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
    >
      <Icon.image size={28} />
      <p>Drop a photo here, paste one (Ctrl V), or</p>
      <button className="st-primary" onClick={() => input.current?.click()} disabled={busy}>
        Choose a photo…
      </button>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <p className="st-tip">
        {ctx.site.pipeline === 'files'
          ? 'Big photos are resized to 2400px and saved as WebP, so they load quickly.'
          : ctx.site.pipeline === 'script'
            ? 'The original goes in, and the site’s own image script makes the web-ready sizes when you save.'
            : 'The original goes in, and Astro makes the web-ready sizes when the site is built.'}{' '}
        You can also drop a photo straight onto one on the page.
      </p>
    </div>
  )
}

function FromSite({ ctx, onPick }: { ctx: StudioCtx; onPick: (p: LibraryPhoto) => void }) {
  const [photos, setPhotos] = useState<LibraryPhoto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    getJson<{ photos: LibraryPhoto[] }>(`./api/studio/photos?${q({ project: ctx.projectId })}`)
      .then((d) => setPhotos(d.photos.filter((p) => !/\.svg$/i.test(p.path) || ctx.selected?.image?.svg)))
      .catch((e) => setError((e as Error).message))
  }, [ctx.projectId, ctx.selected?.image?.svg])
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (photos ?? []).filter((p) => !f || p.path.toLowerCase().includes(f)).sort((a, b) => (b.uses > 0 ? 1 : 0) - (a.uses > 0 ? 1 : 0))
  }, [photos, filter])
  if (error) return <p className="st-error">{error}</p>
  if (!photos) return <Spin>Looking through the site’s photos…</Spin>
  return (
    <>
      <div className="st-row">
        <input className="st-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${photos.length} photos`} aria-label="Find a photo" autoFocus spellCheck={false} />
        <span className="st-muted">Already in the site, so they add nothing to its size.</span>
      </div>
      <ul className="st-grid st-grid-big">
        {shown.slice(0, 300).map((p) => (
          <li key={p.path}>
            <button onClick={() => onPick(p)} title={`${p.path}\n${p.width ?? '?'} × ${p.height ?? '?'} · ${bytes(p.bytes)}`}>
              <img src={`${ctx.origin}${p.url}`} alt="" loading="lazy" />
              <small>{p.path.split('/').pop()}</small>
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && <p className="st-muted">No photos match.</p>}
    </>
  )
}

function FromStock({ onPick }: { onPick: (p: StockPhoto) => void }) {
  const [text, setText] = useState(() => localStorage.getItem('ard.studio.stock') ?? '')
  const [res, setRes] = useState<StockResults | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // a photo whose preview won't load (gone from its host) is left out
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const search = useCallback(async (s: string, p: number) => {
    if (s.trim().length < 2) return
    setLoading(true)
    setError(null)
    try {
      localStorage.setItem('ard.studio.stock', s)
    } catch {
      /* storage off */
    }
    try {
      const r = await getJson<StockResults>(`./api/studio/stock?${q({ q: s.trim(), page: p })}`)
      setRes((old) => (p > 1 && old ? { ...r, photos: [...old.photos, ...r.photos] } : r))
      setPage(p)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (text) void search(text, 1)
    // only the remembered search, once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <>
      <form
        className="st-row"
        onSubmit={(e) => {
          e.preventDefault()
          void search(text, 1)
        }}
      >
        <input className="st-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. smiling family, coffee shop, festival crowd" aria-label="Search stock photos" autoFocus />
        <button className="st-primary" disabled={loading || text.trim().length < 2}>
          Search
        </button>
      </form>
      <p className="st-tip">From {res?.sources.join(', ') ?? 'Openverse'}. Openverse photos are Creative Commons: some licences (CC BY) ask you to credit the photographer, shown on each photo. Unsplash and Pexels photos are free to use with no credit needed. Keys for Unsplash and Pexels go in Settings → Studio.</p>
      {error && <p className="st-error">{error}</p>}
      {res?.errors.map((e) => (
        <p key={e} className="st-muted">
          {e}
        </p>
      ))}
      {res && (
        <ul className="st-grid st-grid-big st-stock">
          {res.photos
            .filter((p) => !broken.has(`${p.provider}-${p.id}`))
            .map((p) => (
              <li key={`${p.provider}-${p.id}`}>
                <button onClick={() => onPick(p)} title={`${p.title}\nBy ${p.author} on ${p.provider}\n${p.license}`}>
                  <img src={p.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken((b) => new Set(b).add(`${p.provider}-${p.id}`))} />
                  <small>
                    {p.author} · {p.provider}
                    {/by(?!-?nc)/i.test(p.license) && p.provider === 'openverse' ? ' · credit' : ''}
                  </small>
                </button>
              </li>
            ))}
        </ul>
      )}
      {res && !res.photos.length && <p className="st-muted">Nothing found. Try simpler words.</p>}
      {loading && <Spin>Searching…</Spin>}
      {res && res.photos.length >= 20 && !loading && (
        <button className="st-pill" onClick={() => search(text, page + 1)}>
          More photos
        </button>
      )}
    </>
  )
}

// --- Photo editor ------------------------------------------------------------------------------

type Ratio = 'original' | 'box' | '1' | '4/3' | '3/2' | '16/9' | '3/4'

interface Edit {
  ratio: Ratio
  zoom: number
  /** the crop's centre, 0 to 1 across the (turned) photo */
  cx: number
  cy: number
  turn: 0 | 1 | 2 | 3
  angle: number
  bright: number
  contrast: number
  saturate: number
  warmth: number
}
const START: Edit = {
  ratio: 'original',
  zoom: 1,
  cx: 0.5,
  cy: 0.5,
  turn: 0,
  angle: 0,
  bright: 0,
  contrast: 0,
  saturate: 0,
  warmth: 0,
}

/** the crop box and the geometry to draw it, in the photo's own pixels */
function layout(img: HTMLImageElement, e: Edit, boxRatio: number) {
  const W = img.naturalWidth
  const H = img.naturalHeight
  const tw = e.turn % 2 ? H : W
  const th = e.turn % 2 ? W : H
  const r = e.ratio === 'original' ? tw / th : e.ratio === 'box' ? boxRatio : eval0(e.ratio)
  let bw = tw / th > r ? th * r : tw
  let bh = tw / th > r ? th : tw / r
  bw /= e.zoom
  bh /= e.zoom
  const cx = Math.max(bw / 2, Math.min(tw - bw / 2, e.cx * tw))
  const cy = Math.max(bh / 2, Math.min(th - bh / 2, e.cy * th))
  const a = (Math.abs(e.angle) * Math.PI) / 180
  // grow the photo just enough that turning it leaves no empty corners
  const grow = Math.cos(a) + Math.sin(a) * Math.max(tw / th, th / tw)
  return { W, H, tw, th, bw, bh, cx, cy, grow }
}
const eval0 = (r: string) => {
  const [a, b] = r.split('/').map(Number)
  return b ? a / b : a
}

function draw(c: HTMLCanvasElement, img: HTMLImageElement, e: Edit, boxRatio: number, maxSide: number) {
  const g = layout(img, e, boxRatio)
  const k = Math.min(1, maxSide / Math.max(g.bw, g.bh))
  c.width = Math.max(1, Math.round(g.bw * k))
  c.height = Math.max(1, Math.round(g.bh * k))
  const x = c.getContext('2d')!
  x.save()
  x.scale(k, k)
  x.translate(-(g.cx - g.bw / 2), -(g.cy - g.bh / 2))
  x.translate(g.tw / 2, g.th / 2)
  x.rotate((e.angle * Math.PI) / 180)
  x.scale(g.grow, g.grow)
  x.rotate((e.turn * Math.PI) / 2)
  x.filter = `brightness(${1 + e.bright / 100}) contrast(${1 + e.contrast / 100}) saturate(${1 + e.saturate / 100})`
  x.drawImage(img, -g.W / 2, -g.H / 2)
  x.restore()
  if (e.warmth) {
    x.save()
    x.globalCompositeOperation = 'soft-light'
    x.globalAlpha = Math.min(0.6, Math.abs(e.warmth) / 100)
    x.fillStyle = e.warmth > 0 ? '#ff9a3c' : '#3c8cff'
    x.fillRect(0, 0, c.width, c.height)
    x.restore()
  }
  return { g, k }
}

export function PhotoEditor({ ctx, el, onClose }: { ctx: StudioCtx; el: StudioElement; onClose: () => void }) {
  const src = el.image!.src
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [e, setE] = useState<Edit>(START)
  const [busy, setBusy] = useState(false)
  const view = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const boxRatio = el.rect.w && el.rect.h ? el.rect.w / el.rect.h : 1
  const scaleRef = useRef(1)

  useEffect(() => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => setImg(i)
    i.onerror = () => setError('Studio couldn’t load this photo to edit it.')
    i.src = new URL(src, `${ctx.origin}/`).href
  }, [src, ctx.origin])

  useEffect(() => {
    if (!img || !view.current) return
    try {
      const { k } = draw(view.current, img, e, boxRatio, 640)
      scaleRef.current = k
    } catch {
      setError('Studio couldn’t draw this photo.')
    }
  }, [img, e, boxRatio])

  const set = (patch: Partial<Edit>) => setE((x) => ({ ...x, ...patch }))
  const changed = JSON.stringify(e) !== JSON.stringify(START)

  const save = async () => {
    if (!img) return
    setBusy(true)
    try {
      const c = document.createElement('canvas')
      draw(c, img, e, boxRatio, 2400)
      const files = ctx.site.pipeline === 'files'
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, files ? 'image/webp' : 'image/jpeg', files ? 0.85 : 0.92))
      if (!blob) throw new Error('The photo couldn’t be saved.')
      const stem = decodeURIComponent(src.split('/').pop()?.split('?')[0] ?? 'photo')
        .replace(/\.[^.]+$/, '')
        .replace(/-edited(-\d+)?$/, '')
      const u = await ctx.upload(blob, `${stem}-edited.${files ? 'webp' : 'jpg'}`)
      ctx.act('image', { upload: u.id, name: u.name })
      ctx.say('Edited photo swapped in. Save to put it in the site.')
      onClose()
    } catch (err) {
      const m = (err as Error).message
      setError(/tainted|security/i.test(m) ? 'This photo comes from another website, so it can’t be edited here. Replace it with a copy first.' : m)
    } finally {
      setBusy(false)
    }
  }

  // a plain function, not a component: a component made here would be new on every
  // render, so React would swap the slider out from under the pointer mid-drag
  const slider = (label: string, k: 'bright' | 'contrast' | 'saturate' | 'warmth' | 'angle', min = -50, max = 50) => (
    <label className="st-slider" key={k}>
      <span>
        {label} <small>{e[k] > 0 ? `+${e[k]}` : e[k]}</small>
      </span>
      <input type="range" min={min} max={max} step={k === 'angle' ? 0.5 : 1} value={e[k]} onChange={(x) => set({ [k]: Number(x.target.value) } as Partial<Edit>)} onDoubleClick={() => set({ [k]: 0 } as Partial<Edit>)} />
    </label>
  )

  return (
    <Modal
      title="Crop and adjust"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="st-pill" onClick={() => setE(START)} disabled={!changed || busy}>
            Reset
          </button>
          <span className="st-gap" />
          <span className="st-muted">Saved as a new photo; the original stays in the site.</span>
          <button className="st-primary" onClick={save} disabled={!img || !changed || busy || ctx.working}>
            {busy ? 'Saving…' : 'Use this photo'}
          </button>
        </>
      }
    >
      {error && <p className="st-error">{error}</p>}
      <div className="st-editor">
        <div className="st-editor-view">
          {!img && !error && <Spin>Loading the photo…</Spin>}
          <canvas
            ref={view}
            hidden={!img}
            style={{
              cursor: e.zoom > 1 || e.ratio !== 'original' ? 'grab' : 'default',
            }}
            onPointerDown={(x) => {
              ;(x.target as HTMLElement).setPointerCapture(x.pointerId)
              drag.current = { x: x.clientX, y: x.clientY, cx: e.cx, cy: e.cy }
            }}
            onPointerMove={(x) => {
              if (!drag.current || !img) return
              const g = layout(img, e, boxRatio)
              // the canvas is shown at its own size; moving the photo right shows more of its left
              const css = view.current!.getBoundingClientRect().width / view.current!.width
              const dx = (x.clientX - drag.current.x) / css / scaleRef.current
              const dy = (x.clientY - drag.current.y) / css / scaleRef.current
              set({
                cx: Math.max(0, Math.min(1, drag.current.cx - dx / g.tw)),
                cy: Math.max(0, Math.min(1, drag.current.cy - dy / g.th)),
              })
            }}
            onPointerUp={() => (drag.current = null)}
          />
          {img && (e.zoom > 1 || e.ratio !== 'original') && <p className="st-tip">Drag the photo to move it in the frame.</p>}
        </div>
        <div className="st-editor-tools">
          <div className="st-cfield">
            <span>Shape</span>
            <select value={e.ratio} onChange={(x) => set({ ratio: x.target.value as Ratio, cx: 0.5, cy: 0.5 })}>
              <option value="original">As the photo is</option>
              <option value="box">
                As it’s shown on the page ({Math.round(el.rect.w)} × {Math.round(el.rect.h)})
              </option>
              <option value="1">Square</option>
              <option value="4/3">4 : 3 landscape</option>
              <option value="3/2">3 : 2 landscape</option>
              <option value="16/9">16 : 9 wide</option>
              <option value="3/4">3 : 4 portrait</option>
            </select>
          </div>
          <label className="st-slider">
            <span>
              Zoom <small>{e.zoom.toFixed(1)}×</small>
            </span>
            <input type="range" min={1} max={4} step={0.05} value={e.zoom} onChange={(x) => set({ zoom: Number(x.target.value) })} onDoubleClick={() => set({ zoom: 1 })} />
          </label>
          <div className="st-row">
            <button
              className="st-pill"
              onClick={() =>
                set({
                  turn: ((e.turn + 3) % 4) as Edit['turn'],
                  cx: 0.5,
                  cy: 0.5,
                })
              }
              title="Turn left"
            >
              <Icon.undo size={13} /> Turn left
            </button>
            <button
              className="st-pill"
              onClick={() =>
                set({
                  turn: ((e.turn + 1) % 4) as Edit['turn'],
                  cx: 0.5,
                  cy: 0.5,
                })
              }
              title="Turn right"
            >
              <Icon.redo size={13} /> Turn right
            </button>
          </div>
          {slider('Straighten', 'angle', -15, 15)}
          {slider('Brightness', 'bright')}
          {slider('Contrast', 'contrast')}
          {slider('Colour', 'saturate')}
          {slider('Warmth', 'warmth')}
          <p className="st-tip">Double-click a slider to put it back.</p>
          {img && (
            <p className="st-muted">
              {img.naturalWidth} × {img.naturalHeight} original
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}

// --- Embeds ----------------------------------------------------------------------------------

export function EmbedDialog({ ctx, onClose }: { ctx: StudioCtx; onClose: () => void }) {
  const [raw, setRaw] = useState('')
  const [title, setTitle] = useState('')
  const e = useMemo(() => embedOf(raw), [raw])
  useEffect(() => {
    if (e) setTitle((t) => t || e.title)
  }, [e])
  const add = () => {
    if (!e) return
    ctx.act('embed', {
      url: raw.trim(),
      value: e.src,
      provider: e.provider,
      title: title.trim() || e.title,
    })
    ctx.say(`${e.provider === 'maps' ? 'Map' : 'Video'} added. Save to put it in the site.`)
    onClose()
  }
  return (
    <Modal
      title="Add a video or map"
      onClose={onClose}
      footer={
        <>
          <span className="st-muted">{ctx.selected ? `Goes straight after ${ctx.selected.label}` : 'Select where it should go first'}</span>
          <span className="st-gap" />
          <button className="st-primary" onClick={add} disabled={!e || !ctx.selected || ctx.working}>
            Add it
          </button>
        </>
      }
    >
      <label className="st-cfield">
        <span>Link to a YouTube or Vimeo video, or a Google Maps place</span>
        <input value={raw} onChange={(x) => setRaw(x.target.value)} placeholder="https://www.youtube.com/watch?v=… or https://maps.google.com/…" autoFocus spellCheck={false} />
      </label>
      {raw.trim() && !e && <p className="st-error">That isn’t a YouTube, Vimeo or Google Maps link. Copy the link from the address bar or the Share button.</p>}
      {e && (
        <>
          <label className="st-cfield">
            <span>Title (for screen readers)</span>
            <input value={title} onChange={(x) => setTitle(x.target.value)} spellCheck />
          </label>
          <div className="st-embed-preview">
            <iframe src={e.src} title={title || e.title} sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" />
          </div>
          <p className="st-tip">{e.provider === 'youtube' ? 'Uses YouTube’s privacy-enhanced mode: no cookies until someone presses play.' : e.provider === 'maps' ? 'A free Google map embed, no key needed.' : 'Vimeo’s own player.'} It fills the width and keeps its shape on phones.</p>
        </>
      )}
    </Modal>
  )
}
