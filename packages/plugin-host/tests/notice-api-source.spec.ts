import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ClientNoticeApiSource, type ClientNoticeApiOptions } from '../src/notices/api-source.ts'

const options: ClientNoticeApiOptions = {
  origin: 'https://api.example.test', appVersion: '0.2.1-rc.3', platform: 'darwin', arch: 'arm64',
  channel: 'latest', locale: 'zh-CN', installationId: '00000000-0000-4000-8000-000000000001',
  allowedPageOrigins: ['https://example.test'], timeoutMs: 5000,
}
const common = { schemaVersion: 1, revision: '1', serverTime: '2026-11-08T08:00:00Z', nextCheckAfterSeconds: 600 }
const policy = () => ({ ...common, update: { required: false }, maintenance: [] })
const item = () => ({
  id: 'feature-intro', revision: '2', kind: 'feature', surface: 'modal',
  startsAt: '2026-11-08T00:00:00Z', expiresAt: '2026-12-08T00:00:00Z', requiresCapabilities: [],
  frequency: { scope: 'installation', maxImpressions: 1, cooldownSeconds: 86400 },
  content: { title: 'New feature', body: 'Try the feature.' }, actions: [{ id: 'dismiss', label: 'Dismiss', type: 'dismiss' }],
})
const guidance = () => ({ ...common, items: [item()] })

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
}

function fixture(respond: (kind: string) => Response | Promise<Response> = kind => Response.json(kind === 'policy' ? policy() : guidance())) {
  const request = vi.fn<typeof fetch>(async input => respond(requestUrl(input).pathname.split('/').at(-1)!))
  const source = new ClientNoticeApiSource(options, request)
  onTestFinished(() => { source.dispose() })
  return { source, request }
}

