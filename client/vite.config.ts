import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 5180/4310 so this duplicate can run alongside the original (5173/4300).
    port: 5180,
    strictPort: true,
    // Dev-time only — in production the Express server serves client/dist
    // directly, so there's nothing to proxy (see Dockerfile).
    proxy: {
      '/api': {
        target: 'http://localhost:4310',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
