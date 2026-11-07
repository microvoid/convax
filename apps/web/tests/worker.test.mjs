/** Real workerd asset/cache integration, including byte ranges and browser seeking. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { unstable_dev } from 'wrangler'

const root = fileURLToPath(new URL('../', import.meta.url))
const assets = join(root, 'dist/convax/assets')
const artifacts = fileURLToPath(new URL('../../../.artifacts/public-site/', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
let worker
let videos

before(async () => {
  const files = await readdir(assets)
  videos = await Promise.all(files.filter(name => name.endsWith('.mp4')).sort().map(async name => ({
    name, url: `/convax/assets/${name}`, bytes: await readFile(join(assets, name)),
  })))
  assert.equal(videos.length, 4, 'Build all four published walkthroughs before testing the Worker')
  worker = await unstable_dev(join(root, 'worker.mjs'), {
    config: join(root, 'wrangler.jsonc'), port: 0, inspectorPort: 0, envFiles: [], local: true, persist: false,
    logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  })
  assert.ok(worker.port > 0, 'workerd must bind an OS-assigned local port')
}, { timeout: 60_000 })

after(async () => {
  if (!worker) return
  const exited = worker.waitUntilExit()
  await worker.stop()
  await exited
})

async function assertRange(video, header, first, last) {
  const response = await worker.fetch(video.url, { headers: { Range: header } })
  assert.equal(response.status, 206, `${video.name}: ${header} must return partial content`)
  assert.equal(response.headers.get('Content-Range'), `bytes ${first}-${last}/${video.bytes.length}`)
  assert.equal(Number(response.headers.get('Content-Length')), last - first + 1)
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes')
  assert.match(response.headers.get('Content-Type'), /^video\/mp4(?:;|$)/u)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.bytes.subarray(first, last + 1))
}

test('cold and hot MP4 requests return exact nonzero byte ranges through the real cache', { timeout: 60_000 }, async () => {
  for (const video of videos) {
    await assertRange(video, 'bytes=4096-8191', 4096, 8191)
    await assertRange(video, 'bytes=11111-11622', 11111, 11622)
  }
})

test('full MP4 responses preserve the complete built asset and content length', { timeout: 60_000 }, async () => {
  for (const video of videos) {
    const response = await worker.fetch(video.url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Range'), null)
    assert.equal(Number(response.headers.get('Content-Length')), video.bytes.length)
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(video.bytes))
  }
})

test('suffix ranges return the final bytes of each original MP4', { timeout: 60_000 }, async () => {
  for (const video of videos) await assertRange(video, 'bytes=-1024', video.bytes.length - 1024, video.bytes.length - 1)
})

test('missing MP4 assets remain missing instead of returning the homepage or a cached success', { timeout: 60_000 }, async () => {
  const response = await worker.fetch('/convax/assets/missing.mp4', { headers: { Range: 'bytes=0-31' } })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('Content-Range'), null)
  await response.arrayBuffer()
})

test('index, JavaScript, CSS and favicon remain ordinary unmodified static assets', { timeout: 60_000 }, async () => {
  const files = await readdir(assets)
  const cases = [
    { url: '/convax/', path: join(root, 'dist/convax/index.html'), type: /text\/html/u },
    ...[
      ['.js', /javascript/u], ['.css', /text\/css/u], ['.svg', /image\/svg\+xml/u],
    ].map(([suffix, type]) => {
      const name = files.find(file => file.endsWith(suffix))
      assert.ok(name, `The build must contain a ${suffix} asset`)
      return { url: `/convax/assets/${name}`, path: join(assets, name), type }
    }),
  ]
  for (const asset of cases) {
    const response = await worker.fetch(asset.url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Range'), null)
    assert.match(response.headers.get('Content-Type'), asset.type)
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(asset.path)))
  }
})

test('Chrome can decode and seek both Worker-served walkthroughs to eighteen seconds', { timeout: 60_000 }, async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync(chrome) ? chrome : undefined)
  const browser = await chromium.launch({ executablePath })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://${worker.address}:${worker.port}/convax/?lang=en`)
    await mkdir(artifacts, { recursive: true })
    for (const kind of ['projects', 'apps']) {
      const video = page.locator(`video[data-demo="${kind}"]`)
      await page.locator('figure').filter({ has: video }).getByRole('button', { name: /^Play demo:/u }).click()
      await page.waitForFunction(kind => {
        const video = document.querySelector(`video[data-demo="${kind}"]`)
        return video && video.readyState >= 2 && !video.paused && video.currentTime > 0
      }, kind)
      await video.evaluate((element) => { element.pause(); element.currentTime = 18 })
      await page.waitForFunction(kind => {
        const video = document.querySelector(`video[data-demo="${kind}"]`)
        return video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 18) < 0.1
      }, kind)
      assert.equal(await video.evaluate(element => element.error?.code ?? null), null)
      await video.screenshot({ path: join(artifacts, `worker-seek-${kind}.png`) })
      await video.evaluate(element => element.play())
      await page.waitForFunction(kind => document.querySelector(`video[data-demo="${kind}"]`).currentTime > 18.1, kind)
      await video.evaluate(element => element.pause())
    }
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
