import { access, mkdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication } from 'playwright'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import { developmentRuntimeDirectory } from '../../libs/dsh/apps/desktop/scripts/desktop-build-paths.mjs'
import { launchWebScaffold } from '../../libs/dsh/apps/web/tests/scaffold.ts'
import { graphSchema } from '../../packages/plugin-host/src/schema.ts'
import { seedComplexCanvas } from './complex-canvas.ts'

const DESKTOP = fileURLToPath(new URL('../../libs/dsh/apps/desktop/', import.meta.url))
const RENDERER = fileURLToPath(new URL('../../packages/plugin-renderer/', import.meta.url))
const COUNTER = join(RENDERER, 'examples', 'counter')

/** Stage the same Host fixture in a disposable Electron profile and browser data directory. */
export async function stageDesktopRendererFixture(directory: string) {
  const developmentProject = join(DESKTOP, '.desktop-build', 'development', 'project')
  const primaryRuntime = developmentRuntimeDirectory()
  for (const path of [join(DESKTOP, 'lib', 'main.js'), join(developmentProject, 'desktop-runtime.json'), join(primaryRuntime, 'runtime.json')]) {
    await access(path).catch((error: unknown) => {
      throw new Error(`Desktop test requires the built development app and runtime at ${path}. Prepare it with the Desktop development launcher.`, { cause: error })
    })
  }

  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const databasePath = join(home, 'storages', 'convax-canvas.sqlite')
  const modules = join(profile, 'node_modules', '@local')
  const projects = join(directory, 'projects')
  await Promise.all([mkdir(modules, { recursive: true }), mkdir(join(home, 'storages'), { recursive: true })])
  await Promise.all([
    symlink(COUNTER, join(modules, 'dsh-convax-counter-example'), 'junction'),
    writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'convax-desktop-test', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-convax-plugin-renderer'] } },
    })),
    writeFile(join(profile, 'cordis.patch.yml'), `- id: hmr
  disabled: true
- id: locale
  config:
    preference: en
- id: convax-host
  config:
    databasePath: ${JSON.stringify(databasePath)}
    canvasDirectoryRoot: ${JSON.stringify(projects)}
- insert:
    - id: convax-counter-example
      name: '@local/dsh-convax-counter-example'
`),
  ])

  const scaffold = await launchWebScaffold({
    profile: { hmr: false },
    extraOverlayPath: [join(RENDERER, 'cordis.patch.yml'), join(COUNTER, 'cordis.patch.yml')],
    extraInstallAnchors: [join(RENDERER, 'package.json'), join(COUNTER, 'package.json')],
  })
  let fixture: Awaited<ReturnType<typeof seedComplexCanvas>>
  try {
    fixture = await seedComplexCanvas(scaffold.ctx.convax, projects)
    const source = new DatabaseSync(join(scaffold.harnessHome, 'storages', 'convax-canvas.sqlite'), { readOnly: true })
    try { await backup(source, databasePath) } finally { source.close() }
  } finally { await scaffold.close() }

  const require = createRequire(join(DESKTOP, 'package.json'))
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new Error('The installed Electron package did not resolve an executable')
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_DIR: developmentProject, DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: primaryRuntime, DSH_DESKTOP_DIAGNOSTIC_FILE: join(directory, 'desktop-diagnostic.log'),
    DEEPSEEK_API_KEY: '' }
  delete env.ELECTRON_RUN_AS_NODE

  return { fixture, readCanvas: () => readDesktopCanvas(databasePath, fixture.id), launch: async (): Promise<ElectronApplication> =>
    await _electron.launch({ executablePath: electron, args: [`--user-data-dir=${join(directory, 'electron')}`, DESKTOP], env, timeout: 40_000 }) }
}

/** Inspect the durable document independently of the running Desktop Host. */
function readDesktopCanvas(path: string, id: CanvasId) {
  const reader = new DatabaseSync(path, { readOnly: true })
  try {
    const value = reader.prepare("SELECT value FROM unit_globals WHERE unit='convax'").get()?.['value']
    if (typeof value !== 'string') throw new Error('Desktop test database has no Convax graph')
    const graph = graphSchema.parse(JSON.parse(value))
    const document = graph.canvases.find(item => item.id === id)
    if (document === undefined) throw new Error(`Desktop test canvas ${id} is missing`)
    return document
  } finally { reader.close() }
}
