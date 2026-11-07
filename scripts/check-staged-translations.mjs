/** Translate Git-root hook paths for the retained DSH documentation checker. */
import { spawnSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const dshRoot = resolve(repositoryRoot, 'libs/dsh')
const paths = process.argv.slice(2).map(path => relative(dshRoot, resolve(repositoryRoot, path)).split(sep).join('/'))
const environment = { ...process.env, GIT_WORK_TREE: repositoryRoot }
// Git exports worktree-local paths to hooks; nested checker commands must retain their original base.
for (const name of ['GIT_DIR', 'GIT_INDEX_FILE']) {
  if (environment[name] !== undefined) environment[name] = resolve(environment[name])
}
const result = spawnSync(process.execPath, [
  '--import', 'tsx/esm', resolve(dshRoot, 'scripts/verify-translation-pairing.ts'), '--cached', ...paths,
], { cwd: repositoryRoot, stdio: 'inherit', env: environment })
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1)
