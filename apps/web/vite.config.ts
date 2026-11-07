/** Static homepage; media imports reuse the repository's published demo assets. */
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/convax/',
  server: { port: 4321, strictPort: true },
  build: { target: 'es2022', outDir: 'dist/convax' },
})
