import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GoogleFont, StudioColour, StudioFont, StudioFontCategory, StudioFontFace, StudioFontSwap, StudioKind } from '../src/data/types.ts'
import { sourceFiles } from './studio-source.ts'
import { DATA_DIR, log } from './util.ts'

// The site's colours and fonts, read from its source and changed there.
// Colours: every one written in its stylesheets, <style> blocks, inline
// styles, SVG colour attributes and data files, grouped by colour (see-through
// versions count with it), with the design tokens set to each. Changing them
// rewrites each place in the notation it was written in. Fonts: every family
// its CSS names, where each comes from, and Google Fonts to swap one for: the
// files are fetched once into a cache on this computer, shown on the canvas
// from there, and copied into the site (self-hosted) when the swap is saved.

// --- Reading colours --------------------------------------------------------------------------

interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, string> = Object.fromEntries(
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'
    .split(' ')
    .map((x) => x.split(':')),
)

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
const hex2 = (n: number) => byte(n).toString(16).padStart(2, '0')
const hexOfRgb = (c: { r: number; g: number; b: number }) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`

function hslToRgb(h: number, s: number, l: number) {
  h = ((h % 360) + 360) % 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255
  }
  return { r: f(0), g: f(8), b: f(4) }
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s, l }
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(%|deg)?$/
const part = (t: string, scale: number) => (t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t))

/** a colour as written in CSS (hex, rgb(), hsl() or a colour name), or null */
export function parseColour(text: string): RGBA | null {
  const t = text.trim().toLowerCase()
  if (t[0] === '#') {
    const h = t.slice(1)
    if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    const at = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 }
  }
  const fn = t.match(/^(rgba?|hsla?)\(\s*([^()]*)\)$/)
  if (fn) {
    const parts = fn[2].split(/\s*[,/]\s*|\s+/).filter(Boolean)
    if (parts.length < 3 || parts.length > 4 || parts.some((p) => !NUM.test(p))) return null
    const a = parts[3] === undefined ? 1 : Math.max(0, Math.min(1, part(parts[3], 1)))
    if (fn[1].startsWith('rgb')) return { r: byte(part(parts[0], 255)), g: byte(part(parts[1], 255)), b: byte(part(parts[2], 255)), a }
    const pct = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) > 1 ? parseFloat(p) / 100 : parseFloat(p))
    const c = hslToRgb(parseFloat(parts[0]), pct(parts[1]), pct(parts[2]))
    return { r: byte(c.r), g: byte(c.g), b: byte(c.b), a }
  }
  const named = NAMED[t]
  return named ? parseColour(`#${named}`) : null
}

const keyOf = (c: RGBA) => hexOfRgb(c)

/** `to` written the way `orig` was: hex stays hex (with its alpha), rgba keeps its see-through and separators, hsl stays hsl */
export function formatLike(orig: string, to: { r: number; g: number; b: number }): string {
  const t = orig.trim()
  if (t[0] === '#') {
    const h = t.slice(1)
    let out = hexOfRgb(to).slice(1)
    if (h.length === 4) out += h[3] + h[3]
    if (h.length === 8) out += h.slice(6)
    return `#${/[A-F]/.test(h) && !/[a-f]/.test(h) ? out.toUpperCase() : out}`
  }
  const fn = t.match(/^(rgba?|hsla?)(\(\s*)([^()]*?)(\s*\))$/i)
  if (fn) {
    const hsl = /^hsl/i.test(fn[1])
    const m = fn[3].match(/^([^\s,/]+)(\s*,\s*|\s+)([^\s,/]+)(\s*,\s*|\s+)([^\s,/]+)(\s*[,/]\s*[^\s,/]+)?$/)
    let vals: string[]
    if (hsl) {
      const c = rgbToHsl(to.r, to.g, to.b)
      const r1 = (n: number) => String(Math.round(n * 10) / 10)
      vals = [`${r1(c.h)}${m?.[1].endsWith('deg') ? 'deg' : ''}`, `${r1(c.s * 100)}%`, `${r1(c.l * 100)}%`]
    } else vals = [to.r, to.g, to.b].map((n) => String(byte(n)))
    if (m) return `${fn[1]}${fn[2]}${vals[0]}${m[2]}${vals[1]}${m[4]}${vals[2]}${m[6] ?? ''}${fn[4]}`
    return `${fn[1]}(${vals.join(', ')})`
  }
  return hexOfRgb(to)
}

// --- Where colours are written ----------------------------------------------------------------

type Where = 'style' | 'markup' | 'script'
interface Spot {
  index: number
  text: string
  c: RGBA
  where: Where
  /** the property or attribute it's the value of */
  prop: string
  /** the whole value is this one colour (a design token's definition) */
  whole: boolean
  /** set for the whole site (on :root, html or a stylesheet's top level), not for one part of it */
  root: boolean
}

const STYLE_FILE = /\.(css|scss|sass|less)$/i
const MARKUP_FILE = /\.(html?|astro|vue|svelte|njk|liquid|php|mdx?|jsx|tsx|m?js|cjs|ts)$/i
const SCRIPT_FILE = /\.(m?js|cjs|tsx?|jsx|json|astro|vue|svelte)$/i
// someone else's code shipped with the site: its colours aren't the site's
const VENDOR = /(^|\/)(vendor|vendors|lib|libs|third[-_]party|polyfills?)\/|\.(min|bundle|umd)\.|(^|\/)(three|gsap|swiper|lenis|alpine|jquery)[\w.-]*\.m?js$/i

const spaces = (m: string) => m.replace(/[^\n]/g, ' ')
const COMMENT = /\/\*[\s\S]*?\*\//g
const maskComments = (css: string) => css.replace(COMMENT, spaces)
/** any kind of comment blanked out: CSS and script block comments, // lines, HTML comments */
const maskAnyComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(^|[ \t])\/\/[^\n]*/gm, spaces)
/** comments, url() and strings blanked out (same length), so what's left is property values */
const maskForColour = (css: string) =>
  maskComments(css)
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, spaces)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, spaces)

