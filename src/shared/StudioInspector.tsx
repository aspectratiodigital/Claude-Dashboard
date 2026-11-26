import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudioElement, StudioMedia, StudioOp, StudioToken } from '../data/types'
import type { WordCount } from '../data/studio-api'
import { embedOf, squash } from '../data/studio'
import { Icon } from './icons'
import { Menu, MenuItem, NumberBox, Section, Seg, Spin, Swatch, TextField, Toggle, chooseFile, getJson, hexOf, post, pxOf, rangesAt, sameMedia, uploadFile, type RangeId, type StudioCtx } from './StudioUi'

// The Element tab: everything about what's selected on the canvas, in folding
// sections that only show when they apply. Content (words, buttons, links,
// form fields), Photo (swap, edit, focal point, alt text, backgrounds, video,
// SVG), Item (a card, FAQ, list item or slide in a run of them), Table,
// Design (size, weight, colour, alignment, spacing and columns on the site's
// own scale, for the screen sizes you pick), Arrange and Details.

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const newId = () => Math.random().toString(36).slice(2, 10)

/** a style change, replacing an earlier one of the same thing (clicking + three times is one edit) */
export function applyStyle(ctx: StudioCtx, targets: string[], props: Record<string, string>, media: StudioMedia | null) {
  const keys = Object.keys(props).sort().join()
  for (const o of ctx.ops) {
    if (o.kind === 'style' && o.page === ctx.path && targets.includes(o.selector) && Object.keys(o.props).sort().join() === keys && sameMedia(o.media, media)) ctx.removeOp(o.id)
  }
  ctx.act('style', { props, media })
}

const ANIM_ATTRS = ['data-reveal', 'data-split', 'data-aos', 'data-animate', 'data-anim', 'data-animation', 'data-sal', 'data-scroll', 'data-motion']

/** the pages of the site, for link boxes */
function PageList({ ctx }: { ctx: StudioCtx }) {
  return (
    <datalist id="st-page-list">
      {ctx.site.pages.map((p) => (
        <option key={p.path} value={p.path}>
          {p.title ?? ''}
        </option>
      ))}
    </datalist>
  )
}

// --- One element ---------------------------------------------------------------------------

export function Inspector({
  ctx,
  el,
  editing,
  locked,
  onLock,
  onPaste,
  onEmbed,
}: {
  ctx: StudioCtx
  el: StudioElement
  editing: boolean
  /** this element itself is locked */
  locked: boolean
  onLock: () => void
  onPaste: () => void
  onEmbed: () => void
}) {
  const frozen = el.locked
  const off = ctx.working || frozen
  const content = el.editable || !!el.button || el.href !== null || !!el.field || !!el.form?.thanks
  const photo = !!el.image || !!el.bg || !!el.media
  return (
    <div className="st-panel">
      <header className="st-el-head">
        <div>
          <b>{el.label}</b>
          {el.text && <small>“{cut(squash(el.text), 70)}”</small>}
        </div>
        <button className="st-btn" aria-pressed={locked} onClick={onLock} title={locked ? 'Unlock it, so it can be changed' : 'Lock it, so it can’t be changed or moved by accident'} disabled={frozen && !locked}>
          {locked ? <Icon.lock size={15} /> : <Icon.unlock size={15} />}
        </button>
        <button className="st-btn" onClick={() => ctx.openTab('claude')} title="Ask Claude to change this">
          <Icon.claude size={15} />
        </button>
        <button className="st-btn" onClick={() => ctx.tell({ type: 'clear' })} title="Deselect (Esc)">
          <Icon.close size={15} />
        </button>
      </header>
      <PageList ctx={ctx} />
      {frozen && (
        <p className="st-chip" data-tone="lock">
          <Icon.lock size={13} /> {locked ? 'Locked: unlock it (the padlock above) to change it.' : 'This is inside something locked. Unlock that in Layers to change it.'}
        </p>
      )}
      {editing && <p className="st-chip">Editing the words on the page. Enter or a click elsewhere finishes; Esc puts them back.</p>}
      {!frozen && (
        <>
          {content && <ContentSection ctx={ctx} el={el} editing={editing} off={off} />}
          {photo && <PhotoSection ctx={ctx} el={el} off={off} />}
          {el.item && <ItemSection ctx={ctx} el={el} off={off} />}
          {el.table && <TableSection ctx={ctx} el={el} off={off} />}
          <DesignSection ctx={ctx} el={el} targets={[el.selector]} off={off} />
          <ArrangeSection ctx={ctx} el={el} off={off} onPaste={onPaste} onEmbed={onEmbed} />
        </>
      )}
      <DetailsSection ctx={ctx} el={el} />
    </div>
  )
}

// --- Content -------------------------------------------------------------------------------