describe('Convax client notice HTTP source', () => {
  it('reads independent endpoints with installed identity and without credentials or redirect following', async () => {
    const { source, request } = fixture()
    expect(await source.read()).toEqual({ policy: policy(), guidance: guidance() })
    expect(request).toHaveBeenCalledTimes(2)
    for (const [input, init] of request.mock.calls) {
      const url = requestUrl(input)
      expect(url.origin).toBe(options.origin)
      expect(url.pathname).toMatch(/^\/api\/v1\/client\/(policy|guidance)$/u)
      expect(Object.fromEntries(url.searchParams)).toEqual({ appVersion: options.appVersion,
        platform: 'darwin', arch: 'arm64', channel: 'latest', locale: 'zh-CN' })
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'X-Installation-Id': options.installationId } })
    }
  })

  it('returns only the successful endpoint, never a default clear policy after transport failure', async () => {
    const { source } = fixture(kind => kind === 'policy'
      ? Response.json({ error: { code: 'service_unavailable', message: 'Unavailable' } }, { status: 503 }) : Response.json(guidance()))
    expect(await source.read()).toEqual({ guidance: guidance(), errors: ['policy'] })
  })

  it.each([
    { kind: 'unknown' }, { surface: 'coachmark' },
    { actions: [{ id: 'execute', label: 'Execute', type: 'run_command' }] },
    { blocking: true }, { expiresAt: '2026-11-07T00:00:00Z' },
    { kind: 'upgrade' },
    { releaseId: 'release-1', actions: [{ id: 'update', label: 'Update', type: 'open_update', releaseId: 'release-2' }] },
  ])('rejects unsupported or inconsistent guidance: %j', async (change) => {
    const { source } = fixture(kind => Response.json(kind === 'policy' ? policy() : { ...guidance(), items: [{ ...item(), ...change }] }))
    expect(await source.read()).toEqual({ policy: policy(), errors: ['guidance'] })
  })

  it('rejects incomplete required-update policies and unknown schema versions', async () => {
    const { source } = fixture(kind => Response.json(kind === 'policy' ? { ...policy(), update: { required: true } }
      : { ...guidance(), schemaVersion: 2 }))
    expect(await source.read()).toEqual({ errors: ['policy', 'guidance'] })
  })

  it.each(['http://example.test/download', 'https://other.test/download', 'https://user@example.test/download', 'javascript:alert(1)'])(
    'rejects untrusted page navigation: %s', async (url) => {
      const { source } = fixture(kind => Response.json(kind === 'policy' ? { ...policy(), update: { required: false, fallbackPage: url } }
        : { ...guidance(), items: [{ ...item(), actions: [{ id: 'more', label: 'More', type: 'open_url', url }] }] }))
      expect(await source.read()).toEqual({ errors: ['policy', 'guidance'] })
    })

  it('accepts allowlisted HTTPS pages and complete release references', async () => {
    const forced = { ...policy(), update: { required: true, minSupportedVersion: '0.2.0', targetVersion: '0.2.1',
      releaseId: 'release-1', reasonCode: 'support_ended', fallbackPage: 'https://example.test/download' } }
    const { source } = fixture(kind => Response.json(kind === 'policy' ? forced : { ...guidance(), items: [{ ...item(),
      kind: 'upgrade', releaseId: 'release-1', actions: [{ id: 'update', label: 'Update', type: 'open_update', releaseId: 'release-1' }] }] }))
    const result = await source.read()
    expect(result.policy).toEqual(forced)
    expect(result.guidance?.items[0]?.kind).toBe('upgrade')
    expect(result.errors).toBeUndefined()
  })

  it('owns timeout cancellation for both reads and releases all timers', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    }))
    const source = new ClientNoticeApiSource(options, request)
    onTestFinished(() => { source.dispose() })
    const reading = source.read()
    await vi.advanceTimersByTimeAsync(options.timeoutMs)
    expect(await reading).toEqual({ errors: ['policy', 'guidance'] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['signal', 'dispose'])('cancels in-flight reads through %s without returning partial success', async (mode) => {
    const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    }))
    const source = new ClientNoticeApiSource(options, request)
    onTestFinished(() => { source.dispose() })
    const controller = new AbortController()
    const reading = source.read(controller.signal)
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    if (mode === 'signal') controller.abort()
    else source.dispose()
    await rejected
    expect(request.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    if (mode === 'dispose') await expect(source.read()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('clears deadlines on disposal and rejects late transport success', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const settle: (() => void)[] = []
    const request = vi.fn<typeof fetch>(input => new Promise((resolve) => {
      const kind = requestUrl(input).pathname.split('/').at(-1)
      settle.push(() => { resolve(Response.json(kind === 'policy' ? policy() : guidance())) })
    }))
    const source = new ClientNoticeApiSource(options, request)
    onTestFinished(() => { source.dispose() })
    const reading = source.read()
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(2)
    source.dispose()
    expect(vi.getTimerCount()).toBe(0)
    for (const release of settle) release()
    await rejected
  })

  it.each(['https://microvoid.io/convax/api', 'https://microvoid.io/convax/api/'])(
    'keeps the deployed API base path in both endpoint reads: %s', async (origin) => {
      const request = vi.fn<typeof fetch>(async input => Response.json(requestUrl(input).pathname.endsWith('/policy') ? policy() : guidance()))
      const source = new ClientNoticeApiSource({ ...options, origin }, request)
      onTestFinished(() => { source.dispose() })
      expect(await source.read()).toEqual({ policy: policy(), guidance: guidance() })
      expect(request.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
        '/convax/api/v1/client/policy', '/convax/api/v1/client/guidance',
      ])
      for (const [input] of request.mock.calls) {
        expect(requestUrl(input).origin).toBe('https://microvoid.io')
        expect(requestUrl(input).searchParams.get('appVersion')).toBe(options.appVersion)
      }
    })

  it('requires a trusted API base without credentials, query or fragment while permitting explicit loopback development', () => {
    for (const origin of ['http://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test?token=x', 'https://api.example.test/api#policy']) {
      expect(() => new ClientNoticeApiSource({ ...options, origin })).toThrow()
    }
    const source = new ClientNoticeApiSource({ ...options, origin: 'http://127.0.0.1:8104' })
    source.dispose()
  })

  it('keeps the navigation allowlist restricted to exact HTTPS origins', () => {
    expect(() => new ClientNoticeApiSource({ ...options, allowedPageOrigins: ['https://example.test/path'] })).toThrow()
  })
})
