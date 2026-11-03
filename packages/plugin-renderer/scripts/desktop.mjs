/** Launch the existing Desktop development command with Convax-owned data paths. */
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Resolve a source-checkout launch without changing the native DSH defaults.
 * @param repositoryRoot - Absolute source checkout root.
 * @param inherited - Environment inherited by the existing Desktop command.
 * @param build - Whether to build artifacts before launch.
 * @returns Existing package-manager invocation and its explicit Convax data paths.
 */
export function resolveDesktopLaunch(repositoryRoot, inherited, build) {
  const packageManager = inherited.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('Convax Desktop: invoke through pnpm run desktop or desktop:dev in the renderer workspace')
  }
  const root = resolve(repositoryRoot)
  const cwd = join(root, 'libs', 'dsh')
  const home = join(root, '.convax')
  return {
    command: process.execPath,
    args: [packageManager, 'run', build ? 'dev:desktop' : 'start:desktop'],
    cwd,
    env: { ...inherited, DSH_HOME: home, DSH_DESKTOP_USER_DATA_DIR: join(home, 'electron-user-data') },
  }
}

/**
 * Run the supported Desktop launcher and retain its process until it has exited.
 * @param request - Resolved invocation from resolveDesktopLaunch.
 * @returns Child exit code, or a conventional nonzero result for signal termination.
 */
export function launchDesktop(request) {
  return new Promise((accept, reject) => {
    const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: 'inherit' })
    const interrupt = () => { child.kill('SIGINT') }
    const terminate = () => { child.kill('SIGTERM') }
    const cleanup = () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', (code, signal) => { cleanup(); accept(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)) })
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { build: { type: 'boolean', default: false } } })
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
  process.exitCode = await launchDesktop(resolveDesktopLaunch(repositoryRoot, process.env, values.build))
}
