/** Desktop file paths consumed by Convax drops and pickers without copying sources. */
interface DesktopPathBridge {
  pathFor(file: File): string
}

/**
 * Resolve the existing Desktop preload capability for an original browser file.
 * @param file - File received directly from a native drop or chooser.
 * @returns Absolute Host path, undefined outside Desktop, or empty for a virtual file.
 * @throws When the native bridge cannot resolve the file; the caller reports that failure.
 */
export function hostPathForFile(file: File): string | undefined {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: DesktopPathBridge }).__DSH_HOST_PATHS__
  return bridge?.pathFor(file)
}
