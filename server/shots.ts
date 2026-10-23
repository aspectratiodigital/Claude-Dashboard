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
const g = globalThis as { blueprintCapture?: Capture }

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

// --- the browser version: Edge or Chrome through playwright-core -----------------------------

type Browser = { newPage: (o: object) => Promise<Page>; close: () => Promise<void> }
type Page = { goto: (u: string, o: object) => Promise<unknown>; waitForTimeout: (ms: number) => Promise<void>; screenshot: (o: object) => Promise<Buffer>; close: () => Promise<void> }

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

async function browserCapture(url: string, size: { width: number; height: number }): Promise<Buffer> {
  clearTimeout(idle)
  browser ??= launch().catch((e) => {
    browser = null
    throw e
  })
  const b = await browser
  const page = await b.newPage({ viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForTimeout(3500)
    return await page.screenshot({ type: 'jpeg', quality: 82 })
  } finally {
    await page.close().catch(() => {})
    // close the browser after a minute with nothing to do
    idle = setTimeout(() => {
      const was = browser
      browser = null
      was?.then((x) => x.close()).catch(() => {})
    }, 60_000)
  }
}
