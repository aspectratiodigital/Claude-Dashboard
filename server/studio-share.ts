import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { dropOps, holdOps, runtimeOf } from './studio.ts'
import { log } from './util.ts'

// Phone preview: the site you're editing, with your edits, on your own phone.
// A small server on this computer's Wi-Fi address passes the phone's requests
// to the site's Studio preview. It only answers with the secret in the QR
// code (kept as a cookie after the first visit), only reads (GET and HEAD),
// and turns itself off after half an hour with nothing to do.

const PORT = 47180
const IDLE = 30 * 60_000

interface Phone {
  server: http.Server
  port: number
  token: string
  projectId: string
  page: string
  opsKey: string
  ops: unknown[]
  version: number
  /** when Studio last moved to another page, so the phone follows */
  pageVersion: number
  last: number
  timer: NodeJS.Timeout
}

let phone: Phone | null = null

/** this computer's address on the local network (Wi-Fi or Ethernet), not a VPN's or a virtual machine's */
export function lanAddress(): string | null {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((a) => ({ name, ...a })))
  const v4 = all.filter((a) => a.family === 'IPv4' && !a.internal)
  const score = (a: (typeof v4)[number]) => {
    const n = a.name.toLowerCase()
    let s = 0
    if (/^192\.168\./.test(a.address)) s += 3
    else if (/^10\./.test(a.address)) s += 2
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) s += 1
    if (/wi-?fi|wlan|wireless|en0|ethernet|eth0/.test(n)) s += 2
    if (/vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|tailscale|zerotier|vpn|loopback|utun|bridge/.test(n)) s -= 5
    if (/^169\.254\./.test(a.address)) s -= 10
    return s
  }
  return v4.sort((a, b) => score(b) - score(a))[0]?.address ?? null
}

export interface PhoneState {
  on: boolean
  url: string | null
  projectId: string | null
  page: string | null
  address: string | null
}

export function phoneState(): PhoneState {
  if (!phone) return { on: false, url: null, projectId: null, page: null, address: lanAddress() }
  const address = lanAddress()
  return { on: true, url: address ? `http://${address}:${phone.port}${phone.page}?k=${phone.token}` : null, projectId: phone.projectId, page: phone.page, address }
}

function stop() {
  if (!phone) return
  clearTimeout(phone.timer)
  phone.server.close()
  phone.server.closeAllConnections?.()
  dropOps(phone.opsKey)
  phone = null
}

function keepAlive() {
  if (!phone) return
  phone.last = Date.now()
  holdOps(phone.ops, IDLE + 60_000, phone.opsKey)
  clearTimeout(phone.timer)
  phone.timer = setTimeout(() => {
    log('phone preview', 'off after 30 minutes idle')
    stop()
  }, IDLE)
}

// checks every two seconds: reloads when your edits change, and follows you to another page
const POLL = (v: number) =>
  `<script data-studio-phone>(()=>{const v=${v};setInterval(async()=>{try{const r=await fetch('/__studio/phone-version',{cache:'no-store'});const n=await r.json();if(n.v===v)return;if(n.pv>v&&n.page&&n.page!==location.pathname)location.href=n.page;else location.reload()}catch{}},2000)})()</script>`

function cookieOf(req: http.IncomingMessage) {
  return /(?:^|;\s*)studio_phone=([a-f0-9]{32})/.exec(req.headers.cookie ?? '')?.[1] ?? null
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const p = phone
  if (!p) return res.destroy()
  const url = new URL(req.url ?? '/', 'http://phone')
  const given = url.searchParams.get('k')
  if (given && same(given, p.token)) {
    // first visit from the QR code: remember the phone, and drop the secret from the address bar
    url.searchParams.delete('k')
    res.writeHead(302, { Location: url.pathname + url.search, 'Set-Cookie': `studio_phone=${p.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`, 'Cache-Control': 'no-store' })
    return res.end()
  }
  const cookie = cookieOf(req)
  if (!cookie || !same(cookie, p.token)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end('<!doctype html><meta name=viewport content="width=device-width"><p style="font:17px system-ui;padding:24px">Scan the QR code in Studio again to see the preview.</p>')
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    return res.end()
  }
  keepAlive()
  if (url.pathname === '/__studio/phone-version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ v: p.version, pv: p.pageVersion, page: p.page }))
  }
  const r = runtimeOf(p.projectId)
  const port = r?.site.port
  if (!port || r?.site.status === 'error') {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' })
    return res.end('<!doctype html><meta name=viewport content="width=device-width"><p style="font:17px system-ui;padding:24px">The site isn’t open in Studio right now. Open it in Studio and this page will come back.</p><script>setTimeout(()=>location.reload(),5000)</script>')
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}`, 'x-studio-ops': p.opsKey }
  delete headers.cookie
  delete headers['accept-encoding']
  const up = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method: req.method, headers }, (x) => {
    const type = String(x.headers['content-type'] ?? '')
    const h = { ...x.headers }
    delete h['set-cookie']
    if (!type.includes('text/html')) {
      res.writeHead(x.statusCode ?? 502, h)
      return x.pipe(res)
    }
    const chunks: Buffer[] = []
    x.on('data', (c) => chunks.push(c))
    x.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8')
      const tag = POLL(p.version)
      body = /<\/body>/i.test(body) ? body.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : body + tag
      delete h['content-length']
      delete h['content-encoding']
      h['cache-control'] = 'no-store'
      res.writeHead(x.statusCode ?? 200, h)
      res.end(body)
    })
  })
  up.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('The site’s preview isn’t answering')
  })
  up.end()
}

async function listen(server: http.Server): Promise<number> {
  for (const port of [PORT, 0]) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
      return (server.address() as net.AddressInfo).port
    } catch {
      /* in use: take any free port */
    }
  }
  throw new Error('No port free for the phone preview')
}

/** Start (or point) the phone preview at a site's page, with these edits showing. */
export async function phoneOn(projectId: string, page: string, ops: unknown[]): Promise<PhoneState> {
  if (!runtimeOf(projectId)?.site.port) throw new Error('Open the site in Studio first.')
  if (!lanAddress()) throw new Error('This computer isn’t on a network your phone can reach (no Wi-Fi or Ethernet address).')
  if (!phone) {
    const server = http.createServer(handle)
    // no websockets (the site's live reload): the page checks for changes itself
    server.on('upgrade', (_req, socket) => socket.destroy())
    const port = await listen(server)
    phone = { server, port, token: crypto.randomBytes(16).toString('hex'), projectId, page, ops, opsKey: holdOps(ops, IDLE + 60_000), version: Date.now(), pageVersion: 0, last: Date.now(), timer: setTimeout(() => {}, 0) }
  }
  phoneUpdate(projectId, page, ops)
  return phoneState()
}

/** Your edits changed, or you opened another page: the phone reloads to show it. */
export function phoneUpdate(projectId: string, page: string | null, ops: unknown[]): PhoneState {
  if (!phone) return phoneState()
  const v = Math.max(Date.now(), phone.version + 1)
  if ((page && page !== phone.page) || projectId !== phone.projectId) phone.pageVersion = v
  phone.projectId = projectId
  if (page) phone.page = page
  phone.ops = ops
  phone.version = v
  keepAlive()
  return phoneState()
}

export function phoneOff(): PhoneState {
  stop()
  return phoneState()
}