/** `prop: value` up to the ; or } that ends it (never a selector, which ends in {) */
const DECL = /([$@]?-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)(?=[;}])/g
const COLOUR_TOKEN = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(\s*[^()]*\)|(?<![\w$@#.-])[a-zA-Z]{3,20}(?![\w(-])/g
const COLOUR_PROP = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|stop-color|flood-color|lighting-color|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|text-emphasis(-color)?|-webkit-text-(fill-color|stroke|stroke-color)|scrollbar-color|filter|mask|-webkit-tap-highlight-color)$/i
const FONTISH = /\b(serif|sans-serif|monospace|cursive|fantasy|system-ui)\b|["']/i
const isVar = (p: string) => /^(--|\$|@)/.test(p)

/** what each declaration is inside: the selectors of the rules around a place, innermost last */
function scopes(masked: string) {
  const open: string[] = []
  let k = 0
  let from = 0
  return (i: number) => {
    for (; k < i; k++) {
      const ch = masked[k]
      if (ch === '{') {
        open.push(masked.slice(from, k).trim())
        from = k + 1
      } else if (ch === '}') {
        open.pop()
        from = k + 1
      } else if (ch === ';') from = k + 1
    }
    return open
  }
}
const ROOT_SCOPE = /^((:root|html)(\s*,\s*(:root|html))*)?$/i
/** a token set for the whole site: on :root or html, at the top level (Sass), or inside @media around those */
const isRoot = (open: string[]) => open.filter((x) => !x.startsWith('@')).every((x) => ROOT_SCOPE.test(x)) && open.filter((x) => !x.startsWith('@')).length <= 1

function cssSpots(css: string, offset: number, out: Spot[], where: Where) {
  const masked = maskForColour(css)
  const scope = scopes(masked)
  for (const d of masked.matchAll(DECL)) {
    const prop = d[1]
    // a mask's colours are only how see-through it is, not colours anyone sees
    if (/^(-webkit-)?mask/i.test(prop)) continue
    const vStart = d.index! + d[0].length - d[2].length
    const value = d[2]
    const named = COLOUR_PROP.test(prop) || (isVar(prop) && !FONTISH.test(css.slice(vStart, vStart + value.length)))
    const whole = value.replace(/!\s*important\s*$/i, '').trim()
    for (const m of value.matchAll(COLOUR_TOKEN)) {
      const tok = m[0]
      if (/^[a-z]/i.test(tok) && !/^(rgba?|hsla?)\(/i.test(tok) && (!named || !NAMED[tok.toLowerCase()])) continue
      const c = parseColour(tok)
      if (c) out.push({ index: offset + vStart + m.index!, text: tok, c, where, prop, whole: whole === tok, root: where === 'style' && isRoot(scope(d.index!)) })
    }
  }
}

function markupSpots(body: string, out: Spot[]) {
  for (const m of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssSpots(m[1], m.index! + m[0].indexOf('>') + 1, out, 'style')
  for (const m of body.matchAll(/(?<![\w-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[1] ?? m[2]
    cssSpots(`${v};`, m.index! + m[0].length - v.length - 1, out, 'markup')
  }
  for (const m of body.matchAll(/(?<![\w-])(fill|stroke|stop-color|flood-color|lighting-color|color|bgcolor)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[2] ?? m[3]
    const t = v.trim()
    const c = t ? parseColour(t) : null
    if (c) out.push({ index: m.index! + m[0].length - v.length - 1 + v.indexOf(t), text: t, c, where: 'markup', prop: m[1].toLowerCase(), whole: true, root: false })
  }
  for (const m of body.matchAll(/<meta\b[^>]*\bname\s*=\s*["'](?:theme-color|msapplication-TileColor)["'][^>]*>/gi)) {
    const c = m[0].match(/\bcontent\s*=\s*(["'])\s*([^"']*?)\s*\1/i)
    const rgba = c ? parseColour(c[2]) : null
    if (c && rgba) out.push({ index: m.index! + c.index! + c[0].indexOf(c[2], c[0].indexOf(c[1]) + 1), text: c[2], c: rgba, where: 'markup', prop: 'theme-color', whole: true, root: false })
  }
}

/** a string in code or data that's a colour and nothing else ('#ee6a48', "rgba(0,0,0,.4)") */
function scriptSpots(body: string, out: Spot[]) {
  for (const m of body.matchAll(/(["'`])(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^()"'`\n]*\))\1/g)) {
    const t = m[2]
    const c = parseColour(t)
    if (!c) continue
    // '#add' in querySelector('#add') is an id, not a colour
    if (t[0] === '#' && t.length <= 5 && /(querySelector(All)?|closest|matches|getElementById|href|hash|location|\$)\s*\(?\s*$/.test(body.slice(Math.max(0, m.index! - 30), m.index!))) continue
    out.push({ index: m.index! + 1, text: t, c, where: 'script', prop: '', whole: true, root: false })
  }
}

function spotsOf(file: string, body: string): Spot[] {
  const out: Spot[] = []
  if (STYLE_FILE.test(file)) cssSpots(body, 0, out, 'style')
  else {
    if (MARKUP_FILE.test(file)) markupSpots(body, out)
    if (SCRIPT_FILE.test(file)) scriptSpots(body, out)
  }
  // the same place found twice (an attribute is also a quoted string): keep the first
  const seen = new Set<number>()
  return out.filter((s) => (seen.has(s.index) ? false : (seen.add(s.index), true))).sort((a, b) => a.index - b.index)
}

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
const relOf = (dir: string, f: string) => path.relative(dir, f).split(path.sep).join('/')

/** the files a site's colours and fonts are written in */
function themeFiles(dir: string, kind: StudioKind): string[] {
  // (_capture holds a generated site's scraped copy and fee data: words, not styles)
  return sourceFiles(dir, kind, { styles: true }).filter((f) => !VENDOR.test(relOf(dir, f)) && !relOf(dir, f).startsWith('_capture/') && (STYLE_FILE.test(f) || MARKUP_FILE.test(f) || SCRIPT_FILE.test(f)))
}

/** var(--x) and $x uses, and --a: var(--b) aliases, across the files */
function tokenUse(bodies: string[]) {
  const refs = new Map<string, number>()
  const alias = new Map<string, string>()
  const add = (k: string) => refs.set(k, (refs.get(k) ?? 0) + 1)
  for (const body of bodies) {
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*var\(\s*(--[\w-]+)\s*\)\s*(?=[;}])/g)) if (!alias.has(m[1])) alias.set(m[1], m[2])
    for (const m of body.matchAll(/var\(\s*(--[\w-]+)/g)) add(m[1])
    for (const m of body.matchAll(/([$@][a-zA-Z][\w-]*)(?![\w-])(?!\s*:)/g)) add(m[1])
  }
  /** what a token ends up as, through aliases */
  const resolve = (name: string, defined: (n: string) => boolean) => {
    let n = name
    for (let i = 0; i < 6 && !defined(n); i++) {
      const next = alias.get(n)
      if (!next) return null
      n = next
    }
    return defined(n) ? n : null
  }
  return { refs, alias, resolve }
}

// --- The palette ------------------------------------------------------------------------------

/** Every colour in the site's source, most used first. */
export function palette(dir: string, kind: StudioKind): { colours: StudioColour[] } {
  const files = themeFiles(dir, kind)
  const acc = new Map<string, { uses: number; seeThrough: number; scripts: number; files: Map<string, number>; tokens: Set<string> }>()
  const tokenHex = new Map<string, string>()
  const bodies: string[] = []
  for (const f of files) {
    const body = read(f)
    bodies.push(body)
    for (const s of spotsOf(f, body)) {
      const hex = keyOf(s.c)
      const a = acc.get(hex) ?? { uses: 0, seeThrough: 0, scripts: 0, files: new Map(), tokens: new Set() }
      acc.set(hex, a)
      if (s.where === 'script') a.scripts++
      else {
        a.uses++
        if (s.c.a < 1) a.seeThrough++
      }
      const r = relOf(dir, f)
      a.files.set(r, (a.files.get(r) ?? 0) + 1)
      if (s.whole && isVar(s.prop) && s.root) {
        a.tokens.add(s.prop)
        if (!tokenHex.has(s.prop)) tokenHex.set(s.prop, hex)
      }
    }
  }
  // uses of each colour's tokens count as uses of the colour
  const { refs, resolve } = tokenUse(bodies)
  for (const [name, n] of refs) {
    const t = resolve(name, (x) => tokenHex.has(x))
    if (!t) continue
    acc.get(tokenHex.get(t)!)!.uses += n
  }
  const colours = [...acc]
    .map(([hex, a]) => ({
      hex,
      uses: a.uses,
      seeThrough: a.seeThrough,
      scripts: a.scripts,
      tokens: [...a.tokens],
      files: [...a.files].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([file, count]) => ({ file, count })),
    }))
    .sort((x, y) => y.uses - x.uses || y.scripts - x.scripts)
  return { colours: colours.slice(0, 400) }
}

/** Each colour in `map` (#rrggbb → #rrggbb) changed everywhere it's written, in the notation it was written in. */
export function paletteSwap(dir: string, kind: StudioKind, map: Record<string, string>): { files: string[]; missing: string[] } {
  const want = new Map<string, RGBA>()
  for (const [from, to] of Object.entries(map)) {
    const c = parseColour(to)
    if (c && /^#[0-9a-f]{6}$/i.test(from) && from.toLowerCase() !== to.toLowerCase()) want.set(from.toLowerCase(), c)
  }
  const seen = new Set<string>()
  const changed: string[] = []
  for (const f of themeFiles(dir, kind)) {
    const body = read(f)
    let out = body
    const spots = spotsOf(f, body).filter((s) => want.has(keyOf(s.c)))
    for (const s of spots.reverse()) {
      seen.add(keyOf(s.c))
      out = out.slice(0, s.index) + formatLike(s.text, want.get(keyOf(s.c))!) + out.slice(s.index + s.text.length)
    }
    if (out !== body) {
      fs.writeFileSync(f, out)
      changed.push(relOf(dir, f))
    }
  }
  return { files: changed, missing: [...want.keys()].filter((k) => !seen.has(k)) }
}

// --- Reading fonts ----------------------------------------------------------------------------

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert'])
const SYSTEM = new Set(
  'georgia|times new roman|times|arial|arial narrow|century gothic|franklin gothic medium|rockwell|candara|constantia|corbel|helvetica|helvetica neue|segoe ui|roboto|verdana|tahoma|trebuchet ms|impact|courier new|courier|menlo|monaco|consolas|sf mono|sf pro|sf pro text|sf pro display|lucida console|lucida grande|palatino|palatino linotype|garamond|book antiqua|cambria|calibri|optima|avenir|avenir next|futura|gill sans|noto sans|ubuntu|cantarell|oxygen|oxygen-sans|fira sans|droid sans|liberation mono|liberation sans|dejavu sans|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji|arial black|baskerville|didot|hoefler text|american typewriter|andale mono|source code pro|cascadia code|iowan old style'.split('|'),
)
const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\s+/g, ' ').trim()
const lower = (s: string) => unquote(s).toLowerCase()

/** split on commas outside quotes and brackets */
function splitTop(s: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  let depth = 0
  let q: string | null = null
  let from = 0
  for (let i = 0; i <= s.length; i++) {
    const ch = s[i]
    if (i === s.length || (ch === ',' && !depth && !q)) {
      out.push({ text: s.slice(from, i), start: from })
      from = i + 1
    } else if (q) {
      if (ch === q && s[i - 1] !== '\\') q = null
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
  }
  return out
}

interface Face {
  family: string
  file: string
  /** where the whole @font-face { … } is, in the file */
  start: number
  end: number
  text: string
  src: string[]
  weight: string
  style: string
}
interface Stack {
  file: string
  /** where the family list is, in the file */
  index: number
  text: string
  prop: string
}

function facesIn(css: string, offset: number, file: string, out: Face[]) {
  for (const m of maskComments(css).matchAll(/@font-face\s*\{[^}]*\}/gi)) {
    const text = css.slice(m.index!, m.index! + m[0].length)
    const get = (k: string) => text.match(new RegExp(`(?:^|[;{\\s])${k}\\s*:\\s*([^;}]+)`, 'i'))?.[1].trim() ?? ''
    const family = unquote(get('font-family'))
    if (!family) continue
    const src = [...get('src').matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((u) => u[2].trim())
    out.push({ family, file, start: offset + m.index!, end: offset + m.index! + m[0].length, text, src, weight: get('font-weight') || '400', style: get('font-style') || 'normal' })
  }
}

const SIZE_TOKEN = /\d(px|r?em|%|vw|vh|vmin|vmax|ch|ex|pt|cqi|cqw|lh|q)\b|^(clamp|calc|min|max)\(|^(xx?-small|x?-large|small|medium|large|larger|smaller)$|\//i
const looksLikeStack = (v: string) => {
  const items = splitTop(v).map((x) => x.text.trim())
  if (!items.length || !items[0]) return false
  if (GENERIC.has(lower(items[items.length - 1])) && items.length > 1) return true
  return items.length > 1 && /^["']/.test(items[0]) && items.every((x) => /^["'][^"']+["']$|^[a-z][\w -]*$/i.test(x))
}

function stacksIn(css: string, offset: number, file: string, out: Stack[]) {
  // an @font-face's own font-family names the font it defines, it doesn't use one
  const masked = maskComments(css).replace(/@font-face\s*\{[^}]*\}/gi, spaces)
  for (const d of masked.matchAll(DECL)) {
    const prop = d[1].toLowerCase()
    const vStart = d.index! + d[0].length - d[2].length
    let value = css.slice(vStart, vStart + d[2].length)
    value = value.replace(/\s*!\s*important\s*$/i, '')
    let at = 0
    if (prop === 'font') {
      // the family list comes after the size (and line height)
      let depth = 0
      let q: string | null = null
      let tokStart = 0
      let last = -1
      for (let i = 0; i <= value.length; i++) {
        const ch = value[i]
        if (q) {
          if (ch === q) q = null
          continue
        }
        if (ch === '"' || ch === "'") {
          q = ch
          continue
        }
        if (ch === '(') depth++
        if (ch === ')') depth--
        if ((i === value.length || /\s/.test(ch)) && !depth) {
          const tok = value.slice(tokStart, i)
          if (tok && SIZE_TOKEN.test(tok)) last = i
          tokStart = i + 1
        }
      }
      if (last < 0) continue
      at = last
    } else if (prop !== 'font-family' && !(isVar(d[1]) && looksLikeStack(value))) continue
    const fam = value.slice(at)
    const lead = fam.length - fam.trimStart().length
    const text = fam.trim()
    if (!text || /^var\(/i.test(text) || /^(inherit|initial|unset|revert|caption|icon|menu|message-box|small-caption|status-bar)$/i.test(text)) continue
    out.push({ file, index: offset + vStart + at + lead, text, prop: d[1] })
  }
}

interface FontScan {
  faces: Face[]
  stacks: Stack[]
  /** Google Fonts stylesheet addresses, where they're written */
  google: { file: string; index: number; url: string; families: string[] }[]
  bodies: Map<string, string>
}

function scanFonts(files: string[]): FontScan {
  const faces: Face[] = []
  const stacks: Stack[] = []
  const google: FontScan['google'] = []
  const bodies = new Map<string, string>()
  for (const f of files) {
    const body = read(f)
    bodies.set(f, body)
    const css = (text: string, offset: number) => {
      facesIn(text, offset, f, faces)
      stacksIn(text, offset, f, stacks)
    }
    if (STYLE_FILE.test(f)) css(body, 0)
    else if (MARKUP_FILE.test(f)) {
      for (const m of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css(m[1], m.index! + m[0].indexOf('>') + 1)
      for (const m of body.matchAll(/(?<![\w-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const v = m[1] ?? m[2]
        stacksIn(`${v};`, m.index! + m[0].length - v.length - 1, f, stacks)
      }
    }
    for (const m of body.matchAll(/https?:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s)<>]+/g)) {
      const url = m[0].replace(/&amp;/g, '&')
      const families = [...url.matchAll(/[?&]family=([^&:]+)/g)].map((x) => decodeURIComponent(x[1].replace(/\+/g, ' ')).split('|')[0].trim())
      google.push({ file: f, index: m.index!, url: m[0], families })
    }
  }
  return { faces, stacks, google, bodies }
}

// --- Google Fonts -----------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
export const FONT_CACHE = path.join(DATA_DIR, 'studio-fonts')
const CATEGORY: Record<string, StudioFontCategory> = { 'Sans Serif': 'sans-serif', Serif: 'serif', Display: 'display', Handwriting: 'handwriting', Monospace: 'monospace' }

let catalog: GoogleFont[] | null = null
let loading: Promise<GoogleFont[]> | null = null

/** Every Google font with Latin letters, most popular first (read once a fortnight, cached on this computer). */
export function googleCatalog(): Promise<GoogleFont[]> {
  if (catalog) return Promise.resolve(catalog)
  loading ??= (async () => {
    const file = path.join(FONT_CACHE, 'catalog.json')
    let cached: { at: number; list: GoogleFont[] } | null = null
    try {
      cached = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (cached && Date.now() - cached.at < 14 * 86_400_000 && cached.list.length) return (catalog = cached.list)
    } catch {
      /* not fetched yet */
    }
    try {
      const r = await fetch('https://fonts.google.com/metadata/fonts', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
      if (!r.ok) throw new Error(`Google Fonts answered ${r.status}`)
      const d = JSON.parse((await r.text()).replace(/^\)\]\}'\s*/, '')) as {
        familyMetadataList: { family: string; category: string; stroke: string | null; subsets: string[]; fonts: Record<string, unknown>; axes: { tag: string; min: number; max: number }[]; popularity: number; primaryScript?: string; isBrandFont?: boolean }[]
      }
      const list = d.familyMetadataList
        .filter((f) => f.subsets?.includes('latin') && !f.primaryScript && !f.isBrandFont && CATEGORY[f.category])
        .sort((a, b) => a.popularity - b.popularity)
        .map((f): GoogleFont => {
          const keys = Object.keys(f.fonts ?? {})
          const w = f.axes?.find((a) => a.tag === 'wght')
          return {
            family: f.family,
            category: CATEGORY[f.category],
            stroke: f.stroke === 'Serif' || f.stroke === 'Slab Serif' ? 'serif' : f.stroke === 'Sans Serif' ? 'sans-serif' : null,
            weights: [...new Set(keys.filter((k) => /^\d+$/.test(k)).map(Number))].sort((a, b) => a - b),
            italics: [...new Set(keys.filter((k) => /^\d+i$/.test(k)).map((k) => parseInt(k)))].sort((a, b) => a - b),
            variable: w ? { min: w.min, max: w.max } : null,
          }
        })
      fs.mkdirSync(FONT_CACHE, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), list }))
      return (catalog = list)
    } catch (e) {
      if (cached?.list.length) return (catalog = cached.list)
      throw new Error(`Google Fonts can’t be reached right now (${(e as Error).message})`)
    } finally {
      loading = null
    }
  })()
  return loading
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const squashName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const nearest = (list: number[], w: number) => list.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) ? x : best), list[0] ?? 400)

async function download(url: string, file: string) {
  if (fs.existsSync(file)) return
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45_000) })
  if (!r.ok) throw new Error(`Google Fonts answered ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 100 || buf.length > 5_000_000) throw new Error('That font file didn’t come through')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.part`, buf)
  fs.renameSync(`${file}.part`, file)
}

const familyParam = (f: string) => encodeURIComponent(f).replace(/%20/g, '+')

/** a font's name drawn in itself, for the list to pick from: a few KB, cached */
export async function googlePreview(family: string): Promise<string> {
  const f = (await googleCatalog()).find((x) => x.family === family)
  if (!f) throw new Error('That font isn’t on Google Fonts')
  const file = path.join(FONT_CACHE, 'preview', `${slugOf(family)}.woff2`)
  if (fs.existsSync(file)) return file
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${familyParam(family)}&text=${encodeURIComponent(`${family} Aa`)}&display=swap`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })).text()
  const url = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1]
  if (!url) throw new Error('Google Fonts sent no preview')
  await download(url, file)
  return file
}

/** a cached font file by name, for the canvas (null when it's not one of ours) */
export function cachedFont(name: string): string | null {
  if (!/^[a-f0-9]{16}\.woff2$/.test(name)) return null
  const file = path.join(FONT_CACHE, 'files', name)
  return fs.existsSync(file) ? file : null
}

/** A Google font's files (Latin and Latin Extended), fetched into the cache: the weights wanted, or its whole range if it's variable. */
export async function googleFaces(family: string, want: { weights: number[]; italic: boolean; pin?: { weight: number; declare: string } | null }): Promise<StudioFontFace[]> {
  const f = (await googleCatalog()).find((x) => x.family === family)
  if (!f) throw new Error('That font isn’t on Google Fonts')
  let spec: string
  const pin = want.pin ?? null
  // the old font was one weight whatever the CSS asked for: so is the new one, at the nearest weight it has
  const pinTo = pin ? (f.variable ? Math.max(f.variable.min, Math.min(f.variable.max, pin.weight)) : nearest(f.weights, pin.weight)) : 0
  if (pin) {
    const it = f.variable ? (f.italics.length ? pinTo : 0) : f.italics.length ? nearest(f.italics, pin.weight) : 0
    spec = want.italic && it ? `ital,wght@0,${pinTo};1,${it}` : `wght@${pinTo}`
  } else if (f.variable) {
    const r = `${f.variable.min}..${f.variable.max}`
    spec = want.italic && f.italics.length ? `ital,wght@0,${r};1,${r}` : `wght@${r}`
  } else {
    const ws = [...new Set([400, ...want.weights].map((w) => nearest(f.weights, w)))].sort((a, b) => a - b).slice(0, 6)
    const its = want.italic ? ws.map((w) => nearest(f.italics, w)).filter((w, i, a) => f.italics.length && a.indexOf(w) === i) : []
    spec = its.length ? `ital,wght@${[...ws.map((w) => `0,${w}`), ...its.sort((a, b) => a - b).map((w) => `1,${w}`)].join(';')}` : `wght@${ws.join(';')}`
  }
  const res = await fetch(`https://fonts.googleapis.com/css2?family=${familyParam(family)}:${spec}&display=swap`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`)
  const css = await res.text()
  const faces: StudioFontFace[] = []
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)]
  for (const m of blocks) {
    const subset = m[1] ?? 'all'
    if (m[1] && subset !== 'latin' && subset !== 'latin-ext') continue
    const get = (k: string) => m[2].match(new RegExp(`${k}\\s*:\\s*([^;]+)`))?.[1].trim() ?? ''
    const url = get('src').match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1]
    if (!url) continue
    const name = `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}.woff2`
    await download(url, path.join(FONT_CACHE, 'files', name))
    const weight = get('font-weight') || '400'
    faces.push({ file: name, weight: pin ? pin.declare : weight, ...(pin ? { actual: parseInt(weight) } : {}), style: get('font-style') === 'italic' ? 'italic' : 'normal', subset, unicodeRange: get('unicode-range') || null })
  }
  if (!faces.length) throw new Error('Google Fonts sent no files for that font')
  // upright before italic, Latin before Latin Extended, light to bold: the order a person would write them
  const rank = (x: StudioFontFace) => (x.style === 'italic' ? 1000 : 0) + (x.subset === 'latin' ? 0 : 500) + (x.actual ?? parseInt(x.weight)) / 10
  return faces.sort((a, b) => rank(a) - rank(b))
}

// --- The site's fonts -------------------------------------------------------------------------

const WEIGHT_WORD: Record<string, number> = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 }
/** the weight a font file is, from its name (cormorant-garamond-600.woff2, Lato-Bold.woff2) */
function weightInName(src: string): number | null {
  const base = path.basename(src.split(/[?#]/)[0]).replace(/\.[a-z0-9]+$/i, '').toLowerCase()
  const n = base.match(/(?:^|[-_ ])([1-9]00)(?:i|italic)?(?=[-_ ]|$)/)
  if (n) return Number(n[1])
  const w = base.match(/(?:^|[-_ ])(thin|hairline|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy)(?:italic)?(?=[-_ ]|$)/)
  return w ? WEIGHT_WORD[w[1]] : null
}
/** one fixed-weight file per style, each set to cover a range of weights: whatever weight the CSS asks for, it's that weight */
function pinnedOf(faces: Face[]): number | null {
  if (!faces.length || faces.some((f) => !/\d\s+\d/.test(f.weight))) return null
  const ws = faces.map((f) => f.src.map(weightInName).find((w) => w !== null) ?? null)
  return ws.every((w) => w !== null && w === ws[0]) ? ws[0] : null
}

const GENERIC_CATEGORY: Record<string, StudioFontCategory> = { serif: 'serif', 'ui-serif': 'serif', 'sans-serif': 'sans-serif', 'system-ui': 'sans-serif', 'ui-sans-serif': 'sans-serif', '-apple-system': 'sans-serif', monospace: 'monospace', 'ui-monospace': 'monospace', cursive: 'handwriting', fantasy: 'display' }

/** Every font family the site's CSS names (not counting fallbacks), most used first. */
export async function siteFonts(dir: string, kind: StudioKind, root: string): Promise<{ fonts: StudioFont[]; google: boolean }> {
  let list: GoogleFont[] = []
  try {
    list = await googleCatalog()
  } catch {
    /* offline: categories come from the font stacks */
  }
  const byName = new Map(list.map((g) => [squashName(g.family), g]))
  const scan = scanFonts(themeFiles(dir, kind))
  const fams = new Map<string, { family: string; uses: number; tokens: Set<string>; stacks: string[]; faces: Face[]; google: boolean }>()
  const entry = (name: string) => {
    const k = name.toLowerCase()
    let e = fams.get(k)
    if (!e) fams.set(k, (e = { family: name, uses: 0, tokens: new Set(), stacks: [], faces: [], google: false }))
    return e
  }
  for (const f of scan.faces) entry(f.family).faces.push(f)
  for (const g of scan.google) for (const fam of g.families) entry(fam).google = true
  const tokenFamily = new Map<string, string>()
  for (const s of scan.stacks) {
    const first = unquote(splitTop(s.text)[0]?.text ?? '')
    if (!first || GENERIC.has(first.toLowerCase())) continue
    const e = entry(first)
    e.stacks.push(s.text)
    if (isVar(s.prop)) {
      e.tokens.add(s.prop)
      if (!tokenFamily.has(s.prop)) tokenFamily.set(s.prop, first.toLowerCase())
    } else e.uses++
  }
  const { refs, resolve } = tokenUse([...scan.bodies.values()])
  for (const [name, n] of refs) {
    const t = resolve(name, (x) => tokenFamily.has(x))
    if (!t) continue
    fams.get(tokenFamily.get(t)!)!.uses += n
  }
  const fonts: StudioFont[] = []
  for (const e of fams.values()) {
    // a name only the visitor's computer would have (Georgia, Arial), with nothing loading it, is a fallback, not a choice
    if (!e.faces.length && !e.google && !e.stacks.length) continue
    const stack = e.stacks.sort((a, b) => b.length - a.length)[0] ?? `"${e.family}"`
    const items = splitTop(stack).map((x) => unquote(x.text))
    // the typeface behind a site's own name: a Google font named in its fallbacks or its file names
    let actual: GoogleFont | null = byName.get(squashName(e.family)) ?? null
    if (!actual) for (const it of items.slice(1)) if (!actual && !GENERIC.has(it.toLowerCase()) && byName.has(squashName(it))) actual = byName.get(squashName(it))!
    if (!actual)
      for (const f of e.faces)
        for (const s of f.src) {
          const base = squashName(
            path
              .basename(s)
              .replace(/\.[a-z0-9]+$/i, '')
              .replace(/[-_](latin(-ext)?|var(iable)?|vf|wght|italic|regular|normal|\d{3}i?|[0-9a-z]{6,}(?=$))+$/gi, '')
              .replace(/([-_](latin(-ext)?|var(iable)?|vf|wght|italic|regular|normal|\d{3}i?))+$/gi, ''),
          )
          if (!actual && byName.has(base)) actual = byName.get(base)!
        }
    const generic = items.map((x) => x.toLowerCase()).find((x) => GENERIC_CATEGORY[x])
    const category = actual?.category ?? (generic ? GENERIC_CATEGORY[generic] : 'sans-serif')
    const source: StudioFont['source'] = e.faces.length ? 'site' : e.google ? 'google' : 'system'
    if (source === 'system' && SYSTEM.has(e.family.toLowerCase()) && !e.uses) continue
    // each file as the repo has it, and as the site serves it
    const publicRoot = kind === 'astro' ? path.join(dir, 'public') : root
    const fileOf = (f: Face, s: string) => {
      const clean = s.split(/[?#]/)[0]
      return clean.startsWith('/') ? path.join(publicRoot, clean) : STYLE_FILE.test(f.file) ? path.resolve(path.dirname(f.file), clean) : null
    }
    const files = [...new Set(e.faces.flatMap((f) => f.src.map((s) => fileOf(f, s)).filter((x): x is string => !!x && fs.existsSync(x)).map((x) => relOf(dir, x))))]
    const faces = e.faces
      .map((f) => {
        const file = f.src.filter((s) => /\.woff2?(\?|#|$)/i.test(s)).map((s) => fileOf(f, s)).find((x): x is string => !!x && x.startsWith(path.resolve(publicRoot) + path.sep))
        return file ? { url: `/${path.relative(publicRoot, file).split(path.sep).join('/')}`, weight: f.weight, style: f.style } : null
      })
      .filter((x): x is { url: string; weight: string; style: string } => !!x)
    fonts.push({
      family: e.family,
      actual: actual && actual.family.toLowerCase() !== e.family.toLowerCase() ? actual.family : null,
      category,
      source,
      uses: e.uses,
      tokens: [...e.tokens],
      weights: [...new Set(e.faces.map((f) => f.weight.replace(/\s+/g, ' ')))],
      pinned: pinnedOf(e.faces),
      italic: e.faces.some((f) => /italic|oblique/i.test(f.style)),
      files,
      faces,
      stack,
    })
  }
  fonts.sort((a, b) => b.uses - a.uses)
  return { fonts: fonts.slice(0, 30), google: list.length > 0 }
}

// --- Swapping fonts in the source -------------------------------------------------------------

const FALLBACKS: Record<StudioFontCategory, string[]> = {
  serif: ['Georgia', 'Times New Roman', 'serif'],
  'sans-serif': ['system-ui', 'Segoe UI', 'Arial', 'sans-serif'],
  monospace: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'],
  handwriting: ['cursive'],
  display: ['system-ui', 'Arial', 'sans-serif'],
}
/** what kind of fallback a category wants: a display font falls back like a sans */
const baseOf = (c: StudioFontCategory | undefined) => (c === 'display' ? 'sans-serif' : c)

interface Edit {
  index: number
  length: number
  text: string
}

/** a family's name as CSS: quoted (in the site's own quote style) unless it's a keyword, or a one-word fallback */
const nameCss = (name: string, q: string, loose = false) => (GENERIC.has(name.toLowerCase()) || (loose && /^[a-z][a-z-]*$/i.test(name)) ? name : `${q}${name.split(q).join('')}${q}`)

/**
 * Swap fonts across the site's source: the new font's files go next to the
 * site's other fonts (fetched from the cache), with @font-face rules that set
 * the size it was matched at, every font stack naming the old font names the
 * new one, preloads point at the new files, and the old font's rules and
 * files go once nothing names it any more.
 */
export function fontSwap(dir: string, kind: StudioKind, root: string, swaps: StudioFontSwap[]): { files: string[]; notes: string[] } {
  const files = themeFiles(dir, kind)
  const scan = scanFonts(files)
  const edits = new Map<string, Edit[]>()
  const edit = (file: string, e: Edit) => edits.set(file, [...(edits.get(file) ?? []), e])
  const notes: string[] = []
  const wrote: string[] = []
  const removed: string[] = []
  /** the font files each page preloads once these edits are in (two fonts swapped to one share a preload) */
  const preloaded = new Map<string, Set<string>>()
  const publicRoot = kind === 'astro' ? path.join(dir, 'public') : root
  // the site's own quote style for font names
  const quotes = [...scan.stacks.map((x) => x.text), ...scan.faces.map((f) => f.text)].join('')
  const q = quotes.split("'").length > quotes.split('"').length ? "'" : '"'

  /** a font's src address, as the file in the repo */
  const fileOfSrc = (cssFile: string, src: string) => {
    const clean = src.split(/[?#]/)[0]
    const abs = clean.startsWith('/') ? path.join(publicRoot, clean) : STYLE_FILE.test(cssFile) ? path.resolve(path.dirname(cssFile), clean) : path.join(publicRoot, clean)
    return abs.startsWith(path.resolve(dir) + path.sep) ? abs : null
  }
  /** how a stylesheet should point at a font file: the way the site's other fonts are pointed at */
  const srcFor = (cssFile: string, file: string, like?: string) => {
    if (kind === 'astro' || like?.startsWith('/') || !STYLE_FILE.test(cssFile)) return `/${path.relative(publicRoot, file).split(path.sep).join('/')}`
    return path.relative(path.dirname(cssFile), file).split(path.sep).join('/')
  }
  /** the stylesheet that sets most of the site's fonts: new @font-face rules go there when there's nowhere better */
  const mainSheet = () => {
    const count = new Map<string, number>()
    for (const s of [...scan.stacks, ...scan.faces.map((f) => ({ file: f.file }))]) if (STYLE_FILE.test(s.file)) count.set(s.file, (count.get(s.file) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }

  const targets = new Map<string, number>()
  for (const s of swaps) targets.set(s.to.toLowerCase(), (targets.get(s.to.toLowerCase()) ?? 0) + 1)
  // a font swapped away can't also stand in for another (Studio passes the end of the chain)
  const leaving = new Set(swaps.map((s) => s.from.toLowerCase()))
  const chained = swaps.find((s) => leaving.has(s.to.toLowerCase()))
  if (chained) throw new Error(`${chained.to} is being swapped too, so it can’t replace ${chained.from}`)

  for (const s of swaps) {
    const fromFaces = scan.faces.filter((f) => f.family.toLowerCase() === s.from.toLowerCase())
    const toFaces = scan.faces.filter((f) => f.family.toLowerCase() === s.to.toLowerCase())
    const pct = Math.round(s.scale * 1000) / 10
    const sized = Math.abs(pct - 100) >= 0.5
    const familyRe = new RegExp(`(["']?)${s.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'gi')
    const word = (body: string, at: number, len: number) => !/[\w-]/.test(body[at + len] ?? '') && !/[\w-]/.test(body[at - 1] ?? '')
    // scripts that wait for the old font to load (document.fonts.load('1em "Old"')) wait for the new one
    const loads: { file: string; index: number; length: number; quote: string; outer: string }[] = []
    for (const [file, body] of scan.bodies) {
      if (STYLE_FILE.test(file)) continue
      for (const m of body.matchAll(/\bfonts\.(?:load|check)\(\s*(["'`])((?:(?!\1)[^\n])*)\1/g)) {
        const start = m.index! + m[0].indexOf(m[1]) + 1
        for (const n of m[2].matchAll(familyRe)) if (word(m[2], n.index!, n[0].length)) loads.push({ file, index: start + n.index!, length: n[0].length, quote: n[1], outer: m[1] })
      }
    }
    // the old font's own rules and files go, once nothing else names it (a comment doesn't count)
    let elsewhere = 0
    for (const [file, body] of scan.bodies) {
      const covered = [
        ...scan.faces.filter((f) => f.file === file && f.family.toLowerCase() === s.from.toLowerCase()).map((f) => [f.start, f.end]),
        ...scan.stacks.filter((x) => x.file === file).map((x) => [x.index, x.index + x.text.length]),
        ...loads.filter((l) => l.file === file).map((l) => [l.index, l.index + l.length]),
      ]
      for (const m of maskAnyComments(body).matchAll(familyRe)) if (!covered.some(([a, b]) => m.index! >= a && m.index! < b) && word(body, m.index!, m[0].length)) elsewhere++
    }
    const goes = !elsewhere && fromFaces.length > 0 && s.from.toLowerCase() !== s.to.toLowerCase()
    // the name the new font goes by: its own, or its own plus the size when it's shown at another size for this swap
    let name = s.to
    const anchor = fromFaces[fromFaces.length - 1] ?? null
    const tailOf = (f: Face) => scan.bodies.get(f.file)!.slice(f.end).match(/^[ \t]*\n?/)![0].length
    const like = anchor ?? toFaces[0] ?? scan.faces[0] ?? null
    const oneLine = like ? !like.text.includes('\n') : false
    const indent = like?.text.match(/\n([ \t]+)\S/)?.[1] ?? '  '
    const block = (desc: [string, string][]) => (oneLine ? `@font-face { ${desc.map(([k, v]) => `${k}: ${v};`).join(' ')} }` : `@font-face {\n${desc.map(([k, v]) => `${indent}${k}: ${v};`).join('\n')}\n}`)
    const why = sized ? `, at ${pct}% so it looks the same size as ${s.from} did` : ''
    let primary: string | null = null
    const fileOf = (f: Face | undefined) => (f ? (f.src.map((x) => fileOfSrc(f.file, x)).find((x): x is string => !!x) ?? null) : null)
    if (s.google && !toFaces.length) {
      if (!s.faces?.length) throw new Error(`The files for ${s.to} weren’t fetched. Pick it again.`)
      if (sized && (targets.get(s.to.toLowerCase()) ?? 0) > 1) name = `${s.to} ${Math.round(pct)}`
      // next to the old font's files, or in the site's font folder
      const oldFile = fileOf(anchor ?? undefined)
      const fontDir = oldFile ? path.dirname(oldFile) : kind === 'astro' ? path.join(dir, 'public', 'fonts') : path.join(root, 'fonts')
      const sheet = anchor?.file ?? mainSheet()
      if (!sheet) throw new Error('This site has no stylesheet to add the font to')
      fs.mkdirSync(fontDir, { recursive: true })
      const blocks: string[] = []
      for (const f of s.faces) {
        const cached = cachedFont(f.file)
        if (!cached) throw new Error(`A file for ${s.to} is missing from Studio’s cache. Pick the font again.`)
        const file = path.join(fontDir, `${slugOf(s.to)}-${f.actual ?? (f.weight.includes(' ') ? 'var' : f.weight)}${f.style === 'italic' ? '-italic' : ''}${f.subset === 'all' ? '' : `-${f.subset}`}.woff2`)
        fs.copyFileSync(cached, file)
        wrote.push(file)
        if (!primary && f.style === 'normal' && (f.subset === 'latin' || f.subset === 'all') && (f.weight.includes(' ') || f.weight === '400')) primary = file
        const desc: [string, string][] = [
          ['font-family', nameCss(name, q)],
          ['src', `url(${q}${srcFor(sheet, file, anchor?.src[0])}${q}) format(${q}woff2${q})`],
          ['font-weight', f.weight],
          ['font-style', f.style],
          ['font-display', 'swap'],
        ]
        if (sized) desc.push(['size-adjust', `${pct}%`])
        if (f.unicodeRange) desc.push(['unicode-range', f.unicodeRange])
        blocks.push(block(desc))
      }
      primary ??= wrote[wrote.length - s.faces.length] ?? null
      const text = `/* ${s.to}, from Google Fonts${why} */\n${blocks.join('\n')}\n`
      if (anchor) {
        // where the old font's rules were (they go), or just after them, spaced the way the site spaces them
        const at = anchor.end + tailOf(anchor)
        const spaced = !goes && (scan.bodies.get(sheet) ?? '').slice(at).startsWith('\n')
        edit(sheet, { index: at, length: 0, text: `${spaced ? '\n' : ''}${text}` })
      } else edit(sheet, { index: afterImports(scan.bodies.get(sheet) ?? ''), length: 0, text: `${text}\n` })
    } else if (toFaces.length && sized) {
      // a font the site already has, at another size: a copy of its rules under a new name, next to each
      name = `${s.to} ${Math.round(pct)}`
      toFaces.forEach((f, i) => {
        let t = f.text.replace(/(font-family\s*:\s*)[^;}]+/i, `$1${nameCss(name, q)}`)
        const had = t.match(/size-adjust\s*:\s*([\d.]+)%/i)
        const total = Math.round((had ? Number(had[1]) : 100) * s.scale * 10) / 10
        if (had) t = t.replace(/size-adjust\s*:\s*[\d.]+%/i, `size-adjust: ${total}%`)
        else t = t.replace(/\s*;?\s*\}$/, f.text.includes('\n') ? `;\n${indent}size-adjust: ${total}%;\n}` : `; size-adjust: ${total}%; }`)
        edit(f.file, { index: f.end + tailOf(f), length: 0, text: `${i ? '' : `/* ${s.to}${why} */\n`}${t}\n` })
      })
      primary = fileOf(toFaces.find((f) => /normal/i.test(f.style)) ?? toFaces[0])
    } else primary = fileOf(toFaces.find((f) => /normal/i.test(f.style)) ?? toFaces[0])

    // every font stack naming the old font
    let stacks = 0
    for (const st of scan.stacks) {
      const items = splitTop(st.text)
      const i = items.findIndex((x) => lower(x.text) === s.from.toLowerCase())
      if (i < 0) continue
      const sep = st.text.match(/,\s*/)?.[0] ?? ', '
      const qq = items[i].text.trim().match(/^["']/)?.[0] ?? q
      let out: string[]
      if (i === 0) {
        // the fallbacks still fit when the kind of font hasn't changed (minus the old typeface's own name)
        const rest = items.slice(1).map((x) => x.text.trim())
        const oldGeneric = rest.map(lower).find((x) => GENERIC_CATEGORY[x])
        const keep = !!oldGeneric && baseOf(GENERIC_CATEGORY[oldGeneric]) === baseOf(s.category)
        const fallbacks = keep ? rest.filter((x) => GENERIC.has(lower(x)) || SYSTEM.has(lower(x))) : FALLBACKS[s.category].map((x) => nameCss(x, qq, true))
        out = [nameCss(name, qq), ...fallbacks]
      } else out = items.map((x, j) => (j === i ? nameCss(name, qq) : x.text.trim()))
      edit(st.file, { index: st.index, length: st.text.length, text: out.join(sep) })
      stacks++
    }

    for (const l of loads) edit(l.file, { index: l.index, length: l.length, text: l.quote || !/\s/.test(name) ? `${l.quote}${name}${l.quote}` : `${l.outer === '"' ? "'" : '"'}${name}${l.outer === '"' ? "'" : '"'}` })

    // preloads of the old font's files point at the new font's
    const oldFiles = new Set(fromFaces.flatMap((f) => f.src.map((x) => path.basename(x.split(/[?#]/)[0]))))
    if (primary && oldFiles.size) {
      for (const [file, body] of scan.bodies) {
        if (!MARKUP_FILE.test(file)) continue
        const seenHere = preloaded.get(file) ?? preloaded.set(file, new Set()).get(file)!
        for (const m of body.matchAll(/[ \t]*<link\b[^>]*\brel\s*=\s*["']?preload["']?[^>]*>\n?/gi)) {
          const href = m[0].match(/\bhref\s*=\s*(["'])([^"']+)\1/i)
          if (!href || !/\bas\s*=\s*["']?font/i.test(m[0]) || !oldFiles.has(path.basename(href[2]))) continue
          const next = href[2].startsWith('/') ? `/${path.relative(publicRoot, primary).split(path.sep).join('/')}` : href[2].replace(/[^/]+$/, path.basename(primary))
          if (seenHere.has(next) || body.includes(`"${next}"`) || body.includes(`'${next}'`)) edit(file, { index: m.index!, length: m[0].length, text: '' })
          else edit(file, { index: m.index! + m[0].indexOf(href[2]), length: href[2].length, text: next })
          seenHere.add(next)
        }
      }
    }

    // a font loaded from Google Fonts: it isn't loaded any more
    for (const g of scan.google) {
      if (!g.families.some((f) => f.toLowerCase() === s.from.toLowerCase())) continue
      const body = scan.bodies.get(g.file)!
      const params = g.url.split(/(?=[?&]family=)|(?=&(?!family=))/)
      const kept = params.filter((p) => !/^[?&]family=/.test(p) || decodeURIComponent(p.replace(/^[?&]family=/, '').split(':')[0].replace(/\+/g, ' ')).trim().toLowerCase() !== s.from.toLowerCase())
      if (kept.some((p) => /^[?&]family=/.test(p))) {
        let url = kept.join('')
        if (!url.includes('?')) url = url.replace('&', '?')
        edit(g.file, { index: g.index, length: g.url.length, text: url })
      } else {
        // the whole <link> or @import goes
        const lineStart = body.lastIndexOf('\n', g.index) + 1
        const tag = body.slice(lineStart).match(/^[ \t]*(<link\b[^>]*>|@import\s+url\([^)]*\)\s*;?|@import\s+["'][^"']*["']\s*;?)[ \t]*\n?/i)
        if (tag && lineStart + tag[0].length > g.index) edit(g.file, { index: lineStart, length: tag[0].length, text: '' })
        else edit(g.file, { index: g.index, length: g.url.length, text: g.url })
      }
    }

    // the old font's own rules and files
    if (goes) {
      for (const f of fromFaces) {
        const body = scan.bodies.get(f.file)!
        // with the indent before it, and a comment just above it that's about this font
        let start = f.start - (body.slice(0, f.start).match(/[ \t]*$/)?.[0].length ?? 0)
        const note = body.slice(0, start).match(/\/\*([^*]*)\*\/[ \t]*\n$/)
        if (note && note[1].toLowerCase().includes(s.from.toLowerCase())) start -= note[0].length
        // and the blank line after it, when there's one before it too (so rules spaced apart stay spaced once;
        // not the last one when the new font's rules go just after it)
        let end = f.end + tailOf(f)
        if (!(f === anchor && s.google && !toFaces.length) && /(^|\n[ \t]*\n)$/.test(body.slice(0, start)) && /^[ \t]*\n/.test(body.slice(end))) end += body.slice(end).match(/^[ \t]*\n/)![0].length
        edit(f.file, { index: start, length: end - start, text: '' })
        for (const src of f.src) {
          const file = fileOfSrc(f.file, src)
          if (file && fs.existsSync(file) && !wrote.includes(file)) removed.push(file)
        }
      }
    }
    notes.push(`${s.from} → ${s.to}${sized ? ` at ${pct}%` : ''} (${stacks} font stack${stacks === 1 ? '' : 's'})`)
  }

  // apply the edits, last first so the places stay right
  const changed = new Set<string>()
  const after = new Map(scan.bodies)
  for (const [file, list] of edits) {
    let body = scan.bodies.get(file) ?? read(file)
    // (at the same place, what's taken out goes before what's put in)
    const sorted = [...list].sort((a, b) => b.index - a.index || b.length - a.length)
    let floor = Infinity
    for (const e of sorted) {
      // two edits on the same place: the first one stands
      if (e.index + e.length > floor) continue
      body = body.slice(0, e.index) + e.text + body.slice(e.index + e.length)
      floor = e.index
    }
    fs.writeFileSync(file, body)
    after.set(file, body)
    changed.add(relOf(dir, file))
  }
  // the old font's files go once nothing points at them (a preload, another rule, a script)
  for (const f of new Set(removed)) {
    if ([...after.values()].some((b) => b.includes(path.basename(f)))) continue
    try {
      fs.unlinkSync(f)
      changed.add(relOf(dir, f))
    } catch (e) {
      log('studio fonts: remove', f, (e as Error).message)
    }
  }
  for (const f of wrote) changed.add(relOf(dir, f))
  return { files: [...changed], notes }
}

/** a Google font's files fetched again if the cache lost them (they're named by address, so the names stay the same unless Google updated the font) */
export async function ensureFaces(swaps: StudioFontSwap[]): Promise<StudioFontSwap[]> {
  return Promise.all(
    swaps.map(async (s) => {
      if (!s.google || !s.faces?.length || s.faces.every((f) => cachedFont(f.file))) return s
      const weights = [...new Set(s.faces.map((f) => f.actual ?? parseInt(f.weight)).filter(Boolean))]
      const pinned = s.faces.find((f) => f.actual)
      return { ...s, faces: await googleFaces(s.to, { weights, italic: s.faces.some((f) => f.style === 'italic'), pin: pinned ? { weight: pinned.actual!, declare: pinned.weight } : null }) }
    }),
  )
}

/** where new rules go at the top of a stylesheet: after @charset and @import */
function afterImports(css: string): number {
  const m = css.match(/^(\s*(@charset[^;]*;|@import[^;]*;|\/\*[\s\S]*?\*\/))*\s*/)
  return m ? m[0].length : 0
}
