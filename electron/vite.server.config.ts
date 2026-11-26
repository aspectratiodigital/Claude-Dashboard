import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

// Bundles server/app.ts (the local API plus a static file server) into one
// file the desktop app can run without node_modules. Studio's accessibility
// checker (axe-core) is a script the site's page loads, so it's copied next
// to the bundle rather than bundled into it.
export default defineConfig({
  build: {
    ssr: 'server/app.ts',
    outDir: 'dist-electron',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
  ssr: { noExternal: true },
  plugins: [
    {
      name: 'copy-axe',
      writeBundle(options) {
        const from = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
        fs.copyFileSync(from, path.join(options.dir ?? 'dist-electron', 'axe.min.js'))
      },
    },
  ],
})
