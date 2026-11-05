/** Resolve shell-free child-process invocations for the pnpm process that launched a package script. */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Find the pnpm workspace that owns an installed source directory.
 * @param start - Directory within the workspace.
 * @returns The nearest ancestor containing pnpm-workspace.yaml.
 */
export function pnpmWorkspaceRoot(start: string): string {
  let directory = resolve(start)
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no pnpm workspace above ${start}`)
    directory = parent
  }
  return directory
}

/**
 * Resolve pnpm's executable and arguments from its lifecycle environment.
 * @param args - Arguments to pass to pnpm.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  return { command: entrypoint, args: [...args] }
}
