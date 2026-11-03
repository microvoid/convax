/** Run the retained DSH scripts from their source root, inheriting the outer environment. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../libs/dsh/', import.meta.url))
const [task, ...args] = process.argv.slice(2)
if (!task || !process.env.npm_execpath) throw new Error('Use pnpm run to select a DSH task')
const child = spawn(process.execPath, [process.env.npm_execpath, '--dir', root,
  ...(task === 'exec' ? ['exec'] : ['run', task]), ...args], { env: process.env, stdio: 'inherit' })
const interrupt = () => { child.kill('SIGINT') }
const terminate = () => { child.kill('SIGTERM') }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', (code, signal) => {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
})