function ContentSection({ ctx, el, editing, off }: { ctx: StudioCtx; el: StudioElement; editing: boolean; off: boolean }) {
  return (
    <Section id="content" title="Content" icon={<Icon.text size={14} />}>
      {el.editable && !el.button && (
        <>
          <p className="st-text">{el.text ? cut(el.text, 280) : <em>No words yet</em>}</p>
          <div className="st-row">
            <button className="st-pill" onClick={() => ctx.tell({ type: 'edit-text' })} disabled={off || editing}>
              <Icon.text size={13} /> {editing ? 'Editing on the page…' : 'Edit the words'}
            </button>
          </div>
          <p className="st-tip">
            Or double-click them on the page. Select some words for the little bar: <b>bold</b>, <i>italic</i> and links (Ctrl B, Ctrl I, Ctrl K). Spelling is checked in UK English.
          </p>
          <Everywhere ctx={ctx} el={el} off={off} />
        </>
      )}
      {el.button && <ButtonEditor ctx={ctx} el={el} off={off} />}
      {!el.button && el.href !== null && (
        <TextField label={<><Icon.link size={13} /> Links to</>} value={el.href ?? ''} list="st-page-list" mono placeholder="/contact, https://…, tel:… or mailto:…" onCommit={(v) => ctx.act('link', { value: v })} disabled={off} />
      )}
      {el.field && <FieldEditor ctx={ctx} el={el} off={off} />}
      {el.form?.thanks && (
        <TextField
          label="Thank-you message"
          value={el.form.thanks.text}
          multiline
          onCommit={(v) => ctx.act('text', { value: v, target: el.form!.thanks!.selector })}
          disabled={off}
          extra={<small className="st-muted"> shown after the form is sent</small>}
        />
      )}
    </Section>
  )
}

/** words counted once per site version: where else they appear */
const counted = new Map<string, WordCount>()

