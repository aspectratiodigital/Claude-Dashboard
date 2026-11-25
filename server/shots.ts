import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SHOTS_DIR, log } from './util.ts'

// Screenshots of an app's live web build at phone size, for the floors of an
// app's building. The desktop app takes them in a hidden window of its own
// (electron/main.cjs sets globalThis.blueprintCapture); in the browser
// version they come from Edge or Chrome on this computer, driven by
// playwright-core. One at a time, kept on disk for a day.

type Capture = (url: string, size: { width: number; height: number }) => Promise<Buffer>
/** Studio's screenshots: any size, the whole page or what fits on screen, PNG or JPEG */
export interface ShotOptions {
  width: number
  height: number
  full?: boolean
  /** pixels per CSS pixel: 2 for a sharp picture to send a client */
  scale?: number
  type?: 'png' | 'jpeg'
  /** behave like a phone (touch, mobile layout rules) */
  mobile?: boolean
}
type Shot = (url: string, o: ShotOptions) => Promise<Buffer>
const g = globalThis as { blueprintCapture?: Capture; blueprintShot?: Shot }

const PHONE = { width: 390, height: 844 }
const DIR = path.join(SHOTS_DIR, 'app')
const KEEP = 24 * 3_600_000

let queue: Promise<unknown> = Promise.resolve()
const busy = new Map<string, Promise<{ jpg: Buffer } | { error: string }>>()

/** A phone-sized screenshot of `url`. `version` (the app's commit) makes a new push take fresh ones. */
export function appShot(url: string, version: string): Promise<{ jpg: Buffer } | { error: string }> {
  const file = path.join(DIR, `${createHash('sha1').update(`${url}|${version}`).digest('hex').slice(0, 20)}.jpg`)
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < KEEP) return Promise.resolve({ jpg: fs.readFileSync(file) })
  } catch {
    /* not taken yet */
  }
  const running = busy.get(file)
  if (running) return running
  const job = (queue = queue.then(async () => {
    try {
      const jpg = await (g.blueprintCapture ?? browserCapture)(url, PHONE)
      fs.mkdirSync(DIR, { recursive: true })
      fs.writeFileSync(file, jpg)
      return { jpg }
    } catch (e) {
      log('app shot', url, (e as Error).message)
      return { error: (e as Error).message }
    }
  })) as Promise<{ jpg: Buffer } | { error: string }>
  busy.set(file, job)
  job.finally(() => busy.delete(file))
  return job
}

/** A screenshot of a page Studio is showing (its preview, with your edits). One at a time. */
export function pageShot(url: string, o: ShotOptions): Promise<Buffer> {
  const opts: ShotOptions = { ...o, width: Math.round(Math.min(Math.max(o.width, 280), 3840)), height: Math.round(Math.min(Math.max(o.height, 280), 2400)), scale: Math.min(Math.max(o.scale ?? 1, 1), 3) }
  const job = queue.then(() => (g.blueprintShot ?? browserShot)(url, opts))
  // a failed shot mustn't stop the ones after it
  queue = job.catch(() => {})
  return job
}

// --- the browser version: Edge or Chrome through playwright-core -----------------------------

type Browser = { newPage: (o: object) => Promise<Page>; close: () => Promise<void> }
type Page = {
  goto: (u: string, o: object) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  waitForFunction: (fn: string, arg: unknown, o: object) => Promise<unknown>
  evaluate: (fn: string) => Promise<unknown>
  screenshot: (o: object) => Promise<Buffer>
  close: () => Promise<void>
}

let browser: Promise<Browser> | null = null
let idle: NodeJS.Timeout | undefined

async function launch(): Promise<Browser> {
  const name = 'playwright-core'
  const { chromium } = (await import(/* @vite-ignore */ name)) as { chromium: { launch: (o: object) => Promise<Browser> } }
  const tries: object[] = []
  if (process.env.BLUEPRINT_BROWSER) tries.push({ executablePath: process.env.BLUEPRINT_BROWSER })
  tries.push({ channel: 'msedge' }, { channel: 'chrome' }, {})
  let last: Error | null = null
  for (const t of tries) {
    try {
      return await chromium.launch({ headless: true, ...t })
    } catch (e) {
      last = e as Error
    }
  }
  throw new Error(`No browser to take screenshots with (install Edge or Chrome). ${last?.message.split('\n')[0] ?? ''}`)
}

async function browserShot(url: string, o: ShotOptions): Promise<Buffer> {
  const b = await open()
  const page = await b.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.scale ?? 1, isMobile: !!o.mobile, hasTouch: !!o.mobile })
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    // the page's edits are in once Studio's script says so; then let fonts and reveals settle
    await page.waitForFunction('!window.__studioOps || window.__studioReady', null, { timeout: 15_000 }).catch(() => {})
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => {})
    if (o.full) await scrollThrough(page)
    await page.waitForTimeout(1200)
    return await page.screenshot({ type: o.type ?? 'png', fullPage: !!o.full, ...(o.type === 'jpeg' ? { quality: 85 } : {}) })
  } finally {
    await page.close().catch(() => {})
    closeLater()
  }
}

/** scroll to the bottom and back, so photos that load on scroll and reveal-on-scroll sections show */
async function scrollThrough(page: Page) {
  await page
    .evaluate(
      `(async () => {
        const h = () => document.documentElement.scrollHeight
        for (let y = 0; y < h() && y < 40000; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)) }
        scrollTo(0, h()); await new Promise((r) => setTimeout(r, 400))
        scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300))
      })()`,
    )
    .catch(() => {})
}

function open() {
  clearTimeout(idle)
  browser ??= launch().catch((e) => {
    browser = null
    throw e
  })
  return browser
}

function closeLater() {
  clearTimeout(idle)
  // close the browser after a minute with nothing to do
  idle = setTimeout(() => {
    const was = browser
    browser = null
    was?.then((x) => x.close()).catch(() => {})
  }, 60_000)
}

async function browserCapture(url: string, size: { width: number; height: number }): Promise<Buffer> {
  const b = await open()
  const page = await b.newPage({ viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForTimeout(3500)
    return await page.screenshot({ type: 'jpeg', quality: 82 })
  } finally {
    await page.close().catch(() => {})
    closeLater()
  }
}
