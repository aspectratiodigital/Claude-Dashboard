import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AppFloor, AppImage, AppItem, Project } from '../../data/types'
import { relTime } from '../../data/derive'
import { useBp } from './state'

// The floors of an app's building: its home screen, then each game mode or
// screen, with the options that exist for it (skins, card designs, images)
// shown as pictures. Click one to look at it full screen.

const assetUrl = (p: Project, img: AppImage) => `./api/app/asset?project=${encodeURIComponent(p.id)}&path=${encodeURIComponent(img.path)}`
const shotUrl = (p: Project, q: string, fresh = 0) => `./api/app/shot?project=${encodeURIComponent(p.id)}&q=${encodeURIComponent(q)}${fresh ? `&fresh=${fresh}` : ''}`
const liveUrl = (p: Project, q: string) => (p.url ? `${p.url.replace(/\/?$/, '/')}?${q}` : null)

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

/** A screenshot of the live app, with a note when one can't be taken. */
function Shot({ project, q, fresh = 0 }: { project: Project; q: string; fresh?: number }) {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  useEffect(() => setState('loading'), [q, fresh])
  if (!project.url) return <span className="ap-none">Add the app’s web address in Settings to see it</span>
  return (
    <>
      {state !== 'ok' && <span className="ap-none ap-over">{state === 'loading' ? 'Taking a screenshot…' : 'No screenshot. Open it to see it live'}</span>}
      <img src={shotUrl(project, q, fresh)} alt="" loading="lazy" draggable={false} data-state={state} onLoad={() => setState('ok')} onError={() => setState('failed')} />
    </>
  )
}

function Tile({ project, item, onOpen }: { project: Project; item: AppItem; onOpen: () => void }) {
  const first = item.images[0]
  return (
    <li>
      <button className="ap-tile" data-phone={!!item.shot} onClick={onOpen} title={item.note ?? item.name}>
        <span className="ap-pic">
          {item.shot ? <Shot project={project} q={item.shot} /> : first ? <Picture project={project} img={first} alt={item.name} /> : <span className="ap-none">No picture</span>}
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
  const floors = p.app?.floors ?? []
  const floor: AppFloor | undefined = floors[index]
  if (!p.app) return <p className="bp-help">Reading the app’s game modes and screens from GitHub…</p>
  return (
    <>
      {floor ? (
        <>
          {floor.note && <p className="bp-help">{floor.note}</p>}
          {floor.galleries.map((g) => (
            <section key={g.id} className="ap-gallery">
              <h4>{g.name}</h4>
              {g.note && <p className="bp-help">{g.note}</p>}
              <ul className="ap-grid" data-phone={g.items.some((i) => i.shot)}>
                {g.items.map((it, k) => (
                  <Tile key={it.id} project={p} item={it} onOpen={() => setOpen({ items: g.items, index: k, title: `${floor.name} · ${g.name}` })} />
                ))}
              </ul>
            </section>
          ))}
          {!floor.galleries.length && <p className="bp-help">Nothing to show on this floor yet. Give the web build a ?{floor.id === 'home' ? 'skin' : 'game'}= link, or list what’s here in a blueprint.app.json.</p>}
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
                <span>{f.galleries.map((g) => g.name).join(' · ') || (j === 0 ? 'home screen' : 'game mode')}</span>
              </button>
            </li>
          ))}
      </ol>
      <p className="bp-help">
        Read from {p.repo}
        {p.app.root ? `/${p.app.root}` : ''} at {p.app.sha.slice(0, 7)} {p.app.source === 'manifest' ? '(its blueprint.app.json)' : '(its code)'}, {relTime(p.app.checked)}. A new push updates it.
      </p>
      {open && <Lightbox project={p} open={open} onMove={(i) => setOpen({ ...open, index: i })} onClose={() => setOpen(null)} />}
    </>
  )
}

/** Full screen: one option at a time, its pictures side by side; arrows (or ← →) go through the rest. */
function Lightbox({ project: p, open, onMove, onClose }: { project: Project; open: Open; onMove: (i: number) => void; onClose: () => void }) {
  const item = open.items[open.index]
  const [live, setLive] = useState(false)
  const [fresh, setFresh] = useState(0)
  const n = open.items.length
  useEffect(() => setLive(false), [open.index])

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

  const url = item.shot ? liveUrl(p, item.shot) : null
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
        {item.shot && url && (
          <>
            <button onClick={() => setLive((v) => !v)}>{live ? 'Screenshot' : 'Open it live'}</button>
            {!live && <button onClick={() => setFresh(Date.now())}>Retake</button>}
            <a href={url} target="_blank" rel="noreferrer">
              In the browser
            </a>
          </>
        )}
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
        <div className="ap-pics" data-count={item.shot ? 1 : item.images.length}>
          {item.shot ? (
            <figure className="ap-phone">
              {live && url ? <iframe src={url} title={item.name} sandbox="allow-scripts allow-same-origin allow-forms" /> : <Shot project={p} q={item.shot} fresh={fresh} />}
            </figure>
          ) : (
            item.images.map((img) => (
              <figure key={img.path + (img.crop?.index ?? '')} data-crop={!!img.crop}>
                <Picture project={p} img={img} alt={`${item.name}${img.label ? `, ${img.label.toLowerCase()}` : ''}`} big />
                {(img.label || item.images.length > 1) && <figcaption>{img.label ?? img.path.split('/').pop()}</figcaption>}
              </figure>
            ))
          )}
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
