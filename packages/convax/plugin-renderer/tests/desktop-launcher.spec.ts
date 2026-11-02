/** The Convax wrapper forwards source launches to the existing Desktop command. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const launcher = fileURLToPath(new URL('../scripts/desktop.mjs', import.meta.url))
const repository = resolve(dirname(launcher), '../../../..')

interface Execution {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stderr: string
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'convax-desktop-launch-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const manager = join(directory, 'package manager.mjs')
  const capture = join(directory, 'capture.json')
  await writeFile(manager, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CONVAX_LAUNCH_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), home: process.env.DSH_HOME,
  userData: process.env.DSH_DESKTOP_USER_DATA_DIR, marker: process.env.CONVAX_LAUNCH_MARKER,
}));
process.exitCode = Number(process.env.CONVAX_LAUNCH_EXIT ?? 0);
`)
  return { directory, manager, capture }
}

function run(directory: string, manager: string | undefined, capture: string, args: string[], exit = 0): Promise<Execution> {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: join(directory, 'discarded-home'),
    DSH_DESKTOP_USER_DATA_DIR: join(directory, 'discarded-user-data'),
    CONVAX_LAUNCH_CAPTURE: capture, CONVAX_LAUNCH_MARKER: 'inherited-value', CONVAX_LAUNCH_EXIT: String(exit),
  }
  if (manager === undefined) delete env.npm_execpath
  else env.npm_execpath = manager
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 20_000)
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); accept({ code, signal, timedOut, stderr }) })
  })
}

it.each([
  { args: [], command: 'start:desktop' },
  { args: ['--build'], command: 'dev:desktop' },
])('passes explicit Convax paths before $command starts through the original package script', async ({ args, command }) => {
  const f = await fixture()
  const result = await run(f.directory, f.manager, f.capture, args)
  expect(result).toEqual({ code: 0, signal: null, timedOut: false, stderr: '' })
  const actual: unknown = JSON.parse(await readFile(f.capture, 'utf8'))
  expect(actual).toEqual({ args: ['run', command], cwd: repository,
    home: join(repository, '.convax'), userData: join(repository, '.convax', 'electron-user-data'),
    marker: 'inherited-value',
  })
})

it('returns the existing Desktop command failure', async () => {
  const f = await fixture()
  const result = await run(f.directory, f.manager, f.capture, [], 17)
  expect(result).toEqual({ code: 17, signal: null, timedOut: false, stderr: '' })
})

it('requires the package manager entry instead of starting an alternate application', async () => {
  const f = await fixture()
  const result = await run(f.directory, undefined, f.capture, [])
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('invoke through pnpm run desktop')
})
