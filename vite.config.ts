import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the built app loads from file:// inside Electron
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
})
