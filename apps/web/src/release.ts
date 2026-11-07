/** Public installer metadata; the homepage never contacts a model or local Host. */
export interface ReadyRelease {
  status: 'ready'
  version: string
  downloadUrl: string
  releaseUrl: string
  size: number
}

/** Release availability also covers a first release that has not been published. */
export type ReleaseState = ReadyRelease | { status: 'loading' | 'pending' | 'unavailable' }

function repositoryUrl(value: string, path: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash
      && decodeURIComponent(url.pathname) === `/microvoid/convax/releases/${path}`
  } catch {
    return false
  }
}

/** Read the latest public macOS installer without inventing a download URL. */
export async function loadRelease(signal: AbortSignal): Promise<ReleaseState> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/release`, { signal })
  if (!response.ok) return { status: 'unavailable' }
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || !('status' in value)) return { status: 'unavailable' }
  if (value.status === 'pending') return { status: 'pending' }
  if (value.status !== 'ready' || !('version' in value) || typeof value.version !== 'string'
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value.version)
    || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0
    || !('downloadUrl' in value) || typeof value.downloadUrl !== 'string'
    || !('releaseUrl' in value) || typeof value.releaseUrl !== 'string') return { status: 'unavailable' }
  if (!repositoryUrl(value.downloadUrl, `download/v${value.version}/convax-${value.version}-mac-arm64.dmg`)
    || !repositoryUrl(value.releaseUrl, `tag/v${value.version}`)) {
    return { status: 'unavailable' }
  }
  return { status: 'ready', version: value.version, size: value.size, downloadUrl: value.downloadUrl, releaseUrl: value.releaseUrl }
}
