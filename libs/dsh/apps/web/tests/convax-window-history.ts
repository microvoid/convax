/** Owner-local projection of real window-reference admission, queue identity, and persisted image history. */
import type {} from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function sourceText(text: string, images: readonly ImageAttachmentRef[], sourceName: string): string {
  const source = images.find(image => image.name === `${sourceName}.png`)
  if (source === undefined) return text
  const separator = text.lastIndexOf('\n\n')
  const offset = separator === -1 ? 0 : separator + 2
  const lines = text.slice(offset).split('\n')
  if (lines.length !== 3 || lines[0] !== `Application window: ${sourceName}`
    || !/^Captured at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(lines[1] ?? '')
    || lines[2] !== `Image: ${source.width} × ${source.height}`) return text
  return `${text.slice(0, offset)}${lines[0]}\nCaptured at: <CAPTURE_TIME>\n${lines[2]}`
}

/**
 * Pin admitted user content and the exact image identity shared by queue and history.
 * Only the final source-metadata paragraph accompanying this fixture's named image has its timestamp replaced.
 * @param events - events read from the production Session persistence owner.
 * @param sourceName - exact fixture window name, excluding the generated `.png` suffix.
 * @returns formatted JSON with relationship-preserving image/message indices and all other user text unchanged.
 */
export function projectWindowMirrorHistory(events: readonly SessionEvent[], sourceName: string): string {
  const images = new Map<ImageAttachmentRef['attachmentId'], {
    id: string
    name?: string
    mediaType: string
    width: number
    height: number
  }>()
  const messageIds = new Map<UserMessage['id'], string>()
  const queuedImages: { message: string; images: string[] }[] = []
  const messages: { id: string; content: unknown[] }[] = []
  const messageId = (id: UserMessage['id']): string => {
    let value = messageIds.get(id)
    if (value === undefined) { value = `message:${messageIds.size + 1}`; messageIds.set(id, value) }
    return value
  }
  const imageId = (image: ImageAttachmentRef): string => {
    let value = images.get(image.attachmentId)
    if (value === undefined) {
      value = { id: `image:${images.size + 1}`, ...(image.name === undefined ? {} : { name: image.name }),
        mediaType: image.mediaType, width: image.width, height: image.height }
      images.set(image.attachmentId, value)
    }
    return value.id
  }
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') {
      for (const message of event.data.inserted) {
        if (message.source.kind !== 'user') continue
        const id = messageId(message.id)
        const refs = message.content.flatMap(block => block.type === 'image' ? [imageId(block.attachment)] : [])
        if (refs.length > 0) queuedImages.push({ message: id, images: refs })
      }
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const message = event.data
    const attachments = message.content.flatMap(block => block.type === 'image' ? [block.attachment] : [])
    messages.push({ id: messageId(message.id), content: message.content.map((block) => {
      if (block.type === 'image') return { type: 'image', image: imageId(block.attachment) }
      if (block.type === 'text') return { ...block, text: sourceText(block.text, attachments, sourceName) }
      return block
    }) })
  }
  return JSON.stringify({ images: [...images.values()], queuedImages, messages }, null, 2)
}
