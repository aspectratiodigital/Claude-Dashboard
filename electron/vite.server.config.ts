import { defineConfig } from 'vite'

// Bundles server/app.ts (the local API plus a static file server) into one
// file the desktop app can run without node_modules.
export default defineConfig({
  build: {
    ssr: 'server/app.ts',
    outDir: 'dist-electron',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
  ssr: { noExternal: true },
})
