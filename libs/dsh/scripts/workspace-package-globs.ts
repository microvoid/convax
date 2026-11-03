/** Convert discovered package manifests into portable bundler workspace patterns. */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

/**
 * Read source package globs supplied by an enclosing workspace.
 * @param root - DSH source root whose package.json owns the optional declaration.
 * @returns Extra package directory globs, relative to root.
 * @throws When the declaration is not an array of nonempty directory globs.
 */
export function additionalWorkspacePackageGlobs(root: string): string[] {
  const manifestPath = resolve(root, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dshWorkspacePackages?: unknown }
  const patterns = manifest.dshWorkspacePackages
  if (patterns === undefined) return []
  if (!Array.isArray(patterns) || !patterns.every((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')) {
    throw new Error(`${manifestPath}: dshWorkspacePackages must be an array of nonempty package directory globs`)
  }
  return patterns.map(pattern => pattern.replaceAll('\\', '/').replace(/\/$/, ''))
}

/**
 * Discover manifests for source packages supplied by an enclosing workspace.
 * @param root - DSH source root owning the additional package declaration.
 * @returns Stable, root-relative paths of matching package manifests.
 */
export function additionalWorkspacePackageManifests(root: string): string[] {
  const patterns = additionalWorkspacePackageGlobs(root).map(pattern => `${pattern}/package.json`)
  return [...new Set(globSync(patterns, { cwd: root }).map(path => path.replaceAll('\\', '/')))].sort()
}

/**
 * Discover the source packages included in DSH's Host and Client bundles.
 * @param root - DSH source root containing its standard package directories.
 * @returns Standard and declared additional package manifests in stable path order.
 */
export function workspacePackageManifests(root: string): string[] {
  const standard = globSync(['vendor/*/package.json', 'packages/*/*/package.json'], { cwd: root })
  return [...new Set([...standard, ...additionalWorkspacePackageManifests(root)]
    .map(path => path.replaceAll('\\', '/')))].sort()
}

/**
 * Keep filesystem separators from becoming escapes in workspace globs.
 * @param manifests - Repository-relative manifest paths returned by filesystem discovery.
 * @returns Package directory patterns using forward slashes on every host.
 */
export function workspacePackageGlobs(manifests: readonly string[]): string[] {
  return manifests.map(path => posix.dirname(path.replaceAll('\\', '/')))
}
