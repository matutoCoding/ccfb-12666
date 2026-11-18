import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5199, host: '127.0.0.1', strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 }
})
