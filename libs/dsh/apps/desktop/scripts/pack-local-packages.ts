/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { pnpmInvocation, pnpmWorkspaceRoot } from '../../../scripts/pnpm-invocation.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'
import { isConvaxDesktopProduct } from './desktop-product.mjs'

const CONVAX_PACKAGES = ['plugin-host', 'plugin-renderer', 'plugin-inernal-nodes-host', 'plugin-inernal-nodes-renderer']

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
  let packageCount = packed.length
  if (isConvaxDesktopProduct(process.env)) {
    const workspaceRoot = pnpmWorkspaceRoot(root)
    for (const plugin of CONVAX_PACKAGES) {
      const directory = resolve(workspaceRoot, 'packages', plugin)
      const invocation = pnpmInvocation(['--dir', directory, 'pack', '--pack-destination', destination])
      await runConcurrent(invocation.command, invocation.args)
    }
    packageCount += CONVAX_PACKAGES.length
  }
  console.log(`desktop local pack: ${String(packageCount)} tarball(s) in ${destination}`)
}

await main()
