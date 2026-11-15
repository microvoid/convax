/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'
import { additionalWorkspacePackageManifests } from '../../../scripts/workspace-package-globs.ts'
import { isConvaxDesktopProduct } from './desktop-product.mjs'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.out === undefined) throw new Error('desktop local pack: --out must name the package staging directory')
  const concurrency = parsePackConcurrency(values.concurrency)
  const root = process.cwd()
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')
  readClientBuildRecord(root, environment)
  const destination = resolve(root, values.out)
  const packed = await packFamilyMembers(root, releaseFamily('dsh'), destination, concurrency)
  const externalManifests = isConvaxDesktopProduct(process.env) ? additionalWorkspacePackageManifests(root) : []
  for (const manifest of externalManifests) {
    const directory = dirname(resolve(root, manifest))
    const invocation = pnpmInvocation(['--dir', directory, 'pack', '--pack-destination', destination])
    await runConcurrent(invocation.command, invocation.args)
  }
  console.log(`desktop local pack: ${String(packed.length + externalManifests.length)} tarball(s) in ${destination}`)
}

await main()
