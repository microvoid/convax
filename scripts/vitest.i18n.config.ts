/** Convax script tests stay outside the retained DSH composite project and test discovery roots. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: { include: ['scripts/check-i18n.spec.ts'] },
})
