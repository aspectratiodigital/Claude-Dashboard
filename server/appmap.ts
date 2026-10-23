import fs from 'node:fs'
import path from 'node:path'
import type { AppFloor, AppGallery, AppImage, AppItem, AppMap } from '../src/data/types.ts'
import type { GitHub, RepoInfo } from './github.ts'
import { DATA_DIR, log, now, prettyName } from './util.ts'

// An app's building: one floor for the home screen, then one per game mode
// (or screen), each holding the options that exist in the code, such as skins
// and card designs, as pictures. It is read from the repo on GitHub whenever
// the default branch moves. An app can describe itself instead with a
// blueprint.app.json (same shape as AppMap's floors); otherwise the code is read:
//
//   games / modes / levels / screens.ts   { id, title, tagline } entries: the floors
//   skins / themes.ts                     { id, name, blurb } entries: app skins
//   packs / decks.ts                      { id, name } entries: card skins, matched to images by name
//
// When the web build takes ?skin= (and ?game=) links, each skin is shown as a
// screenshot of the live app, on the home floor and on every game's floor.

const IMG = /\.(png|jpe?g|webp|gif|svg)$/i
const SKIP = /(^|\/)(node_modules|dist|build|web-build|\.expo|android|ios|coverage|\.git)\//
const ASSETS = path.join(DATA_DIR, 'app-assets')

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const stem = (p: string) => baseOf(p).replace(/\.[^.]+$/, '')
const join = (d: string, f: string) => (d ? `${d}/${f}` : f)
const depth = (p: string) => p.split('/').length

/** The app's folder in the repo, if this repo holds an app (Expo / React Native, Capacitor, Flutter), else null. */
export function appRootOf(paths: string[]): string | null {
  const set = new Set(paths)
  const roots = paths
    .filter((p) => !SKIP.test(p))
    .flatMap((p) => {
      const d = dirOf(p)
      const b = baseOf(p)
      if (/^app\.(json|config\.(js|ts|mjs|cjs))$/.test(b) && set.has(join(d, 'package.json'))) {
        // Expo's app.json says "expo"; a plain app.json next to App.tsx also counts
        const hasApp = paths.some((x) => dirOf(x) === d && /^App\.(t|j)sx?$/.test(baseOf(x)))
        return b === 'app.json' && !hasApp && !paths.some((x) => x.startsWith(join(d, 'src/'))) ? [] : [d]
      }
      if (/^capacitor\.config\.(json|ts|js)$/.test(b) || b === 'pubspec.yaml') return [d]
      return []
    })
  return roots.sort((a, b) => depth(a) - depth(b))[0] ?? null
}

interface Entry {
  id: string
  name: string
  note?: string
  swatch?: string
  /** the entry's other one-word string values (a card pack's face style, say) */
  words: string[]
  at: number
}

