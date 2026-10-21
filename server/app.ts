import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { handle, startEngine, stopEngine } from './index.ts'

// The desktop app's server: the built dashboard (dist/) plus the local API, on
// 127.0.0.1 only. Electron starts it and opens a window on it, so the app works
// exactly like `npm run dev` without Node, Vite or a terminal.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

function sendFile(dist: string, pathname: string, res: http.ServerResponse) {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  let file = path.join(dist, rel)
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
  fs.readFile(file, (err, body) => {
    if (err) {
      res.statusCode = 500
      return res.end('Could not read the dashboard files')
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable')
    res.end(body)
  })
}

/** Serve the dashboard on 127.0.0.1. Falls back to any free port if `port` is taken. */
export function serve({ dist, port }: { dist: string; port: number }): Promise<{ url: string; close: () => void }> {
  const root = path.resolve(dist)
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    void handle(req, res, () => sendFile(root, pathname, res))
  })
  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject)
        resolve((server.address() as { port: number }).port)
      })
    })
  return listen(port)
    .catch(() => listen(0))
    .then((p) => {
      startEngine()
      return {
        url: `http://127.0.0.1:${p}`,
        close: () => {
          stopEngine()
          server.close()
        },
      }
    })
}
