import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Project, StudioElement, StudioOp, StudioResult } from '../src/data/types.ts'
import { ghToken, githubAuth, loadSettings, psiKey, saveStudioSettings, studioPublic, type StudioKrystal } from './config.ts'
import { findClaude } from './assistant.ts'
import { pageShot } from './shots.ts'
import type { Draft } from './notes.ts'
import {
  askClaude,
  closeSite,
  detectKind,
  diffOf,
  discard,
  holdOps,
  job,
  openSite,
  previewPorts,
  publish,
  rebuild,
  record,
  runtimeOf,
  saveOps,
  studioEdits,
  studioState,
  touch,
} from './studio.ts'
import { contentFiles, findInText, inRepo, photoLibrary, photoUses, readContent, searchPages, sourceFiles, sourcePhotoFolders, textPattern, writeContent } from './studio-source.ts'
import { altFromPhoto, photoToFile, stockFetch, stockSearch, uploadedSvg } from './studio-media.ts'
import { history, krystalDeploy, krystalProblem, krystalStatus, preChecks, rollBack, scheduleOf, setSchedule, startScheduler, type KrystalState } from './studio-publish.ts'
import { analytics, napAcrossSite, psiDetail, searchConsole, weeklyCheck, weeklyDue, weeklyOf } from './studio-insights.ts'
import { phoneOff, phoneOn, phoneState, phoneUpdate } from './studio-share.ts'
import { log } from './util.ts'

// Studio's part of the local API: opening a site, saving and publishing edits,
// and everything the side panel reads (photos, content, history, checks,
// search and analytics). index.ts hands every /api/studio route here.

export interface StudioHost {
  projects(): Project[]
  login(): string | null
  /** read GitHub again now (after a push, for the deploy status) */
  refresh(): void
  note(d: Draft): void
  json(res: ServerResponse, code: number, body: unknown): void
  readBody(req: IncomingMessage, limit?: number): Promise<Record<string, unknown>>
}

// --- Checking edits from the browser ---------------------------------------------------------

