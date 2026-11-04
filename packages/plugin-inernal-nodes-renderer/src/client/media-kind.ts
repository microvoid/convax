/** Media file recognition shared by resource intake and native playback. */
import { classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Select the native player from the file extension.
 * @param path - Native file name or path.
 * @returns The media player kind, or undefined for documents.
 */
export function mediaKind(path: string): 'audio' | 'video' | undefined {
  if (classifyFileType(path) === 'video') return 'video'
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (/^(?:mp3|m4a|aac|wav|ogg|oga|flac|aiff|aif|opus|wma)$/u.test(extension ?? '')) return 'audio'
  return undefined
}
