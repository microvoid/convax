/** Exercise first launch and restart from the Convax application copied out of the release DMG. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'

const startupTimeout = 60_000
const quitTimeout = 15_000

async function closeApplication(application) {
  const child = application.process()
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()
  try {
    const quit = await Promise.race([application.close().then(() => true), delay(quitTimeout, false, { ref: false })])
    assert(quit, 'Convax did not quit after closing the application')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  assert.equal(child.exitCode, 0, `Convax exited with ${child.signalCode ?? child.exitCode}`)
}

async function withApplication(executablePath, scratch, expectedVersion, inspect) {
  const home = join(scratch, 'home')
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(scratch, 'profile')}`],
    cwd: home,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: join(scratch, 'tmp'),
      DSH_HOME: join(scratch, 'dsh'),
      DSH_TELEMETRY_DISABLED: '1',
    },
    timeout: startupTimeout,
  })
  try {
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), expectedVersion,
      'The installed Convax version must match the release tag')
    const page = await application.firstWindow({ timeout: startupTimeout })
    page.setDefaultTimeout(startupTimeout)
    await page.locator('[data-convax-workspace]').waitFor()
    return await inspect(page)
  } finally {
    await closeApplication(application)
  }
}

async function canvasAndChat(page) {
  const canvas = page.locator('[data-canvas-tab][data-active="true"]')
  const chat = page.locator('[data-convax-graph] [data-convax-chat]')
  await chat.locator('[data-composer-input][contenteditable="true"]:visible').waitFor()
  const canvasId = await canvas.getAttribute('data-canvas-tab')
  const chatId = await chat.getAttribute('data-convax-chat')
  assert(canvasId, 'The workspace has no selected canvas')
  assert(chatId, 'The canvas has no Chat identity')
  return { canvasId, chatId }
}

const [installer, expectedVersion, ...extra] = process.argv.slice(2)
assert(process.platform === 'darwin' && process.arch === 'arm64', 'The Convax installer smoke requires an Apple Silicon Mac')
assert(installer && isAbsolute(installer) && expectedVersion && extra.length === 0,
  'Usage: node scripts/smoke-convax-macos-installer.mjs ABSOLUTE_DMG_PATH VERSION')

const scratch = await mkdtemp(join(tmpdir(), 'convax-installer-smoke-'))
const mount = join(scratch, 'mount')
const bundle = join(scratch, 'Convax.app')
let mounted = false
try {
  for (const path of [mount, join(scratch, 'home'), join(scratch, 'tmp')]) await mkdir(path)
  execFileSync('/usr/bin/hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'inherit' })
  mounted = true
  try {
    execFileSync('/usr/bin/ditto', [join(mount, 'Convax.app'), bundle], { stdio: 'inherit' })
  } finally {
    execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'inherit' })
    mounted = false
  }

  const executable = join(bundle, 'Contents', 'MacOS', 'Convax')
  const created = await withApplication(executable, scratch, expectedVersion, async page => {
    await page.getByRole('button', { name: /^(New canvas|新建画布)$/ }).first().click()
    await page.locator('[data-convax-graph]').getByRole('button', { name: /^(New chat|新建聊天)$/ }).click()
    return canvasAndChat(page)
  })
  const restored = await withApplication(executable, scratch, expectedVersion, canvasAndChat)
  assert.deepEqual(restored, created, 'Convax did not restore the same canvas and Chat after restarting')
  console.log('Convax installer opened the canvas workspace and restored the canvas and Chat after restart.')
} finally {
  // Preserve the mount point if detaching failed.
  if (!mounted) await rm(scratch, { recursive: true, force: true })
}