const OP_KINDS = new Set(['text', 'image', 'move', 'order', 'link', 'alt', 'duplicate', 'hide', 'add-image', 'meta', 'style', 'attr', 'paste', 'table', 'bg', 'video', 'embed', 'svg', 'replace', 'theme', 'ask'])
const META_FIELDS = new Set(['title', 'description', 'og:title', 'og:description', 'og:image'])
const UPLOAD = /^[a-z0-9]{6,24}$/
/** a photo already in the site, as the preview serves it */
const SITE_SRC = /^\/(?!\/)[^\s<>"'`\\]{1,600}$/

/** A canvas edit from the browser, checked before it goes anywhere near the repo or a prompt. */
export function validOp(o: unknown): o is StudioOp {
  if (!o || typeof o !== 'object') return false
  const x = o as Record<string, unknown>
  const str = (k: string, max = 2000) => typeof x[k] === 'string' && (x[k] as string).length <= max
  const optStr = (k: string, max = 2000) => x[k] === undefined || str(k, max)
  const upload = (k: string) => str(k, 40) && UPLOAD.test(x[k] as string)
  const num = (k: string) => typeof x[k] === 'number' && Number.isFinite(x[k])
  if (!OP_KINDS.has(x.kind as string) || !str('id', 40) || !str('page', 400) || !str('selector', 1000) || !str('label', 200) || !str('text', 2000) || !optStr('made', 40)) return false
  switch (x.kind) {
    case 'text':
      return str('before', 20_000) && str('after', 20_000) && optStr('html', 40_000) && (x.everywhere === undefined || typeof x.everywhere === 'boolean')
    case 'image':
    case 'bg':
      return str('before', 2000) && str('name', 200) && (x.upload !== undefined ? upload('upload') : str('src', 600) && SITE_SRC.test(x.src as string))
    case 'add-image':
      return str('name', 200) && str('alt', 400) && (x.upload !== undefined ? upload('upload') : str('src', 600) && SITE_SRC.test(x.src as string))
    case 'meta':
      if (!META_FIELDS.has(x.field as string) || !str('before', 1000) || !str('after', 1000)) return false
      if (x.upload !== undefined && !upload('upload')) return false
      return x.field !== 'og:image' || typeof x.upload === 'string'
    case 'move':
      return num('dx') && num('dy') && num('width') && Array.isArray(x.snapped)
    case 'order':
      return (x.direction === 'earlier' || x.direction === 'later') && str('sibling', 400)
    case 'link':
    case 'alt':
      return str('before', 2000) && str('after', 2000) && !/^\s*(javascript|data|vbscript):/i.test(x.after as string)
    case 'hide':
      return (x.scope === 'everywhere' || x.scope === 'this-size') && num('width')
    case 'style': {
      const props = x.props as Record<string, unknown> | undefined
      const before = x.before as Record<string, unknown> | undefined
      if (!props || typeof props !== 'object' || !before || typeof before !== 'object' || !num('width')) return false
      const ok = (m: Record<string, unknown>) => Object.entries(m).length <= 30 && Object.entries(m).every(([k, v]) => /^-{0,2}[a-z][a-z-]{0,40}$/.test(k) && typeof v === 'string' && v.length <= 300 && !/[{};<>\\]|url\s*\(|expression\s*\(|@import/i.test(v))
      if (!ok(props) || !ok(before)) return false
      const m = x.media as Record<string, unknown> | null
      if (m === null || m === undefined) return true
      return typeof m === 'object' && (m.min === undefined || (typeof m.min === 'number' && m.min >= 0 && m.min < 10000)) && (m.max === undefined || (typeof m.max === 'number' && m.max >= 0 && m.max < 10000))
    }
    case 'attr': {
      if (!str('name', 60) || !/^[a-z][a-z0-9-:]*$/i.test(x.name as string) || /^on/i.test(x.name as string) || /^(srcdoc|style)$/i.test(x.name as string)) return false
      const v = (k: string) => x[k] === null || str(k, 2000)
      if (!v('before') || !v('after')) return false
      // addresses can't run script
      return !(/^(href|src|action|formaction|poster|data)$/i.test(x.name as string) && typeof x.after === 'string' && /^\s*(javascript|vbscript|data:text)/i.test(x.after))
    }
    case 'paste': {
      const f = x.from as Record<string, unknown> | undefined
      return str('html', 80_000) && !!f && typeof f === 'object' && typeof f.page === 'string' && typeof f.label === 'string' && typeof f.selector === 'string' && (f.page as string).length < 400
    }
    case 'table':
      return ['add-row', 'remove-row', 'add-col', 'remove-col'].includes(x.action as string) && num('row') && num('col')
    case 'video':
      return str('before', 2000) && upload('upload') && str('name', 200)
    case 'embed':
      return str('url', 2000) && str('src', 2000) && /^https:\/\//.test(x.src as string) && ['youtube', 'vimeo', 'maps', 'other'].includes(x.provider as string) && str('title', 200)
    case 'svg':
      return upload('upload') && str('name', 200) && typeof x.inline === 'boolean' && str('before', 2000) && typeof x.recolour === 'boolean' && optStr('markup', 200_000)
    case 'replace':
      return str('find', 500) && (x.find as string).trim().length > 0 && str('replace', 2000) && typeof x.matchCase === 'boolean' && typeof x.wholeWord === 'boolean' && (x.scope === 'site' || x.scope === 'page')
    case 'theme':
      return str('name', 80) && /^--[\w-]+$/.test(x.name as string) && str('before', 300) && str('after', 300) && !/[{};<>]/.test(x.after as string)
    case 'ask':
      return str('prompt', 4000) && (x.prompt as string).trim().length > 0
    default:
      return true
  }
}

const opsOf = (v: unknown, max = 300) => (Array.isArray(v) ? (v as unknown[]).filter(validOp).slice(0, max) : [])

// --- Helpers ---------------------------------------------------------------------------------

/** a page path from the browser: starts with /, no tricks */
const pageOf = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\/[^\s?#<>"'\\]{0,400}$/.test(s) && !s.includes('..') ? s : '/'
}

/** the live or preview address of one of the site's pages */
function addressOf(p: Project, page: string, which: unknown): string | null {
  const base = which === 'preview' ? (p.previewUrl ?? p.url) : (p.url ?? p.previewUrl)
  if (!base) return null
  try {
    const u = new URL(base)
    return new URL(page, u.origin).href
  } catch {
    return null
  }
}

const isSite = (p: Project) => p.kind !== 'app' && !p.app

let refreshed = 0
const lastPush = new Map<string, number>()

// --- Timers: booked pushes and the weekly health check --------------------------------------

let timers = false
export function startStudioTimers(host: StudioHost) {
  if (timers) return
  timers = true
  startScheduler(async (s) => {
    const p = host.projects().find((x) => x.id === s.projectId)
    if (!p) return
    const token = (await ghToken()) ?? (await githubAuth()).token
    const site = openSite(p, token)
    const until = Date.now() + 15 * 60_000
    let r = runtimeOf(p.id)
    while (Date.now() < until && (r?.busy || site.status !== 'ready')) {
      if (['error', 'unsupported'].includes(r?.site.status ?? '')) break
      await new Promise((ok) => setTimeout(ok, 3000))
      r = runtimeOf(p.id)
    }
    const fail = (why: string) => host.note({ id: `${p.id}:studio-schedule:${s.at}`, projectId: p.id, kind: 'deploy-fail', level: 'critical', title: `Scheduled push for ${p.name} didn’t run`, body: why })
    if (!r || r.site.status !== 'ready') return fail(r?.site.message || 'Studio couldn’t open the site.')
    if (!studioEdits(r.folder).files.length) return fail('There were no saved edits waiting to go live.')
    const out = publish(p, token, { draft: false, login: host.login(), exe: await findClaude(loadSettings().claudePath) })
    if ('error' in out) return fail(out.error)
    while (runtimeOf(p.id)?.busy) await new Promise((ok) => setTimeout(ok, 2000))
    const last = runtimeOf(p.id)?.site.last
    if (last?.kind === 'publish' && last.ok) {
      lastPush.set(p.id, Date.now())
      host.note({ id: `${p.id}:studio-schedule:${s.at}`, projectId: p.id, kind: 'push', level: 'success', title: `${p.name}: scheduled edits pushed live`, body: last.text, url: last.url })
      host.refresh()
    } else fail(last?.text ?? 'The push didn’t finish.')
  })
  // the weekly check of each live site: one site at a time, an hour apart at most
  const weekly = async () => {
    for (const p of host.projects()) {
      if (!isSite(p) || !p.url || !weeklyDue(p.id)) continue
      try {
        const before = weeklyOf(p.id)
        const rep = await weeklyCheck(p.id, p.url)
        const last = rep.runs[0]
        if (before.runs.length && rep.slipped.length)
          host.note({ id: `${p.id}:studio-weekly:${last.at}`, projectId: p.id, kind: 'perf', level: 'warning', title: `${p.name}: ${rep.slipped.length} new problem${rep.slipped.length === 1 ? '' : 's'} this week`, body: rep.slipped.slice(0, 4).join(' · ') })
      } catch (e) {
        log('weekly check', p.id, (e as Error).message)
      }
      return // one per run
    }
  }
  setTimeout(() => void weekly(), 5 * 60_000).unref?.()
  setInterval(() => void weekly(), 60 * 60_000).unref?.()
}

// --- Routes ----------------------------------------------------------------------------------

export async function studioRoute(route: string, url: URL, req: IncomingMessage, res: ServerResponse, host: StudioHost): Promise<boolean> {
  if (!route.includes(' /api/studio')) return false
  const { json, readBody } = host
  const find = (id: unknown) => host.projects().find((x) => x.id === id) ?? null
  const q = (k: string) => url.searchParams.get(k)
  const ready = (p: Project | null) => {
    const r = p ? runtimeOf(p.id) : null
    return r && r.site.port ? r : null
  }
  const exe = () => findClaude(loadSettings().claudePath)
  const token = async () => (await ghToken()) ?? (await githubAuth()).token
  const done = (out: unknown) => (out && typeof out === 'object' && 'error' in out ? json(res, 409, out) : json(res, 200, out))

  switch (route) {
    // --- Opening, saving, publishing ---------------------------------------------------------

    case 'GET /api/studio': {
      // where a site is up to in Studio: downloading, building, ready (with its preview port)
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      touch(p.id)
      return json(res, 200, { ...studioState(p), schedule: scheduleOf(p.id) }), true
    }

    case 'POST /api/studio/open': {
      // open a site in Studio (sync: true pulls the latest from GitHub again; warm: start it in the background)
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      return json(res, 200, openSite(p, (await githubAuth()).token, { sync: body.sync === true })), true
    }

    case 'POST /api/studio/save': {
      // edits made on the canvas, saved into the site's source (Claude places the tricky ones)
      const body = await readBody(req, 6_000_000)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const ops = opsOf(body.ops, 200)
      if (!ops.length) return json(res, 400, { error: 'No edits to save' }), true
      return done(saveOps(p, ops, await exe())), true
    }

    case 'POST /api/studio/claude': {
      // a change asked for in words, made by Claude in Studio's copy of the site
      const body = await readBody(req, 100_000)
      const p = find(body.projectId)
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : ''
      if (!p || !prompt) return json(res, 400, { error: 'Say what to change' }), true
      const el = body.element && typeof body.element === 'object' ? (body.element as StudioElement) : null
      return done(askClaude(p, prompt, { page: pageOf(body.page), element: el, width: Number(body.width) || 0 }, await exe())), true
    }

    case 'GET /api/studio/diff': {
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      return json(res, 200, { diff: await diffOf(p) }), true
    }

    case 'POST /api/studio/publish': {
      // push the saved edits live (one commit on the default branch), or as a draft branch
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const out = publish(p, await token(), { draft: body.draft === true, login: host.login(), exe: await exe() })
      if (!('error' in out) && body.draft !== true) {
        lastPush.set(p.id, Date.now())
        // a push live replaces a booked one
        setSchedule(p.id, null, '')
      }
      return done(out), true
    }

    case 'POST /api/studio/discard': {
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      return done(discard(p)), true
    }

    case 'POST /api/studio/close': {
      const body = await readBody(req)
      if (typeof body.projectId === 'string') closeSite(body.projectId)
      return json(res, 200, { ok: true }), true
    }

    // --- All sites at a glance ---------------------------------------------------------------

    case 'GET /api/studio/overview': {
      const list = host
        .projects()
        .filter(isSite)
        .map((p) => {
          const s = studioState(p)
          const w = weeklyOf(p.id)
          const lastRun = w.runs[0]
          return {
            id: p.id,
            name: p.name,
            accent: p.accent,
            url: p.url,
            previewUrl: p.previewUrl,
            kind: s.kind,
            status: s.status,
            open: !!runtimeOf(p.id),
            waiting: s.changed.length ? s.notes.length || s.changed.length : 0,
            schedule: scheduleOf(p.id),
            up: p.health?.up ?? null,
            ms: p.health?.ms ?? null,
            seo: p.health?.seoScore ?? null,
            performance: p.health?.psi?.scores.performance ?? null,
            pushed: p.pushedAt,
            lastCommit: p.commits[0] ? { title: p.commits[0].message.split('\n')[0], date: p.commits[0].date, author: p.commits[0].author } : null,
            deploy: p.deployments[0] ? { state: p.deployments[0].state, created: p.deployments[0].created, url: p.deployments[0].url } : null,
            weekly: lastRun ? { at: lastRun.at, problems: lastRun.problems.length, slipped: w.slipped.length, fixed: w.fixed.length } : null,
          }
        })
      return json(res, 200, { sites: list }), true
    }

    // --- Words: search, everywhere, content -------------------------------------------------

    case 'GET /api/studio/search': {
      // every page of the site that shows these words
      const p = find(q('project'))
      const r = ready(p)
      const text = (q('q') ?? '').trim().slice(0, 200)
      if (!r || !p) return json(res, 409, { error: 'Open the site in Studio first' }), true
      if (text.length < 2) return json(res, 200, { hits: [] }), true
      return json(res, 200, { hits: await searchPages(r.site.port!, r.site.pages.map((x) => x.path), text, q('case') === '1', q('word') === '1') }), true
    }

    case 'POST /api/studio/count': {
      // where else these exact words appear: in the source, and on how many pages
      const body = await readBody(req)
      const p = find(body.projectId)
      const r = ready(p)
      const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, 2000) : ''
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      if (text.length < 2) return json(res, 200, { source: 0, files: [], pages: [] }), true
      const { kind } = detectKind(r.folder)
      const hits = findInText(sourceFiles(r.folder, kind), textPattern(text, 'g', true), 500)
      const pages = await searchPages(r.site.port!, r.site.pages.map((x) => x.path), text, true, false)
      return json(res, 200, { source: hits.length, files: [...new Set(hits.map((h) => path.relative(r.folder, h.file).split(path.sep).join('/')))], pages: pages.map((h) => h.path) }), true
    }

    case 'GET /api/studio/content': {
      const p = find(q('project'))
      const r = p ? runtimeOf(p.id) : null
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      const file = q('file')
      if (!file) return json(res, 200, { files: contentFiles(r.folder, detectKind(r.folder).kind) }), true
      const listed = contentFiles(r.folder, detectKind(r.folder).kind).some((f) => f.path === file)
      if (!listed) return json(res, 404, { error: 'That isn’t one of the site’s content files' }), true
      const out = readContent(r.folder, file)
      return json(res, 'error' in out ? 400 : 200, out), true
    }

    case 'POST /api/studio/content': {
      // a content file saved from its form: written, the site rebuilt, and noted for the push
      const body = await readBody(req, 4_000_000)
      const p = find(body.projectId)
      const r = p ? runtimeOf(p.id) : null
      if (!p || !r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      const file = typeof body.file === 'string' ? body.file : ''
      if (!contentFiles(r.folder, detectKind(r.folder).kind).some((f) => f.path === file)) return json(res, 404, { error: 'That isn’t one of the site’s content files' }), true
      const update = (body.update ?? {}) as Parameters<typeof writeContent>[2]
      const label = typeof body.label === 'string' ? body.label.slice(0, 80) : path.basename(file)
      return done(
        job(p, `Saving ${label}`, async (rt): Promise<StudioResult> => {
          const at = new Date().toISOString()
          const w = writeContent(rt.folder, file, update)
          if ('error' in w) return { kind: 'content', ok: false, text: w.error, at }
          if (!w.changed) return { kind: 'content', ok: true, text: 'Nothing had changed.', at }
          await rebuild(rt)
          await record(rt, [`Update the ${label} content (${file})`], ['/'])
          return { kind: 'content', ok: true, text: `${label} saved. Check it on the canvas, then push live.`, at }
        }),
      ), true
    }

    // --- Photos ------------------------------------------------------------------------------

    case 'GET /api/studio/photos': {
      const p = find(q('project'))
      const r = p ? runtimeOf(p.id) : null
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      const { kind, root } = detectKind(r.folder)
      return json(res, 200, { photos: photoLibrary(r.folder, kind, root, kind === 'astro'), pipeline: r.site.pipeline }), true
    }

    case 'GET /api/studio/photos/uses': {
      const p = find(q('project'))
      const r = p ? runtimeOf(p.id) : null
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      const { kind, root } = detectKind(r.folder)
      return json(res, 200, { uses: photoUses(r.folder, kind, root, q('url') ?? '') }), true
    }

    case 'POST /api/studio/photos/delete': {
      // unused photos removed from the repo (checked again here: nothing may use them)
      const body = await readBody(req)
      const p = find(body.projectId)
      const r = p ? runtimeOf(p.id) : null
      if (!p || !r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      const want = Array.isArray(body.paths) ? (body.paths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200) : []
      if (!want.length) return json(res, 400, { error: 'Pick the photos to delete' }), true
      return done(
        job(p, `Deleting ${want.length} unused photo${want.length === 1 ? '' : 's'}`, async (rt): Promise<StudioResult> => {
          const at = new Date().toISOString()
          const { kind, root } = detectKind(rt.folder)
          const lib = new Map(photoLibrary(rt.folder, kind, root, false).map((x) => [x.path, x]))
          const sources = sourcePhotoFolders(rt.folder)
          const gone: string[] = []
          for (const rel of want) {
            const ph = lib.get(rel)
            const full = inRepo(rt.folder, rel)
            if (!ph || !full || ph.uses !== 0 || sources.has(rel.split('/')[0])) continue
            fs.rmSync(full, { force: true })
            gone.push(rel)
          }
          if (!gone.length) return { kind: 'photos', ok: false, text: 'None of those photos could be deleted: something on the site uses them.', at }
          await record(rt, [`Delete ${gone.length} unused photo${gone.length === 1 ? '' : 's'}: ${gone.map((g) => path.basename(g)).slice(0, 6).join(', ')}${gone.length > 6 ? '…' : ''}`], [])
          return { kind: 'photos', ok: true, text: `${gone.length} unused photo${gone.length === 1 ? '' : 's'} deleted${gone.length < want.length ? ` (${want.length - gone.length} kept: they’re in use)` : ''}. Push live to remove them from GitHub.`, at }
        }),
      ), true
    }

    case 'GET /api/studio/stock': {
      const s = loadSettings().studio ?? {}
      const text = (q('q') ?? '').trim().slice(0, 100)
      if (text.length < 2) return json(res, 200, { photos: [], errors: [], sources: [] }), true
      return json(res, 200, await stockSearch(text, Math.max(1, Math.min(Number(q('page')) || 1, 20)), { unsplash: s.unsplashKey, pexels: s.pexelsKey })), true
    }

    case 'POST /api/studio/stock': {
      // a stock photo downloaded into Studio's uploads, ready to swap in
      const body = await readBody(req)
      const s = loadSettings().studio ?? {}
      const out = await stockFetch(String(body.full ?? ''), String(body.name ?? 'photo').slice(0, 80), typeof body.ping === 'string' ? body.ping : null, { unsplash: s.unsplashKey })
      return json(res, 'error' in out ? 400 : 200, out), true
    }

    case 'POST /api/studio/alt': {
      // alt text written by Claude from the photo itself
      const body = await readBody(req)
      const claude = await exe()
      if (!claude) return json(res, 503, { error: 'Claude Code isn’t set up on this computer' }), true
      const file = await photoToFile(String(body.src ?? ''), previewPorts())
      if (!file) return json(res, 400, { error: 'Studio can’t read that photo' }), true
      const out = await altFromPhoto(claude, file, String(body.context ?? '').slice(0, 600))
      return json(res, 'error' in out ? 502 : 200, out), true
    }

    case 'GET /api/studio/svg': {
      // an uploaded SVG, cleaned, to draw in place of a logo or icon
      const markup = uploadedSvg(q('upload') ?? '')
      return markup ? json(res, 200, { markup }) : json(res, 400, { error: 'That isn’t an SVG Studio can use' }), true
    }

    // --- History, deploys, scheduling -------------------------------------------------------

    case 'GET /api/studio/history': {
      const p = find(q('project'))
      const r = ready(p)
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      return json(res, 200, { commits: await history(r, await token()) }), true
    }

    case 'POST /api/studio/revert': {
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      return done(rollBack(p, String(body.sha ?? ''), body.mode === 'back-to' ? 'back-to' : 'one')), true
    }

    case 'GET /api/studio/deploy': {
      // where the last push has got to: GitHub's checks and deploys, and Krystal
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const r = runtimeOf(p.id)
      const sha = r?.site.sha ?? p.commits[0]?.sha ?? null
      if (Date.now() - (lastPush.get(p.id) ?? 0) < 15 * 60_000 && Date.now() - refreshed > 45_000) {
        refreshed = Date.now()
        host.refresh()
      }
      const runs = p.runs.filter((x) => (sha ? x.sha === sha : x.branch === p.defaultBranch)).slice(0, 6)
      const deployments = p.deployments.slice(0, 4)
      const k = loadSettings().studio?.sites?.[p.id]?.krystal
      let krystal: (KrystalState & { error?: string }) | { error: string } | null = null
      if (k && q('krystal') === '1') {
        try {
          krystal = await krystalStatus(k)
        } catch (e) {
          krystal = { error: (e as Error).message }
        }
      }
      return json(res, 200, { sha, branch: p.defaultBranch, runs, deployments, krystal, connected: !!k, url: p.url, previewUrl: p.previewUrl, pushedAt: lastPush.get(p.id) ?? null }), true
    }

    case 'POST /api/studio/krystal': {
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const k = loadSettings().studio?.sites?.[p.id]?.krystal
      const bad = krystalProblem(k)
      if (bad || !k) return json(res, 400, { error: bad ?? 'Not connected' }), true
      try {
        return json(res, 200, await krystalDeploy(k, p.defaultBranch)), true
      } catch (e) {
        return json(res, 502, { error: (e as Error).message }), true
      }
    }

    case 'POST /api/studio/schedule': {
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const at = typeof body.at === 'string' ? body.at : null
      if (at && !studioEdits(runtimeOf(p.id)?.folder ?? '').files.length) return json(res, 409, { error: 'Save some edits first: a scheduled push sends the saved edits.' }), true
      const out = setSchedule(p.id, at, host.login() ?? 'you')
      return 'error' in out ? json(res, 400, out) : json(res, 200, { schedule: scheduleOf(p.id) }), true
    }

    case 'GET /api/studio/checks': {
      // the checks before going live
      const p = find(q('project'))
      const r = ready(p)
      if (!p || !r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      return json(res, 200, { checks: await preChecks(r, await diffOf(p)) }), true
    }

    // --- Screenshots and the phone preview --------------------------------------------------

    case 'POST /api/studio/shot': {
      // a screenshot of a page: Studio's copy with your edits, or the live or preview site for "before"
      const body = await readBody(req, 6_000_000)
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const page = pageOf(body.page)
      const width = Math.round(Number(body.width) || 1280)
      const height = Math.round(Number(body.height) || 800)
      let target: string | null
      let key: string | null = null
      if (body.source === 'live' || body.source === 'preview') target = addressOf(p, page, body.source)
      else {
        const r = ready(p)
        if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
        key = holdOps(opsOf(body.ops), 3 * 60_000)
        target = `http://127.0.0.1:${r.site.port}${page}${page.includes('?') ? '&' : '?'}__studio_ops=${key}`
      }
      if (!target) return json(res, 400, { error: 'This site has no live address set' }), true
      try {
        const img = await pageShot(target, { width, height, full: body.full === true, scale: Number(body.scale) || 1, type: body.type === 'jpeg' ? 'jpeg' : 'png', mobile: body.mobile === true })
        res.statusCode = 200
        res.setHeader('Content-Type', body.type === 'jpeg' ? 'image/jpeg' : 'image/png')
        res.setHeader('Cache-Control', 'no-store')
        res.end(img)
      } catch (e) {
        json(res, 502, { error: (e as Error).message.split('\n')[0] })
      }
      return true
    }

    case 'GET /api/studio/phone':
      return json(res, 200, phoneState()), true

    case 'POST /api/studio/phone': {
      const body = await readBody(req, 6_000_000)
      if (body.on === false) return json(res, 200, phoneOff()), true
      const p = find(body.projectId)
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const ops = opsOf(body.ops)
      try {
        return json(res, 200, body.on === true ? await phoneOn(p.id, pageOf(body.page), ops) : phoneUpdate(p.id, body.page ? pageOf(body.page) : null, ops)), true
      } catch (e) {
        return json(res, 409, { error: (e as Error).message }), true
      }
    }

    // --- SEO, speed and visitors ------------------------------------------------------------

    case 'GET /api/studio/connections': {
      const p = find(q('project'))
      return json(res, 200, { ...studioPublic(p?.id), psi: !!psiKey(), claude: !!(await exe()) }), true
    }

    case 'POST /api/studio/connections': {
      const body = await readBody(req, 50_000)
      const patch: Parameters<typeof saveStudioSettings>[0] = {}
      if (typeof body.unsplashKey === 'string') patch.unsplashKey = body.unsplashKey.trim().slice(0, 200)
      if (typeof body.pexelsKey === 'string') patch.pexelsKey = body.pexelsKey.trim().slice(0, 200)
      if (body.google === null) patch.google = null
      else if (typeof body.google === 'string' && body.google.trim()) {
        let g: Record<string, unknown>
        try {
          g = JSON.parse(body.google)
        } catch {
          return json(res, 400, { error: 'Paste the whole key file (it starts with { and ends with })' }), true
        }
        if (typeof g.client_email !== 'string' || typeof g.private_key !== 'string' || !g.private_key.includes('PRIVATE KEY')) return json(res, 400, { error: 'That isn’t a service account key file: it needs client_email and private_key' }), true
        patch.google = { client_email: g.client_email, private_key: g.private_key, project_id: typeof g.project_id === 'string' ? g.project_id : undefined }
      }
      const site = body.site as Record<string, unknown> | undefined
      if (site && typeof site.id === 'string' && find(site.id)) {
        const s: NonNullable<typeof patch.site> = { id: site.id }
        if (typeof site.searchConsole === 'string') s.searchConsole = site.searchConsole.trim().slice(0, 300)
        if (typeof site.ga4 === 'string') {
          const id = site.ga4.trim().replace(/^properties\//, '')
          if (id && !/^\d{5,15}$/.test(id)) return json(res, 400, { error: 'The GA4 property id is the number in Admin → Property details (not the G- measurement id)' }), true
          s.ga4 = id
        }
        if (site.krystal === null) s.krystal = null
        else if (site.krystal && typeof site.krystal === 'object') {
          const k = site.krystal as Record<string, unknown>
          const cur = loadSettings().studio?.sites?.[site.id]?.krystal
          const next: StudioKrystal = {
            host: String(k.host ?? cur?.host ?? '').trim(),
            user: String(k.user ?? cur?.user ?? '').trim(),
            token: typeof k.token === 'string' && k.token.trim() ? k.token.trim() : (cur?.token ?? ''),
            repoRoot: String(k.repoRoot ?? cur?.repoRoot ?? '').trim(),
            branch: String(k.branch ?? cur?.branch ?? '').trim() || undefined,
          }
          const bad = krystalProblem(next)
          if (bad) return json(res, 400, { error: bad }), true
          try {
            await krystalStatus(next)
          } catch (e) {
            return json(res, 400, { error: `cPanel didn’t accept those details: ${(e as Error).message}` }), true
          }
          s.krystal = next
        }
        patch.site = s
      }
      saveStudioSettings(patch)
      return json(res, 200, { ...studioPublic(typeof site?.id === 'string' ? site.id : undefined), psi: !!psiKey() }), true
    }

    case 'GET /api/studio/psi': {
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      const target = addressOf(p, pageOf(q('page')), q('which'))
      if (!target) return json(res, 400, { error: 'This site has no live address set, so Google can’t test it' }), true
      try {
        return json(res, 200, await psiDetail(target, q('strategy') === 'desktop' ? 'desktop' : 'mobile')), true
      } catch (e) {
        return json(res, 502, { error: (e as Error).message }), true
      }
    }

    case 'GET /api/studio/search-console':
    case 'GET /api/studio/analytics': {
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      if (!loadSettings().studio?.google) return json(res, 412, { error: 'connect', what: 'google' }), true
      const page = q('page') ? pageOf(q('page')) : null
      const days = [7, 28, 90].includes(Number(q('days'))) ? Number(q('days')) : 28
      try {
        const out = route.endsWith('analytics') ? await analytics(p.id, p.url ?? p.previewUrl ?? '', page, days) : await searchConsole(p.id, p.url ?? p.previewUrl ?? '', page, days)
        return json(res, 200, out), true
      } catch (e) {
        return json(res, 502, { error: (e as Error).message }), true
      }
    }

    case 'GET /api/studio/nap': {
      const p = find(q('project'))
      const r = ready(p)
      if (!r) return json(res, 409, { error: 'Open the site in Studio first' }), true
      return json(res, 200, await napAcrossSite(r.site.port!, r.site.pages.map((x) => x.path))), true
    }

    case 'GET /api/studio/weekly': {
      const p = find(q('project'))
      if (!p) return json(res, 404, { error: 'No project by that id' }), true
      return json(res, 200, { ...weeklyOf(p.id), url: p.url }), true
    }

    case 'POST /api/studio/weekly': {
      const body = await readBody(req)
      const p = find(body.projectId)
      if (!p?.url) return json(res, 400, { error: 'This site has no live address to check' }), true
      weeklyCheck(p.id, p.url).catch((e) => log('weekly check', p.id, (e as Error).message))
      return json(res, 202, { ...weeklyOf(p.id), running: true, url: p.url }), true
    }
  }
  return false
}
