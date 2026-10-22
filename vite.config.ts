import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { jarvisApi } from './server/index.ts'

// base './' so the built app also loads from file:// inside Electron.
// jarvisApi() serves /api/* (GitHub, site checks, Claude sessions, notifications)
// from both `vite` (dev) and `vite preview`.
export default defineConfig({
  base: './',
  plugins: [react(), jarvisApi()],
  server: { port: 5173, watch: { ignored: ['**/.jarvis/**'] } },
  preview: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
})