/** the same words on other pages: change them all at once */
function Everywhere({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const text = squash(el.text)
  const key = `${ctx.projectId}|${ctx.site.sha}|${ctx.site.changed.length}|${text}`
  const [count, setCount] = useState<WordCount | null>(counted.get(key) ?? null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(false)
    if (text.length < 3 || text.length > 400) return setCount(null)
    const hit = counted.get(key)
    if (hit) return setCount(hit)
    setCount(null)
    let gone = false
    const t = setTimeout(
      () =>
        void post<WordCount>('./api/studio/count', { projectId: ctx.projectId, text })
          .then((c) => {
            counted.set(key, c)
            if (!gone) setCount(c)
          })
          .catch(() => {}),
      300,
    )
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [key, text, ctx.projectId])
  const pending = ctx.ops.some((o) => o.kind === 'text' && o.everywhere && squash(o.after) === text)
  if (!count || count.pages.length < 2) return null
  return (
    <div className="st-everywhere">
      <p>
        <Icon.globe size={13} /> These words are on <b>{count.pages.length} pages</b>
        {count.source > 1 ? `, in ${count.source} place${count.source === 1 ? '' : 's'} in the site’s files` : ''}.
      </p>
      {pending ? (
        <p className="st-muted">Changed everywhere (not saved yet).</p>
      ) : open ? (
        <TextField
          label="Change them on every page to"
          value={el.text}
          action="Change all"
          onCommit={(v) => {
            ctx.act('text', { value: v, scope: 'everywhere' })
            setOpen(false)
            ctx.say(`Changed on all ${count.pages.length} pages. Save to put it in the site.`)
          }}
          disabled={off}
        />
      ) : (
        <div className="st-row">
          <button className="st-pill" onClick={() => setOpen(true)} disabled={off}>
            Change on every page
          </button>
          <Menu label="Which pages" title="The pages with these words" align="left">
            {(done) =>
              count.pages.map((p) => (
                <MenuItem
                  key={p}
                  icon={<Icon.page size={14} />}
                  checked={p === ctx.path ? true : undefined}
                  onClick={() => {
                    done()
                    if (p !== ctx.path) ctx.go(p)
                  }}
                >
                  {p === '/' ? 'Home' : p}
                </MenuItem>
              ))
            }
          </Menu>
        </div>
      )}
    </div>
  )
}

function ButtonLook({ s }: { s: { label: string; background: string; color: string; border: string; classes: string } }) {
  return (
    <span className="st-btn-look">
      <i style={{ background: s.background, color: s.color, border: s.border }}>{cut(s.label || 'Button', 18)}</i>
      <small>{cut(s.classes, 30)}</small>
    </span>
  )
}

function ButtonEditor({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const b = el.button!
  const styles = ctx.design?.buttons ?? []
  const current = styles.find((s) => s.classes === b.classes)
  return (
    <div className="st-group">
      <h5>
        <Icon.pointer size={13} /> Button
      </h5>
      <TextField label="Words" value={squash(el.text)} onCommit={(v) => ctx.act('text', { value: v, target: 'button' })} disabled={off} />
      {el.href !== null && <TextField label="Goes to" value={el.href ?? ''} list="st-page-list" mono placeholder="/contact, https://…, tel:… or mailto:…" onCommit={(v) => ctx.act('link', { value: v, target: 'button' })} disabled={off} />}
      {styles.length > 1 && (
        <div className="st-prop">
          <span>Style</span>
          <Menu label={current ? <ButtonLook s={current} /> : 'Its own style'} title="Pick one of the site’s button styles" align="left" wide disabled={off}>
            {(done) =>
              styles.map((s) => (
                <MenuItem
                  key={s.classes}
                  checked={s.classes === b.classes}
                  onClick={() => {
                    done()
                    if (s.classes !== b.classes) ctx.act('attr', { attr: 'class', value: s.classes, target: 'button' })
                  }}
                >
                  <ButtonLook s={s} />
                </MenuItem>
              ))
            }
          </Menu>
        </div>
      )}
      {el.href !== null && (
        <Toggle on={b.newTab} onChange={(on) => ctx.act('attr', { attr: 'target', value: on ? '_blank' : null, target: 'button' })} disabled={off}>
          Opens in a new tab
        </Toggle>
      )}
    </div>
  )
}

const NO_PLACEHOLDER = ['checkbox', 'radio', 'select', 'select-one', 'submit', 'button', 'hidden', 'file', 'range', 'color', 'date']

function FieldEditor({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const f = el.field!
  return (
    <div className="st-group">
      <h5>
        <Icon.text size={13} /> Form field <small>{f.type}</small>
      </h5>
      {f.labelSelector && <TextField label="Label" value={f.label ?? ''} onCommit={(v) => ctx.act('text', { value: v, target: f.labelSelector })} disabled={off} />}
      {!NO_PLACEHOLDER.includes(f.type) && <TextField label="Hint inside the box" value={f.placeholder ?? ''} allowEmpty placeholder="e.g. Your name" onCommit={(v) => ctx.act('attr', { attr: 'placeholder', value: v || null, target: 'field' })} disabled={off} />}
      <Toggle on={f.required} onChange={(on) => ctx.act('attr', { attr: 'required', value: on ? '' : null, target: 'field' })} disabled={off}>
        Must be filled in
      </Toggle>
    </div>
  )
}

// --- Photo, background, video ------------------------------------------------------------------

function PhotoSection({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const img = el.image
  const inlineSvg = el.tag === 'svg' || (!!img?.svg && !img.src)
  const svg = !!img?.svg
  const [busy, setBusy] = useState<string | null>(null)
  const [suggested, setSuggested] = useState<string | null>(null)
  const [recolour, setRecolour] = useState(inlineSvg)
  useEffect(() => {
    setSuggested(null)
    setRecolour(inlineSvg)
  }, [el.selector, inlineSvg])
  const file = img?.src ? decodeURIComponent(img.src.split('/').pop()?.split('?')[0] ?? '') : ''

  const swapSvg = async () => {
    const f = await chooseFile('.svg,image/svg+xml')
    if (!f) return
    if (!/\.svg$/i.test(f.name) && f.type !== 'image/svg+xml') return ctx.say('That isn’t an SVG file.')
    setBusy('svg')
    try {
      const u = await uploadFile(f)
      const markup = inlineSvg ? (await getJson<{ markup: string }>(`./api/studio/svg?upload=${u.id}`)).markup : undefined
      ctx.act('svg', { upload: u.id, name: u.name, markup, recolour })
      ctx.say('Swapped. Save to put it in the site.')
    } catch (e) {
      ctx.say((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const writeAlt = async () => {
    if (!img?.src) return
    setBusy('alt')
    setSuggested(null)
    try {
      const src = new URL(img.src, `${ctx.origin}${ctx.path}`).href
      const r = await post<{ alt: string }>('./api/studio/alt', { src, context: [ctx.seo?.title, el.item?.label, el.text && cut(el.text, 120)].filter(Boolean).join(' · ') })
      setSuggested(r.alt)
    } catch (e) {
      ctx.say((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // a new photo keeps the old one's alt text: say so, until it's looked at
  const mine = ctx.ops.map((o, i) => [o, i] as const).filter(([o]) => o.selector === el.selector)
  const swappedAt = Math.max(-1, ...mine.filter(([o]) => o.kind === 'image').map(([, i]) => i))
  const altAt = Math.max(-1, ...mine.filter(([o]) => o.kind === 'alt').map(([, i]) => i))
  const [altFits, setAltFits] = useState<string | null>(null)
  const staleAlt = !!img?.alt && swappedAt > altAt && altFits !== `${el.selector}|${swappedAt}`

  const swapVideo = async () => {
    const f = await chooseFile('video/mp4,video/webm')
    if (!f) return
    if (!/^video\/(mp4|webm)$/.test(f.type)) return ctx.say('Videos need to be MP4 or WebM.')
    setBusy('video')
    try {
      const u = await uploadFile(f)
      ctx.act('video', { upload: u.id, name: u.name })
      ctx.say('Video swapped. Save to put it in the site.')
    } catch (e) {
      ctx.say((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section id="photo" title={el.media?.kind === 'video' ? 'Video' : el.media?.kind === 'embed' ? 'Embed' : img ? (svg ? 'Logo or icon' : 'Photo') : 'Background'} icon={el.media ? <Icon.video size={14} /> : <Icon.image size={14} />}>
      {img && (
        <>
          {img.src && !inlineSvg && (
            <figure className="st-img">
              {el.tag === 'img' && !svg && img.fit === 'cover' ? <Focal ctx={ctx} el={el} off={off} /> : <img src={img.src} alt="" />}
              <figcaption>
                {img.width} × {img.height} · {cut(file, 40)}
              </figcaption>
            </figure>
          )}
          <div className="st-actions">
            {!inlineSvg && (
              <button className="st-act" onClick={() => ctx.pickPhoto('image')} disabled={off}>
                <Icon.image size={15} /> Replace
              </button>
            )}
            {!svg && img.src && (
              <button className="st-act" onClick={ctx.editPhoto} disabled={off} title="Crop, straighten and light touch-ups">
                <Icon.crop size={15} /> Crop and adjust
              </button>
            )}
            {svg && (
              <button className="st-act" onClick={swapSvg} disabled={off || busy === 'svg'} title="Swap for another SVG, kept at this size">
                <Icon.image size={15} /> {busy === 'svg' ? 'Uploading…' : 'Swap the SVG'}
              </button>
            )}
          </div>
          {svg && (
            <Toggle on={recolour} onChange={setRecolour} title="The new logo or icon takes the colour of the text around it, like the site’s own icons">
              Match the colour around it
            </Toggle>
          )}
          {!svg && el.tag === 'img' && img.fit === 'cover' && <p className="st-tip">Click the photo above to set what stays in view when it’s cropped to fit (its focal point).</p>}
          {!inlineSvg && (
            <>
              <TextField
                label="Alt text"
                extra={!img.alt ? <em> missing</em> : undefined}
                value={img.alt}
                placeholder="What the photo shows, for screen readers and Google"
                onCommit={(v) => ctx.act('alt', { value: v })}
                disabled={off}
              />
              {staleAlt && suggested === null && (
                <p className="st-tip st-warn">
                  This still describes the old photo. Check it fits the new one, or write it from the photo.{' '}
                  <button className="st-link" onClick={() => setAltFits(`${el.selector}|${swappedAt}`)}>
                    It fits
                  </button>
                </p>
              )}
              {suggested !== null ? (
                <div className="st-suggest">
                  <p>“{suggested}”</p>
                  <div className="st-row">
                    <button
                      className="st-pill"
                      onClick={() => {
                        ctx.act('alt', { value: suggested })
                        setSuggested(null)
                      }}
                      disabled={off}
                    >
                      <Icon.check size={13} /> Use it
                    </button>
                    <button className="st-pill" onClick={() => setSuggested(null)}>
                      No thanks
                    </button>
                  </div>
                </div>
              ) : (
                <div className="st-row">
                  <button className="st-pill" onClick={writeAlt} disabled={off || !img.src || busy === 'alt'} title="Claude looks at the photo and describes it">
                    {busy === 'alt' ? <i className="st-spin" /> : <Icon.wand size={13} />} {busy === 'alt' ? 'Looking at the photo…' : 'Write it from the photo'}
                  </button>
                  {img.alt !== '' && (
                    <button className="st-pill" onClick={() => ctx.act('alt', { value: '' })} disabled={off} title="A photo that’s only decoration: screen readers skip it">
                      Decorative
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {el.bg && (
        <div className="st-group">
          <h5>
            <Icon.image size={13} /> Background photo
          </h5>
          <figure className="st-img">
            <img src={el.bg} alt="" />
          </figure>
          <button className="st-pill" onClick={() => ctx.pickPhoto('bg')} disabled={off}>
            Replace the background
          </button>
        </div>
      )}
      {el.media?.kind === 'video' && (
        <div className="st-group">
          <p className="st-muted">{cut(decodeURIComponent(el.media.src.split('/').pop() ?? 'video'), 50)}</p>
          <button className="st-pill" onClick={swapVideo} disabled={off || busy === 'video'}>
            <Icon.video size={13} /> {busy === 'video' ? 'Uploading…' : 'Replace the video'}
          </button>
          <p className="st-tip">MP4 or WebM, up to 25 MB. Or drop a video file onto it on the page.</p>
        </div>
      )}
      {el.media?.kind === 'embed' && (
        <TextField
          label={`${{ youtube: 'YouTube video', vimeo: 'Vimeo video', maps: 'Google map', other: 'Embedded page' }[el.media.provider ?? 'other']}: its link`}
          value={el.media.src}
          mono
          action="Change"
          placeholder="Paste a YouTube, Vimeo or Google Maps link"
          onCommit={(v) => {
            const e = embedOf(v)
            if (!e) return ctx.say('That isn’t a YouTube, Vimeo or Google Maps link.')
            ctx.act('attr', { attr: 'src', value: e.src, target: el.tag === 'iframe' ? 'self' : `${el.selector} > iframe` })
          }}
          disabled={off}
        />
      )}
    </Section>
  )
}

/** the photo, clicked to set the part that stays in view when it's cropped to fit */
function Focal({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const img = el.image!
  const [x, y] = useMemo(() => {
    const parts = (img.position || '50% 50%').split(/\s+/).map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) : p === 'left' || p === 'top' ? 0 : p === 'right' || p === 'bottom' ? 100 : 50))
    return [parts[0] ?? 50, parts[1] ?? 50]
  }, [img.position])
  const pick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (off) return
    const r = e.currentTarget.getBoundingClientRect()
    const nx = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100)
    const ny = Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 100)
    applyStyle(ctx, [el.selector], { 'object-position': `${nx}% ${ny}%` }, null)
  }
  return (
    <button className="st-focal" onClick={pick} title="Click the part of the photo that matters most" disabled={off}>
      <img src={img.src} alt="" />
      <i style={{ left: `${x}%`, top: `${y}%` }} />
    </button>
  )
}

// --- Items and tables ------------------------------------------------------------------------

const ITEM_WORD: Record<NonNullable<StudioElement['item']>['kind'], string> = { list: 'list item', faq: 'question', card: 'card', slide: 'slide', row: 'row', item: 'item' }

function ItemSection({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const it = el.item!
  const word = ITEM_WORD[it.kind]
  const Word = word[0].toUpperCase() + word.slice(1)
  return (
    <Section id="item" title={`${Word} ${it.index + 1} of ${it.count}`} icon={<Icon.list size={14} />}>
      <div className="st-actions">
        <button className="st-act" onClick={() => ctx.act('duplicate', { target: 'item', edit: true })} disabled={off} title={`A new ${word} straight after this one, ready for its words`}>
          <Icon.plus size={15} /> Add a {word}
        </button>
        <button className="st-act" data-tone="bad" onClick={() => ctx.act('hide', { target: 'item', scope: 'everywhere' })} disabled={off || it.count < 2}>
          <Icon.trash size={15} /> Remove this {word}
        </button>
        <button className="st-act" onClick={() => ctx.tell({ type: 'order', on: true, target: 'item' })} disabled={off || it.index <= 0}>
          <Icon.arrowUp size={15} /> Move earlier
        </button>
        <button className="st-act" onClick={() => ctx.tell({ type: 'order', on: false, target: 'item' })} disabled={off || it.index >= it.count - 1}>
          <Icon.arrowDown size={15} /> Move later
        </button>
      </div>
      {(el.image || it.kind === 'slide') && (
        <button
          className="st-pill"
          onClick={() => {
            ctx.act('duplicate', { target: 'item' })
            setTimeout(() => ctx.pickPhoto('image'), 350)
          }}
          disabled={off}
        >
          <Icon.image size={13} /> Add a {word} with a new photo
        </button>
      )}
    </Section>
  )
}

function TableSection({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const t = el.table!
  const go = (action: 'add-row' | 'remove-row' | 'add-col' | 'remove-col') => ctx.act('table', { table: action, row: t.row, col: t.col, target: t.selector })
  return (
    <Section id="table" title="Table" icon={<Icon.table size={14} />} badge={<small className="st-sec-note">row {t.row + 1}, column {t.col + 1}</small>}>
      <div className="st-actions">
        <button className="st-act" onClick={() => go('add-row')} disabled={off}>
          <Icon.plus size={15} /> Row below
        </button>
        <button className="st-act" data-tone="bad" onClick={() => go('remove-row')} disabled={off || t.rows < 2}>
          <Icon.minus size={15} /> Remove row
        </button>
        <button className="st-act" onClick={() => go('add-col')} disabled={off}>
          <Icon.plus size={15} /> Column after
        </button>
        <button className="st-act" data-tone="bad" onClick={() => go('remove-col')} disabled={off || t.cols < 2}>
          <Icon.minus size={15} /> Remove column
        </button>
      </div>
      <p className="st-tip">
        {t.rows} rows × {t.cols} columns. Double-click a cell to change its words.
      </p>
    </Section>
  )
}

// --- Design ----------------------------------------------------------------------------------

const WEIGHT_NAME: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' }

/** the site's colours, one of each */
function coloursOf(tokens: StudioToken[]) {
  const seen = new Set<string>()
  const out: { name: string; value: string; hex: string | null }[] = []
  for (const t of tokens) {
    if (t.kind !== 'colour' || /shadow|overlay|scrim/i.test(t.name)) continue
    const hex = hexOf(t.value)
    const key = hex ?? t.value
    if (seen.has(key) || /rgba?\([^)]*,\s*0\)|transparent/i.test(t.value)) continue
    seen.add(key)
    out.push({ name: t.name, value: t.value, hex })
    if (out.length >= 24) break
  }
  return out
}

interface Step {
  value: string
  label: string
  px: number | null
}
const PIXELS = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128]

/** the site's own spacing tokens (when it has a scale), then plain pixels */
function spacingOf(tokens: StudioToken[]): { site: Step[]; pixels: Step[] } {
  const site = tokens
    .filter((t) => t.kind === 'size' && /space|spacing|gap|gutter|pad|^--s-?\d|^--sp-/i.test(t.name))
    .map((t) => ({ value: `var(${t.name})`, label: `${t.name.replace(/^--/, '')}  ·  ${t.value}`, px: pxOf(t.value) }))
    .sort((a, b) => (a.px ?? 9999) - (b.px ?? 9999))
    .slice(0, 16)
  return { site, pixels: PIXELS.map((n) => ({ value: `${n}px`, label: `${n}px`, px: n })) }
}

export function DesignSection({ ctx, el, targets, off, multi }: { ctx: StudioCtx; el: StudioElement; targets: string[]; off: boolean; multi?: boolean }) {
  const { list, initial } = useMemo(() => rangesAt(ctx.design, ctx.width), [ctx.design, ctx.width])
  const [range, setRange] = useState<RangeId>(initial)
  useEffect(() => setRange(initial), [initial])
  const media = (list.find((r) => r.id === range) ?? list[0]).media
  const style = (props: Record<string, string>) => applyStyle(ctx, targets, props, media)
  const tokens = ctx.design?.tokens
  const colours = useMemo(() => coloursOf(tokens ?? []), [tokens])
  const spacing = useMemo(() => spacingOf(tokens ?? []), [tokens])
  const css = el.css
  const textual = !!el.text.trim() && !el.image
  const size = pxOf(css['font-size'])
  const family = (css['font-family'] ?? '').split(',')[0].replace(/["']/g, '').trim()
  const weights = useMemo(() => {
    const found = ctx.design?.fonts.find((f) => f.family.toLowerCase() === family.toLowerCase())?.weights ?? []
    const now = Number(css['font-weight']) || 400
    return [...new Set([...(found.length ? found : [300, 400, 500, 600, 700, 800]), now])].sort((a, b) => a - b)
  }, [ctx.design, family, css])
  const align = (css['text-align'] === 'start' ? 'left' : css['text-align'] === 'end' ? 'right' : css['text-align']) as 'left' | 'center' | 'right'
  const mine = ctx.ops.filter((o) => o.kind === 'style' && o.page === ctx.path && targets.includes(o.selector))
  const cols = el.layout ? String(Math.min(el.layout.columns, 9)) : null

  return (
    <Section
      id="design"
      title="Design"
      icon={<Icon.palette size={14} />}
      actions={
        mine.length > 0 ? (
          <button className="st-sec-act" onClick={() => mine.forEach((o) => ctx.removeOp(o.id))} disabled={off} title="Take back the design changes made to this">
            Reset ({mine.length})
          </button>
        ) : undefined
      }
    >
      <label className="st-prop">
        <span>Applies to</span>
        <select value={range} onChange={(e) => setRange(e.target.value as RangeId)} disabled={off}>
          {list.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {!ctx.design && <Spin>Reading the site’s styles…</Spin>}
      {textual && (
        <>
          <div className="st-prop">
            <span>Text size</span>
            <div className="st-inline">
              <button className="st-mini" onClick={() => size && style({ 'font-size': `${Math.max(8, Math.round(size - (size > 32 ? 2 : 1)))}px` })} disabled={off || !size} title="Smaller">
                <Icon.minus size={13} />
              </button>
              <NumberBox value={size === null ? null : Math.round(size)} min={8} max={200} label="Text size in pixels" onCommit={(n) => style({ 'font-size': `${n}px` })} />
              <button className="st-mini" onClick={() => size && style({ 'font-size': `${Math.min(200, Math.round(size + (size >= 32 ? 2 : 1)))}px` })} disabled={off || !size} title="Bigger">
                <Icon.plus size={13} />
              </button>
            </div>
          </div>
          <label className="st-prop">
            <span>Weight</span>
            <select value={String(Number(css['font-weight']) || 400)} onChange={(e) => style({ 'font-weight': e.target.value })} disabled={off} title={family ? `The weights of ${family} the site loads` : undefined}>
              {weights.map((w) => (
                <option key={w} value={w}>
                  {WEIGHT_NAME[w] ?? w} ({w})
                </option>
              ))}
            </select>
          </label>
          <div className="st-prop">
            <span>Align</span>
            <Seg
              small
              label="Text alignment"
              value={['left', 'center', 'right'].includes(align) ? align : ('left' as const)}
              options={[
                ['left', <Icon.alignLeft size={14} />, 'Left'],
                ['center', <Icon.alignCenter size={14} />, 'Centre'],
                ['right', <Icon.alignRight size={14} />, 'Right'],
              ]}
              onChange={(v) => !off && style({ 'text-align': v })}
            />
          </div>
          <ColourRow label="Text colour" current={css.color ?? ''} colours={colours} onPick={(v) => style({ color: v })} off={off} />
        </>
      )}
      <ColourRow label="Background" current={css['background-color'] ?? ''} colours={colours} onPick={(v) => style({ 'background-color': v })} off={off} none />
      <SpaceRow label="Space above" now={css['margin-top']} spacing={spacing} onPick={(v) => style({ 'margin-top': v })} off={off} />
      <SpaceRow label="Space below" now={css['margin-bottom']} spacing={spacing} onPick={(v) => style({ 'margin-bottom': v })} off={off} />
      <SpaceRow label="Inside, top and bottom" now={css['padding-top']} spacing={spacing} onPick={(v) => style({ 'padding-top': v, 'padding-bottom': v })} off={off} />
      <SpaceRow label="Inside, left and right" now={css['padding-left']} spacing={spacing} onPick={(v) => style({ 'padding-left': v, 'padding-right': v })} off={off} />
      {el.layout && cols && (
        <>
          <div className="st-prop">
            <span>Columns</span>
            <Seg
              small
              label="Columns"
              value={cols}
              options={[
                ['1', '1', 'One column'],
                ['2', '2', 'Two columns'],
                ['3', '3', 'Three columns'],
                ['4', '4', 'Four columns'],
              ]}
              onChange={(n) => !off && style(el.layout!.display === 'grid' ? { 'grid-template-columns': `repeat(${n}, minmax(0, 1fr))` } : { display: 'grid', 'grid-template-columns': `repeat(${n}, minmax(0, 1fr))` })}
            />
          </div>
          <SpaceRow label="Gap between" now={css.gap?.split(' ')[0]} spacing={spacing} onPick={(v) => style({ gap: v })} off={off} />
        </>
      )}
      {!multi && <AnimationRow ctx={ctx} el={el} off={off} />}
    </Section>
  )
}

function ColourRow({ label, current, colours, onPick, off, none }: { label: string; current: string; colours: ReturnType<typeof coloursOf>; onPick: (v: string) => void; off: boolean; none?: boolean }) {
  const hex = hexOf(current)
  const clear = !current || /rgba\([^)]*,\s*0\)$|transparent/.test(current)
  const match = colours.find((c) => c.hex && c.hex === hex && !clear)
  const timer = useRef<number | undefined>(undefined)
  return (
    <div className="st-prop st-prop-top">
      <span>
        {label}
        <small>{clear ? 'none' : match ? match.name.replace(/^--/, '') : (hex ?? current)}</small>
      </span>
      <div className="st-swatches">
        {none && <button className="st-sw" data-none aria-pressed={clear} title="None" onClick={() => onPick('transparent')} disabled={off} />}
        {colours.map((c) => (
          <button key={c.name} className="st-sw" style={{ background: c.value }} aria-pressed={!!match && match.name === c.name} title={`${c.name.replace(/^--/, '')}  ${c.value}`} onClick={() => onPick(`var(${c.name})`)} disabled={off} />
        ))}
        <label className="st-sw st-sw-any" title="Any colour (better to stick to the site’s own)" data-disabled={off || undefined}>
          <input
            type="color"
            value={hex ?? '#000000'}
            disabled={off}
            onChange={(e) => {
              const v = e.target.value
              clearTimeout(timer.current)
              timer.current = window.setTimeout(() => onPick(v), 250)
            }}
          />
        </label>
      </div>
      {!colours.length && <Swatch c={current} />}
    </div>
  )
}

function SpaceRow({ label, now, spacing, onPick, off }: { label: string; now: string | undefined; spacing: ReturnType<typeof spacingOf>; onPick: (v: string) => void; off: boolean }) {
  const n = pxOf(now)
  return (
    <label className="st-prop">
      <span>{label}</span>
      <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} disabled={off}>
        <option value="">{n === null ? (now ?? '') : `${n}px`} (now)</option>
        {spacing.site.length > 0 && (
          <optgroup label="The site’s spacing">
            {spacing.site.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Pixels">
          {spacing.pixels.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  )
}

function AnimationRow({ ctx, el, off }: { ctx: StudioCtx; el: StudioElement; off: boolean }) {
  const anims = ctx.design?.animations ?? []
  const mine = (after: 'off' | 'on') => ctx.ops.find((o): o is Extract<StudioOp, { kind: 'attr' }> => o.kind === 'attr' && o.page === ctx.path && o.selector === el.selector && ANIM_ATTRS.includes(o.name) && (after === 'off' ? o.after === null : o.after !== null))
  const turnedOff = mine('off')
  const added = mine('on')
  if (el.animation || turnedOff)
    return (
      <Toggle
        on={!!el.animation}
        disabled={off}
        onChange={(on) => {
          if (on && turnedOff) ctx.removeOp(turnedOff.id)
          else if (!on && added) ctx.removeOp(added.id)
          else if (!on && el.animation) ctx.act('attr', { attr: el.animation.attr, value: null })
        }}
        title="The site fades or slides this in as it scrolls into view"
      >
        Animates in as you scroll
      </Toggle>
    )
  if (!anims.length) return null
  return (
    <label className="st-prop">
      <span>Animation</span>
      <select
        value=""
        disabled={off}
        onChange={(e) => {
          if (!e.target.value) return
          const [attr, value] = JSON.parse(e.target.value) as [string, string]
          ctx.act('attr', { attr, value })
        }}
      >
        <option value="">None</option>
        {anims.flatMap((a) =>
          a.values.map((v) => (
            <option key={`${a.attr}=${v}`} value={JSON.stringify([a.attr, v])}>
              Like the site’s others: {a.attr.replace(/^data-/, '')}
              {v ? ` ${v}` : ''}
            </option>
          )),
        )}
      </select>
    </label>
  )
}

// --- Arrange and details -----------------------------------------------------------------------

function ArrangeSection({ ctx, el, off, onPaste, onEmbed }: { ctx: StudioCtx; el: StudioElement; off: boolean; onPaste: () => void; onEmbed: () => void }) {
  const small = ctx.width < 900
  return (
    <Section id="arrange" title="Arrange" icon={<Icon.layers size={14} />}>
      <div className="st-actions">
        {el.siblings > 1 && (
          <>
            <button className="st-act" onClick={() => ctx.tell({ type: 'order', on: true })} disabled={off || el.index <= 0}>
              <Icon.arrowUp size={15} /> Move earlier
            </button>
            <button className="st-act" onClick={() => ctx.tell({ type: 'order', on: false })} disabled={off || el.index >= el.siblings - 1}>
              <Icon.arrowDown size={15} /> Move later
            </button>
          </>
        )}
        {el.moved && (
          <button className="st-act" onClick={() => ctx.act('unmove')} disabled={off}>
            <Icon.undo size={15} /> Put back
          </button>
        )}
        <button className="st-act" onClick={() => ctx.act('duplicate')} disabled={off} title="A copy straight after it (Ctrl D)">
          <Icon.copy size={15} /> Duplicate
        </button>
        <button className="st-act" onClick={() => ctx.tell({ type: 'copy' })} title="Copy it to paste on another page of this site (Ctrl C)">
          <Icon.copy size={15} /> Copy
        </button>
        <button className="st-act" onClick={onPaste} disabled={off} title="Paste what you copied straight after this (Ctrl V)">
          <Icon.paste size={15} /> Paste after
        </button>
        <Menu label="Add after" icon={<Icon.plus size={15} />} title="Add something straight after this" align="left" disabled={off}>
          {(done) => (
            <>
              <MenuItem
                icon={<Icon.image size={15} />}
                onClick={() => {
                  done()
                  ctx.pickPhoto('add-image')
                }}
              >
                A photo
              </MenuItem>
              <MenuItem
                icon={<Icon.video size={15} />}
                onClick={() => {
                  done()
                  onEmbed()
                }}
              >
                A video or map
              </MenuItem>
            </>
          )}
        </Menu>
        <button className="st-act" onClick={() => ctx.act('hide', { scope: 'this-size' })} disabled={off} title={small ? 'Hidden below 900px wide, still shown on laptops' : 'Hidden from 900px wide, still shown on phones and tablets'}>
          <Icon.eyeOff size={15} /> {small ? 'Hide on phones' : 'Hide on laptops'}
        </button>
        <button className="st-act" data-tone="bad" onClick={() => ctx.act('hide', { scope: 'everywhere' })} disabled={off} title="Take it off the page (Delete)">
          <Icon.trash size={15} /> Remove
        </button>
      </div>
    </Section>
  )
}

function DetailsSection({ ctx, el }: { ctx: StudioCtx; el: StudioElement }) {
  return (
    <Section id="details" title="Details" icon={<Icon.sliders size={14} />} open={false}>
      <dl className="st-dl">
        <dt>Size</dt>
        <dd>
          {el.rect.w} × {el.rect.h}
        </dd>
        <dt>Type</dt>
        <dd>{el.style.font}</dd>
        <dt>Colour</dt>
        <dd>
          <Swatch c={el.style.color} /> {el.style.color}
        </dd>
        {el.style.background !== 'rgba(0, 0, 0, 0)' && (
          <>
            <dt>Background</dt>
            <dd>
              <Swatch c={el.style.background} /> {el.style.background}
            </dd>
          </>
        )}
        <dt>Padding</dt>
        <dd>{el.style.padding}</dd>
        <dt>Margin</dt>
        <dd>{el.style.margin}</dd>
        {el.classes.length > 0 && (
          <>
            <dt>Classes</dt>
            <dd>{el.classes.join(' ')}</dd>
          </>
        )}
      </dl>
      <button className="st-pill" onClick={() => ctx.tell({ type: 'reveal', selector: el.selector })}>
        Scroll to it
      </button>
      <code className="st-selector" title="Where it is in the page">
        {el.selector}
      </code>
    </Section>
  )
}

// --- Several at once ---------------------------------------------------------------------------

export function MultiInspector({ ctx, el, others, locked, onLock }: { ctx: StudioCtx; el: StudioElement; others: { selector: string; label: string; text: string }[]; locked: string[]; onLock: (selector: string) => void }) {
  const all = [...others, { selector: el.selector, label: el.label, text: el.text }]
  const allLocked = all.every((a) => locked.includes(a.selector))
  const off = ctx.working
  const lockAll = () => {
    for (const a of all) if (allLocked || !locked.includes(a.selector)) onLock(a.selector)
  }
  const small = ctx.width < 900
  return (
    <div className="st-panel">
      <header className="st-el-head">
        <div>
          <b>{all.length} selected</b>
          <small>Shift-click on the page to add or take one away</small>
        </div>
        <button className="st-btn" aria-pressed={allLocked} onClick={lockAll} title={allLocked ? 'Unlock them all' : 'Lock them all'}>
          {allLocked ? <Icon.lock size={15} /> : <Icon.unlock size={15} />}
        </button>
        <button className="st-btn" onClick={() => ctx.tell({ type: 'clear' })} title="Deselect (Esc)">
          <Icon.close size={15} />
        </button>
      </header>
      <ul className="st-multi">
        {all.map((a) => (
          <li key={a.selector} onMouseEnter={() => ctx.tell({ type: 'hover', selector: a.selector })} onMouseLeave={() => ctx.tell({ type: 'hover', selector: null })}>
            <button onClick={() => ctx.tell({ type: 'reveal', selector: a.selector })} title="Select just this one">
              {locked.includes(a.selector) && <Icon.lock size={12} />}
              <b>{a.label}</b>
              {a.text && <small>{cut(squash(a.text), 40)}</small>}
            </button>
            <button className="st-btn" onClick={() => ctx.tell({ type: 'reveal', selector: a.selector, add: true })} title="Take it out of the selection">
              <Icon.close size={12} />
            </button>
          </li>
        ))}
      </ul>
      <Section id="align" title="Line up" icon={<Icon.alignLeft size={14} />}>
        <div className="st-align" role="group" aria-label="Line them up">
          {(
            [
              ['left', 'Left edges'],
              ['center', 'Centres, side to side'],
              ['right', 'Right edges'],
              ['top', 'Tops'],
              ['middle', 'Middles, top to bottom'],
              ['bottom', 'Bottoms'],
            ] as const
          ).map(([how, title]) => (
            <button key={how} className="st-mini" onClick={() => ctx.tell({ type: 'align', how })} disabled={off} title={`Line up their ${title.toLowerCase()}`}>
              <AlignIcon how={how} />
            </button>
          ))}
        </div>
        <p className="st-tip">Each one moves at this screen width only, like dragging it. Locked ones stay put.</p>
      </Section>
      <DesignSection ctx={ctx} el={el} targets={all.map((a) => a.selector)} off={off} multi />
      <Section id="multi-arrange" title="Arrange" icon={<Icon.layers size={14} />}>
        <div className="st-actions">
          <button className="st-act" onClick={() => ctx.act('hide', { scope: 'this-size' })} disabled={off}>
            <Icon.eyeOff size={15} /> {small ? 'Hide on phones' : 'Hide on laptops'}
          </button>
          <button className="st-act" data-tone="bad" onClick={() => ctx.act('hide', { scope: 'everywhere' })} disabled={off}>
            <Icon.trash size={15} /> Remove all
          </button>
        </div>
      </Section>
    </div>
  )
}

function AlignIcon({ how }: { how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' }) {
  const v = how === 'left' || how === 'center' || how === 'right'
  const at = { left: 3, center: 8, right: 13, top: 3, middle: 8, bottom: 13 }[how]
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {v ? <path d={`M${at} 1.5v13`} /> : <path d={`M1.5 ${at}h13`} />}
      {v ? (
        <>
          <rect x={how === 'left' ? 3 : how === 'right' ? 6 : 4.5} y="3.5" width="7" height="3" rx="0.6" fill="currentColor" stroke="none" opacity=".85" />
          <rect x={how === 'left' ? 3 : how === 'right' ? 9 : 6} y="9.5" width="4" height="3" rx="0.6" fill="currentColor" stroke="none" opacity=".85" />
        </>
      ) : (
        <>
          <rect y={how === 'top' ? 3 : how === 'bottom' ? 6 : 4.5} x="3.5" height="7" width="3" rx="0.6" fill="currentColor" stroke="none" opacity=".85" />
          <rect y={how === 'top' ? 3 : how === 'bottom' ? 9 : 6} x="9.5" height="4" width="3" rx="0.6" fill="currentColor" stroke="none" opacity=".85" />
        </>
      )}
    </svg>
  )
}

export { newId }
