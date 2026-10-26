import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// VITE_BASE is set by the GitHub Pages build (served from /<repo>/).
// The dev server forwards /api to the backend, so the dashboard and the API
// share one origin: it then works through `tailscale serve` from your phone
// while the backend itself stays bound to 127.0.0.1.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    // IPv4 loopback explicitly: on Windows "localhost" binds to ::1 only,
    // which `tailscale serve` (proxying to 127.0.0.1:5173) cannot reach.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // .ts.net: Tailscale on the phone; .app.github.dev: the Codespaces demo
    allowedHosts: ['.ts.net', '.app.github.dev'],
    proxy: {
      '/wearable': {
        target: 'http://127.0.0.1:8001',
        rewrite: (path) => path.replace(/^\/wearable/, ''),
      },
      '/api': {
        target: 'http://127.0.0.1:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
