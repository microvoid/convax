/** Windows manifest paths still select the packages whose artifacts Desktop bundles. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { build } from 'tsdown'
import { expect, it, onTestFinished } from 'vitest'
import { additionalWorkspacePackageGlobs, additionalWorkspacePackageManifests, workspacePackageGlobs, workspacePackageManifests } from './workspace-package-globs.ts'
import { scanSlotFiles } from './slot-walk.ts'

it('selects workspace packages from Windows and POSIX manifest paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-globs-'))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const manifests = ['packages\\util\\atomic-write\\package.json', 'vendor/cordis/package.json']
  for (const [index, directory] of ['packages/util/atomic-write', 'vendor/cordis'].entries()) {
    await mkdir(join(cwd, directory, 'src'), { recursive: true })
    await writeFile(join(cwd, directory, 'package.json'), JSON.stringify({ name: `fixture-${index}`, type: 'module' }))
    await writeFile(join(cwd, directory, 'src/index.ts'), `export const value = ${index}\n`)
  }
  const options = { cwd, config: false as const, entry: ['src/index.ts'], write: false, dts: false, logLevel: 'silent' as const }
  const selected = await build({ ...options, workspace: workspacePackageGlobs(manifests) })
  expect(selected).toHaveLength(2)
  const unnormalized = await build({ ...options, workspace: manifests.map(path => win32.dirname(path)) })
  expect(unnormalized.map(bundle => bundle.config.name)).toEqual(['fixture-1'])
})

it('includes explicitly declared enclosing-workspace packages in bundles and attributes their client slots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enclosing-workspace-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'libs', 'dsh')
  const external = join(directory, 'packages', 'extra')
  await mkdir(root, { recursive: true })
  await mkdir(join(external, 'src'), { recursive: true })
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: '@fixture/extra' }))
  await writeFile(join(external, 'src/index.ts'), 'declare module "@deepseek-ai/dsh-client-ui-slots" { interface SlotMap { "fixture.extra": {} } }')
  expect(additionalWorkspacePackageGlobs(root)).toEqual([])
  expect(workspacePackageManifests(root)).toEqual([])
  await writeFile(join(root, 'package.json'), JSON.stringify({ dshWorkspacePackages: ['../../packages/*'] }))
  expect(additionalWorkspacePackageManifests(root)).toEqual(['../../packages/extra/package.json'])
  expect(workspacePackageGlobs(workspacePackageManifests(root))).toEqual(['../../packages/extra'])
  const files = scanSlotFiles(root, additionalWorkspacePackageGlobs(root).map(pattern => `${pattern}/src/**/*.ts`))
  expect(files.map(file => ({ rel: file.rel, package: file.package }))).toEqual([
    { rel: '../../packages/extra/src/index.ts', package: '@fixture/extra' },
  ])
  await writeFile(join(root, 'package.json'), JSON.stringify({ dshWorkspacePackages: [''] }))
  expect(() => additionalWorkspacePackageGlobs(root)).toThrow('nonempty package directory globs')
})
