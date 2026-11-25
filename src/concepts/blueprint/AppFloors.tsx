import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AppFloor, AppImage, AppItem, AppMap, Project } from '../../data/types'
import { hostOf, relTime } from '../../data/derive'
import { useData } from '../../data/store'
import type { Source } from '../../store'
import { MockSite, SOURCE_LABEL, enterStage, sourcesFor, urlFor } from '../../shared/Preview'
import { Icon } from '../../shared/icons'
import { useBp } from './state'

// The floors of an app's building: its home screen, then each game mode or
// screen. Each floor shows that page of the app's web build live, in a phone
// frame you can tap straight into and test, with a skin picker when the build
// takes ?skin=. Below it, the floor's card designs and images; click one to
// look at it full screen.

const assetUrl = (p: Project, img: AppImage) => `./api/app/asset?project=${encodeURIComponent(p.id)}&path=${encodeURIComponent(img.path)}`
const PHONE = { w: 390, h: 844 }
// no allow-top-navigation: the app can't navigate the dashboard away
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'

/** One image, or one cell of a sprite sheet. */
function Picture({ project, img, alt, big = false }: { project: Project; img: AppImage; alt: string; big?: boolean }) {
  const src = assetUrl(project, img)
  if (!img.crop) return <img src={src} alt={alt} loading="lazy" draggable={false} />
  const { cols, rows, index } = img.crop
  const style: CSSProperties = {
    backgroundImage: `url("${src}")`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${cols > 1 ? ((index % cols) / (cols - 1)) * 100 : 0}% ${rows > 1 ? (Math.floor(index / cols) / (rows - 1)) * 100 : 0}%`,
  }
  return <span className="ap-crop" data-big={big} role="img" aria-label={alt} style={style} />
}

// --- the live phone preview ------------------------------------------------------------------

interface Check {
  ok: boolean
  blocked: string | null
  error: string | null
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private window */
  }
}

/** The floor's query, older saved maps included (they kept it on each skin's screenshot). */
function linkOf(floor: AppFloor, index: number, app: AppMap): string | undefined {
  if (floor.link !== undefined) return floor.link
  if (index === 0) return ''
  const shot = floor.galleries.flatMap((g) => g.items).find((i) => i.shot)?.shot
  if (!shot) return undefined
  const q = new URLSearchParams(shot)
  if (app.skins?.param) q.delete(app.skins.param)
  for (const k of ['skin', 'theme']) q.delete(k)
  return q.toString()
}

function PhonePreview({ project: p, floor, index, jump, onJump }: { project: Project; floor: AppFloor; index: number; jump: AppItem | null; onJump: (i: AppItem | null) => void }) {
  const app = p.app!
  const sources = sourcesFor(p)
  const [source, setSource] = useState<Source>(() => {
    const saved = read(`bp-app-source:${p.id}`) as Source | null
    return saved && sources.includes(saved) ? saved : (sources[0] ?? 'live')
  })
  const skins = app.skins
  const [skin, setSkin] = useState(() => read(`bp-app-skin:${p.id}`) ?? '')
  const [nonce, setNonce] = useState(0)
  const [check, setCheck] = useState<Check | null>(null)
  const [anyway, setAnyway] = useState(false)
  const demo = useData((s) => s.mode !== 'live')
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.7)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / PHONE.w)
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!sources.includes(source) && sources[0]) setSource(sources[0])
  }, [sources.join(), source]) // eslint-disable-line react-hooks/exhaustive-deps

  // is the address up, and will it agree to be framed?
  useEffect(() => {
    if (demo || !urlFor(p, source)) return
    let live = true
    setCheck(null)
    setAnyway(false)
    fetch(`./api/app/frame?project=${encodeURIComponent(p.id)}&source=${source}`)
      .then((r) => r.json() as Promise<Check>)
      .then((c) => live && setCheck(c))
      .catch(() => live && setCheck(null))
    return () => {
      live = false
    }
  }, [p.id, p.url, p.previewUrl, p.localPort, source, nonce, demo]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: Source) => {
    setSource(s)
    write(`bp-app-source:${p.id}`, s)
  }
  const pickSkin = (id: string) => {
    setSkin(id)
    write(`bp-app-skin:${p.id}`, id)
  }

  const link = jump?.shot ?? linkOf(floor, index, app)
  const q = new URLSearchParams(link ?? '')
  if (skin && skins?.param && !jump) q.set(skins.param, skin)
  const query = q.toString()
  const path = `/${query ? `?${query}` : ''}`
  const src = urlFor(p, source, path)
  const others = sources.filter((s) => s !== source)
  const stop = check && (!check.ok || (check.blocked && !anyway))

  return (
    <section className="ap-live">
      <div className="pv-bar">
        {sources.length > 1 && (
          <div className="pv-seg" role="group" aria-label="Which version">
            {sources.map((s) => (
              <button key={s} aria-pressed={s === source} onClick={() => pick(s)}>
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <span className="pv-url" title={src ?? ''}>
          {src ? hostOf(src) + (query ? `/?${query}` : '') : 'No address yet'}
        </span>
        <button className="pv-icon" onClick={() => setNonce((n) => n + 1)} title="Reload" aria-label="Reload">
          <Icon.refresh size={14} />
        </button>
        {src && (
          <>
            <button className="pv-icon" onClick={() => enterStage({ projectId: p.id, device: 'mobile', source, path })} title="Bigger, full screen" aria-label="Full screen">
              <Icon.expand size={14} />
            </button>
            <a className="pv-icon" href={src} target="_blank" rel="noreferrer" title="Open in your browser" aria-label="Open in your browser">
              <Icon.external size={14} />
            </a>
          </>
        )}
      </div>

      {skins && skins.items.length > 0 && (
        <div className="ap-skins" role="group" aria-label="App skin">
          {skins.param ? (
            <>
              <button aria-pressed={!skin} onClick={() => pickSkin('')} title="Whatever skin the app picks">
                Default
              </button>
              {skins.items.map((s) => (
                <button key={s.id} aria-pressed={skin === s.id} onClick={() => pickSkin(s.id)} title={s.note ?? s.name} disabled={!!jump}>
                  {s.swatch && <i style={{ background: s.swatch }} />}
                  {s.name}
                </button>
              ))}
            </>
          ) : (
            <p className="bp-help">
              {skins.items.length} skins ({skins.items.map((s) => s.name).join(', ')}). Have the web build read a ?skin= link to switch them here.
            </p>
          )}
        </div>
      )}

      {jump && (
        <p className="ap-jump">
          Showing {jump.name}.{' '}
          <button onClick={() => onJump(null)}>Back to {floor.name}</button>
        </p>
      )}
      {link === undefined && !jump && <p className="bp-help">The web build has no link straight to {floor.name}, so this opens on the home screen. Give it a ?game= link (or a link in blueprint.app.json) to land here.</p>}

      <div className="ap-device">
        <span className="pv-notch" />
        <div className="ap-screen" ref={box}>
          <div className="ap-screen-inner" style={{ width: PHONE.w, height: PHONE.h, transform: `scale(${scale})` }}>
            {demo || !src ? (
              <MockSite project={p} device="mobile" />
            ) : stop ? null : (
              <iframe key={`${src}-${nonce}`} title={`${p.name}, ${floor.name}`} src={src} sandbox={SANDBOX} allow="autoplay; fullscreen; clipboard-write; vibrate" />
            )}
          </div>
          {!demo && src && stop && (
            <div className="ap-why">
              {!check.ok ? (
                <>
                  <b>Can’t open {SOURCE_LABEL[source].toLowerCase()}</b>
                  <span>
                    {check.error} ({hostOf(src)}).
                  </span>
                  {source === 'local' && <span>Start the web build first, e.g. npx expo start --web in the app’s folder, or set its port in Settings.</span>}
                  {source !== 'local' && <span>Check the app’s web address in Settings.</span>}
                </>
              ) : (
                <>
                  <b>This page won’t show inside another page</b>
                  <span>{check.blocked}. The Blueprint desktop app shows it anyway.</span>
                  <button onClick={() => setAnyway(true)}>Try anyway</button>
                </>
              )}
              {others.map((s) => (
                <button key={s} onClick={() => pick(s)}>
                  Try {SOURCE_LABEL[s]}
                  {s === 'local' && p.localPort ? ` (port ${p.localPort})` : ''}
                </button>
              ))}
              <button onClick={() => setNonce((n) => n + 1)}>Check again</button>
            </div>
          )}
        </div>
      </div>
      {!src && <p className="bp-help">Add the app’s web address (or the port its web build runs on) in Settings to use it here.</p>}
    </section>
  )
}

function Tile({ project, item, onOpen }: { project: Project; item: AppItem; onOpen: () => void }) {
  const first = item.images[0]
  return (
    <li>
      <button className="ap-tile" onClick={onOpen} title={item.shot ? `Show ${item.name} in the preview` : (item.note ?? item.name)}>
        <span className="ap-pic">
          {first ? <Picture project={project} img={first} alt={item.name} /> : item.shot ? <Icon.mobile size={22} /> : <span className="ap-none">No picture</span>}
        </span>
        <b>
          {item.swatch && <i style={{ background: item.swatch }} />}
          {item.name}
        </b>
        {item.note && <small>{item.note}</small>}
      </button>
    </li>
  )
}

interface Open {
  items: AppItem[]
  index: number
  title: string
}

export function AppFloorView({ project: p, index }: { project: Project; index: number }) {
  const setPart = useBp((s) => s.setPart)
  const [open, setOpen] = useState<Open | null>(null)
  const [jump, setJump] = useState<AppItem | null>(null)
  useEffect(() => setJump(null), [p.id, index])
  const floors = p.app?.floors ?? []
  const floor: AppFloor | undefined = floors[index]
  if (!p.app) return <p className="bp-help">Reading the app’s game modes and screens from GitHub…</p>
  // a manifest's `shot` items open in the preview; the rest are pictures
  const galleries = floor?.galleries.filter((g) => g.items.length) ?? []
  return (
    <>
      {floor ? (
        <>
          {floor.note && <p className="bp-help">{floor.note}</p>}
          <PhonePreview key={p.id} project={p} floor={floor} index={index} jump={jump} onJump={setJump} />
          {galleries.map((g) => (
            <section key={g.id} className="ap-gallery">
              <h4>{g.name}</h4>
              {g.note && <p className="bp-help">{g.note}</p>}
              <ul className="ap-grid">
                {g.items.map((it, k) => (
                  <Tile
                    key={it.id}
                    project={p}
                    item={it}
                    onOpen={() => {
                      if (it.shot && !it.images.length) setJump(it)
                      else setOpen({ items: g.items.filter((x) => x.images.length), index: g.items.filter((x) => x.images.length).indexOf(it), title: `${floor.name} · ${g.name}` })
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : (
        <p className="bp-help">No floor here.</p>
      )}
      <h4>All floors</h4>
      <ol className="bp-floors" reversed>
        {floors
          .map((f, j) => ({ f, j }))
          .reverse()
          .map(({ f, j }) => (
            <li key={f.id}>
              <button aria-pressed={j === index} onClick={() => setPart(`floor:${j}`)}>
                <b>{f.name}</b>
                <span>{[j === 0 ? 'home screen' : 'game mode', ...f.galleries.filter((g) => g.items.length).map((g) => g.name)].join(' · ')}</span>
              </button>
            </li>
          ))}
      </ol>
      <p className="bp-help">
        Read from {p.repo}
        {p.app.root ? `/${p.app.root}` : ''} at {p.app.sha.slice(0, 7)} {p.app.source === 'manifest' ? '(its blueprint.app.json)' : '(its code)'}, {relTime(p.app.checked)}. A new push updates it.
      </p>
      {open && open.index >= 0 && <Lightbox project={p} open={open} onMove={(i) => setOpen({ ...open, index: i })} onClose={() => setOpen(null)} />}
    </>
  )
}

/** Full screen: one option at a time, its pictures side by side; arrows (or ← →) go through the rest. */
function Lightbox({ project: p, open, onMove, onClose }: { project: Project; open: Open; onMove: (i: number) => void; onClose: () => void }) {
  const item = open.items[open.index]
  const n = open.items.length

  useEffect(() => {
    const entered = !document.fullscreenElement
    if (entered) document.documentElement.requestFullscreen?.().catch(() => {})
    return () => {
      if (entered && document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      } else if (e.key === 'ArrowRight') onMove((open.index + 1) % n)
      else if (e.key === 'ArrowLeft') onMove((open.index - 1 + n) % n)
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [open.index, n, onClose, onMove])

  const host = document.querySelector('.bp') ?? document.body
  return createPortal(
    <div className="ap-box" role="dialog" aria-modal aria-label={item.name} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <header>
        <div>
          <small>{open.title}</small>
          <h3>
            {item.swatch && <i style={{ background: item.swatch }} />}
            {item.name}
          </h3>
          {item.note && <p>{item.note}</p>}
        </div>
        <span>
          {open.index + 1} of {n}
        </span>
        <button onClick={onClose} aria-label="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="ap-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {n > 1 && (
          <button className="ap-nav" data-side="left" onClick={() => onMove((open.index - 1 + n) % n)} aria-label="Previous">
            ‹
          </button>
        )}
        <div className="ap-pics" data-count={item.images.length}>
          {item.images.map((img) => (
              <figure key={img.path + (img.crop?.index ?? '')} data-crop={!!img.crop}>
                <Picture project={p} img={img} alt={`${item.name}${img.label ? `, ${img.label.toLowerCase()}` : ''}`} big />
                {(img.label || item.images.length > 1) && <figcaption>{img.label ?? img.path.split('/').pop()}</figcaption>}
              </figure>
            ))}
        </div>
        {n > 1 && (
          <button className="ap-nav" data-side="right" onClick={() => onMove((open.index + 1) % n)} aria-label="Next">
            ›
          </button>
        )}
      </div>
    </div>,
    host,
  )
}
