/** Git index reads owned by the bilingual pairing gate. */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Run one Git subprocess and return its exact stdout bytes.
 *
 * @param root - Repository root used as Git's working directory.
 * @param args - Arguments following the `git` executable.
 * @param operation - Human-readable operation for failure diagnostics.
 * @returns Exact stdout bytes.
 * @throws Error when Git cannot start or exits unsuccessfully.
 */
function runGit(root: string, args: string[], operation: string): Buffer {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 1 << 26 })
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`${operation} failed with status ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}

/**
 * Locate the Git repository containing a documentation content root.
 * @param root - Existing documentation content root.
 * @returns Canonical absolute repository root reported by Git.
 * @throws When root is not inside a Git repository or Git cannot run.
 */
export function gitRepositoryRoot(root: string): string {
  return realpathSync(runGit(root, ['rev-parse', '--show-toplevel'], 'locating documentation Git repository').toString('utf8').trim())
}

/** Every stage-zero index path, relative to the supplied content root. */
export function gitIndexPaths(root: string): Set<string> {
  const repository = gitRepositoryRoot(root)
  const contentRoot = realpathSync(root)
  const paths = new Set<string>()
  const entries = runGit(repository, ['ls-files', '--stage', '--full-name', '-z'], 'listing Git index paths')
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const entry of entries) {
    const match = /^\d+ [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(entry)
    if (!match?.[1] || match[2] === undefined) throw new Error('git ls-files --stage returned a malformed entry')
    if (match[1] === '0') paths.add(relative(contentRoot, resolve(repository, match[2])).split(sep).join('/'))
  }
  return paths
}

/**
 * Read one path from the Git index without consulting working-tree bytes.
 *
 * @param root - Documentation content root inside a Git repository.
 * @param path - Path relative to that content root.
 * @returns The stage-zero blob bytes, or `undefined` when the path is absent.
 * @throws Error when the path leaves the repository, is unmerged, or has invalid index entries.
 */
export function readGitIndexBlob(root: string, path: string): Buffer | undefined {
  const repository = gitRepositoryRoot(root)
  const repositoryPath = relative(repository, resolve(realpathSync(root), path)).split(sep).join('/')
  if (repositoryPath === '..' || repositoryPath.startsWith('../') || isAbsolute(repositoryPath)) {
    throw new Error(`${path} is outside the documentation Git repository`)
  }
  const output = runGit(
    repository,
    ['ls-files', '--stage', '--full-name', '-z', '--', repositoryPath],
    `git ls-files --stage for ${path}`,
  ).toString('utf8')
  const entries = output.split('\0').filter(Boolean)
  if (entries.length === 0) return undefined
  if (entries.length !== 1) throw new Error(`${path} does not have exactly one resolved index entry`)
  const match = /^(?:\d+) ([0-9a-f]+) 0\t[\s\S]+$/.exec(entries[0] ?? '')
  if (!match?.[1]) throw new Error(`${path} remains unmerged or has an invalid index entry`)
  return runGit(repository, ['cat-file', 'blob', match[1]], `reading staged ${path}`)
}
