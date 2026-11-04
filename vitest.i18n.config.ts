/** Browser checks owned by Convax, using the retained DSH Web composition without editing it. */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './libs/dsh/vitest.shared.ts'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    tsconfigPaths({ projects: [fileURLToPath(new URL('./tsconfig.test.json', import.meta.url))] }),
    standardDecoratorPlugin(),
  ],
  test: {
    execArgv: vitestExecArgv,
    include: ['tests/**/*.browser.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
