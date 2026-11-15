/** Shared filesystem admission for tool and background file declarations. */
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import type { PresentedFile } from './types.ts'

/**
 * Resolve regular files through the caller's filesystem, refusing final symlinks.
 * @param fs - Filesystem carrying the caller's access policy.
 * @param input - Requested file paths and descriptions.
 * @param options - Session directory and cancellation before publication.
 * @returns Absolute provider process paths without reading file contents.
 */
export async function validatePresentedFiles(
  fs: FileSystem, input: readonly PresentedFile[], options: { cwd?: string; signal: AbortSignal },
): Promise<PresentedFile[]> {
  const files: PresentedFile[] = []
  for (const file of input) {
    if (file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
    const entry = await fs.lstat(file.path, options.cwd === undefined ? {} : { cwd: options.cwd }, options.signal)
    if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
    const target = await fs.resolve(file.path, options)
    const info = await fs.stat(target, options.signal)
    if (info === undefined) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
    files.push({ ...file, path: fs.processPath(target) })
  }
  options.signal.throwIfAborted()
  return files
}
