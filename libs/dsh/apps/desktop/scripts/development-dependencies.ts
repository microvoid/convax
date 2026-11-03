/** Locate pnpm's shared dependency directory for source Desktop launches and qualifications. */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Resolve installed development dependencies at the nearest enclosing pnpm workspace.
 * @param start - Directory inside the source checkout.
 * @returns The workspace's existing hoisted pnpm dependency directory.
 * @throws When no workspace exists above start or its dependencies have not been installed.
 */
export function developmentDependencyDirectory(start: string = import.meta.dirname): string {
  let directory = resolve(start)
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Desktop development: no pnpm workspace above ${start}`)
    directory = parent
  }
  const dependencies = join(directory, 'node_modules/.pnpm/node_modules')
  if (!existsSync(dependencies)) throw new Error(`Desktop development: run pnpm install in ${directory}`)
  return dependencies
}