/** `{ id: "x", title|name: "Y", tagline|blurb: "Z" }` objects and `helper("x", "Y", "#colour")` calls, in source order. */
function entriesOf(src: string): Entry[] {
  const out: Entry[] = []
  const starts = [...src.matchAll(/\bid:\s*(["'])([\w-]+)\1/g)].map((m) => ({ at: m.index ?? 0, id: m[2] }))
  starts.forEach((s, i) => {
    const chunk = src.slice(s.at, starts[i + 1]?.at ?? s.at + 3000)
    const name = chunk.match(/\b(?:title|name):\s*(["'])((?:(?!\1).)+)\1/)
    if (!name) return
    const note = chunk.match(/\b(?:tagline|blurb|description|subtitle):\s*(["'])((?:(?!\1).)+)\1/)
    const swatch = chunk.match(/\b(?:swatch|colou?r|accent):\s*["'](#[0-9a-f]{3,8})["']/i)
    const words = [...chunk.matchAll(/\b\w+:\s*(["'])([\w-]+)\1/g)].map((m) => m[2]).filter((w) => w !== s.id)
    out.push({ id: s.id, name: name[2], note: note?.[2], swatch: swatch?.[1], words, at: s.at })
  })
  for (const m of src.matchAll(/\b[a-z]\w*\(\s*(["'])([\w-]+)\1\s*,\s*(["'])([^"'\n]+)\3\s*,\s*["'](#[0-9a-fA-F]{3,8})["']/g)) {
    out.push({ id: m[2], name: m[4], swatch: m[5], words: [], at: m.index ?? 0 })
  }
  const seen = new Set<string>()
  return out.sort((a, b) => a.at - b.at).filter((e) => !seen.has(e.id) && seen.add(e.id))
}

/** The query parameters the web build reads (`params.get("skin")`). */
const paramsOf = (src: string) => new Set([...src.matchAll(/\.get\(\s*["'](\w+)["']\s*\)/g)].map((m) => m[1]))

// --- reading the repo ------------------------------------------------------------------------

async function text(gh: GitHub, repo: RepoInfo, sha: string, file: string): Promise<string> {
  const r = await gh.get<string>(`/repos/${repo.full}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, 'application/vnd.github.raw')
  return typeof r.data === 'string' ? r.data : ''
}

const cacheFile = (repo: string, sha: string, file: string) => path.join(ASSETS, repo.replace('/', '__'), sha.slice(0, 12), ...file.split('/'))

/** A file from the repo at a commit, as bytes. Kept on disk, since a commit's files never change. */
export async function assetBytes(token: string | null, repo: string, sha: string, file: string): Promise<Buffer | null> {
  const local = cacheFile(repo, sha, file)
  try {
    return fs.readFileSync(local)
  } catch {
    /* not fetched yet */
  }
  const headers: Record<string, string> = { Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jarvis-dashboard' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, buf)
    return buf
  } catch (e) {
    log('app asset', repo, file, (e as Error).message)
    return null
  }
}

/** Width and height of a PNG or JPEG. */
function sizeOf(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  return null
}

/** The grid of a sheet holding `n` playing cards (5:7) side by side, if it is one. */
function cardGrid(size: { w: number; h: number }, n: number): { cols: number; rows: number } | null {
  for (let cols = 1; cols <= 16; cols++) {
    const rows = Math.ceil(n / cols)
    const aspect = size.w / cols / (size.h / rows)
    if (Math.abs(aspect - 5 / 7) < 0.02 && cols * rows - n < cols) return { cols, rows }
  }
  return null
}

// --- building the map ------------------------------------------------------------------------

export async function loadAppMap(gh: GitHub, repo: RepoInfo, paths: string[], sha: string, root: string | null): Promise<AppMap> {
  const at = root ?? ''
  const manifest = paths.find((p) => /(^|\/)blueprint\.app\.json$/.test(p) && !SKIP.test(p))
  if (manifest) {
    try {
      const j = JSON.parse(await text(gh, repo, sha, manifest)) as { floors?: AppFloor[] }
      const known = new Set(paths)
      const dir = dirOf(manifest)
      const fix = (img: AppImage): AppImage => ({ ...img, path: known.has(img.path) ? img.path : join(dir, img.path) })
      const floors = (j.floors ?? []).map((f, i) => ({
        id: String(f.id ?? i),
        name: String(f.name ?? `Floor ${i + 1}`),
        note: f.note,
        galleries: (f.galleries ?? []).map((g, k) => ({ id: String(g.id ?? k), name: String(g.name ?? ''), note: g.note, items: (g.items ?? []).map((it, m) => ({ ...it, id: String(it.id ?? m), name: String(it.name ?? ''), images: (it.images ?? []).map(fix) })) })),
      }))
      if (floors.length) return { sha, root: at, source: 'manifest', floors, checked: now() }
    } catch (e) {
      log('app map', repo.full, 'bad blueprint.app.json', (e as Error).message)
    }
  }

  const mine = paths.filter((p) => (at ? p.startsWith(`${at}/`) : true) && !SKIP.test(p))
  const code = mine.filter((p) => /\.(t|j)sx?$/.test(p) && !/\.(test|spec|d)\.(t|j)sx?$/.test(p)).sort((a, b) => depth(a) - depth(b))
  const pick = (re: RegExp) => code.find((p) => re.test(baseOf(p)))
  const gamesFile = pick(/^(games|gameModes|modes|levels|screens|routes)\.(t|j)sx?$/i)
  const skinsFile = pick(/^(skins|themes)\.(t|j)sx?$/i)
  const packsFile = pick(/^(packs|cardPacks|decks|cardSkins)\.(t|j)sx?$/i)
  const entryFile = code.find((p) => dirOf(p) === at && /^(App|index)\.(t|j)sx?$/.test(baseOf(p)))
  const [gamesSrc, skinsSrc, packsSrc, entrySrc] = await Promise.all([gamesFile, skinsFile, packsFile, entryFile].map((f) => (f ? text(gh, repo, sha, f) : Promise.resolve(''))))
  const params = paramsOf(skinsSrc + entrySrc + gamesSrc)
  const skinParam = ['skin', 'theme'].find((k) => params.has(k)) ?? null
  const gameParam = ['game', 'mode', 'level', 'screen'].find((k) => params.has(k)) ?? null

  const skins = entriesOf(skinsSrc)
  const games = entriesOf(gamesSrc)
  const images = mine.filter((p) => IMG.test(p))
  const used = new Set<string>()
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

  const home: AppGallery[] = []
  if (skins.length) {
    home.push({
      id: 'skins',
      name: `App skins (${skins.length})`,
      note: skinParam ? 'The home screen in each skin, from the live app.' : 'Add a ?skin= link to the web build to see each one here.',
      items: skins.map((s) => ({ id: s.id, name: s.name, note: s.note, images: [], shot: skinParam ? q({ [skinParam]: s.id }) : undefined })),
    })
  }

  // card skins: each pack's back (cut from the backs sheet) and its sheet of faces
  const packs = entriesOf(packsSrc)
  if (packs.length) {
    const tokens = (p: string) => stem(p).toLowerCase().split(/[-_.\s]+/)
    const backs = images.find((p) => /^(card[-_]?)?backs?$/i.test(stem(p)))
    let grid: { cols: number; rows: number } | null = null
    if (backs) {
      const b = await assetBytes(gh.token, repo.full, sha, backs)
      const size = b && sizeOf(b)
      grid = size ? cardGrid(size, packs.length) : null
      used.add(backs)
    }
    home.push({
      id: 'cards',
      name: `Card skins (${packs.length})`,
      note: 'Each deck’s back and its full sheet of faces.',
      items: packs.map((e, i): AppItem => {
        const faces = images.find((p) => tokens(p).includes(e.id.toLowerCase()) && !/^backs?$/i.test(stem(p))) ?? e.words.map((w) => images.find((p) => tokens(p).includes(w.toLowerCase()) && /face/i.test(p))).find(Boolean)
        const imgs: AppImage[] = []
        if (backs && grid) imgs.push({ path: backs, label: 'Back', crop: { ...grid, index: i } })
        if (faces) {
          imgs.push({ path: faces, label: 'Faces' })
          used.add(faces)
        }
        return { id: e.id, name: e.name, swatch: e.swatch, images: imgs }
      }),
    })
  }

  // everything else in the app's assets, grouped by what the file names share
  const rest = images.filter((p) => !used.has(p) && /(^|\/)(assets|images|img|public|static|res)\//i.test(p))
  const groups = new Map<string, string[]>()
  for (const p of rest) {
    const s = stem(p).toLowerCase()
    const key = /icon|favicon|splash|logo/.test(s) ? 'App icons' : s.split(/[-_]/)[0]
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const other: AppItem[] = []
  for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    for (const p of list.slice(0, 24)) other.push({ id: p, name: prettyName(stem(p)), note: key === 'App icons' || list.length > 1 ? (key === 'App icons' ? key : prettyName(key)) : undefined, images: [{ path: p }] })
  }
  if (other.length) home.push({ id: 'assets', name: `Other images (${other.length})`, note: 'Textures, labels and icons in the app’s assets folder.', items: other.slice(0, 80) })

  const floors: AppFloor[] = [{ id: 'home', name: 'Home', note: 'The app’s home screen, with every skin and card design.', galleries: home }]
  if (games.length) {
    for (const g of games) {
      const galleries: AppGallery[] = []
      if (gameParam) {
        galleries.push(
          skins.length && skinParam
            ? { id: 'skins', name: 'In each skin', note: `${g.name} opened from a link, in every app skin.`, items: skins.map((s) => ({ id: s.id, name: s.name, images: [], shot: q({ [gameParam]: g.id, [skinParam]: s.id }) })) }
            : { id: 'screen', name: 'Screen', items: [{ id: g.id, name: g.name, images: [], shot: q({ [gameParam]: g.id }) }] },
        )
      }
      const own = images.filter((p) => stem(p).toLowerCase().includes(g.id.toLowerCase()))
      if (own.length) galleries.push({ id: 'images', name: 'Images', items: own.map((p) => ({ id: p, name: prettyName(stem(p)), images: [{ path: p }] })) })
      floors.push({ id: g.id, name: g.name, note: g.note, galleries })
    }
  } else {
    // no list of modes: one floor per screen file
    const screens = code.filter((p) => /Screen\.(t|j)sx?$/.test(baseOf(p)) && !/^Home/i.test(baseOf(p)))
    for (const s of screens.slice(0, 40)) floors.push({ id: stem(s), name: prettyName(stem(s).replace(/Screen$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')), galleries: [] })
  }
  return { sha, root: at, source: 'code', floors, checked: now() }
}

/** Every image path a map shows, so the asset route only serves those. */
export const imagesOf = (m: AppMap) => new Set(m.floors.flatMap((f) => f.galleries.flatMap((g) => g.items.flatMap((i) => i.images.map((x) => x.path)))))
