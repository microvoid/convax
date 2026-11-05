/** Locate pnpm's shared dependency directory for source Desktop launches and qualifications. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pnpmWorkspaceRoot } from '../../../scripts/pnpm-invocation.ts'

/**
 * Resolve installed development dependencies at the nearest enclosing pnpm workspace.
 * @param start - Directory inside the source checkout.
 * @returns The workspace's existing hoisted pnpm dependency directory.
 * @throws When no workspace exists above start or its dependencies have not been installed.
 */
export function developmentDependencyDirectory(start: string = import.meta.dirname): string {
  const directory = pnpmWorkspaceRoot(start)
  const dependencies = join(directory, 'node_modules/.pnpm/node_modules')
  if (!existsSync(dependencies)) throw new Error(`Desktop development: run pnpm install in ${directory}`)
  return dependencies
}
