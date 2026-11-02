/** Window history projection preserves attachment relationships and ordinary timestamp text. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { expect, it } from 'vitest'
import { projectWindowMirrorHistory } from './convax-window-history.ts'

const image: ImageAttachmentRef = {
  attachmentId: 'opaque-window-image' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png', width: 64, height: 48, bytes: 96, name: 'Mirror fixture.png',
}

it('keeps queued and admitted image ids identical and replaces only exact window source metadata', () => {
  const capturedAt = '2026-11-02T12:34:56.789Z'
  const ordinary = `Keep user timestamp ${capturedAt}\n\nApplication window: Mirror fixture\nCaptured at: ${capturedAt}\nImage: 64 × 48`
  const message = createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'image', attachment: image },
    { type: 'text', text: `${ordinary}\n\nApplication window: Mirror fixture\nCaptured at: ${capturedAt}\nImage: 64 × 48` },
  ] })
  const events: SessionEvent[] = [
    { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1, data: { target: 'next-turn', start: 0, inserted: [message] } },
    { type: 'user/message', seq: SessionSeq(2), time: 2, data: message, surfaceOp: 'append' },
  ]
  const projected = projectWindowMirrorHistory(events, 'Mirror fixture')
  expect(projected).toContain('"message": "message:1"')
  expect(projected.match(/image:1/gu)).toHaveLength(3)
  expect(projected).toContain(`Keep user timestamp ${capturedAt}`)
  expect(projected).toContain('Captured at: <CAPTURE_TIME>')
  expect(projected.match(/<CAPTURE_TIME>/gu)).toHaveLength(1)
  expect(projected).toContain(`Captured at: ${capturedAt}`)
  expect(projected).not.toContain('opaque-window-image')
  expect(projectWindowMirrorHistory(events, 'Another window')).not.toContain('<CAPTURE_TIME>')
})

it('exposes a changed image identity between queueing and historical admission', () => {
  const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] })
  const admitted = { ...queued, content: [{ type: 'image' as const, attachment: {
    ...image, attachmentId: 'different-image' as ImageAttachmentRef['attachmentId'],
  } }] }
  const events: SessionEvent[] = [
    { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1, data: { target: 'next-turn', start: 0, inserted: [queued] } },
    { type: 'user/message', seq: SessionSeq(2), time: 2, data: admitted, surfaceOp: 'append' },
  ]
  const projected = projectWindowMirrorHistory(events, 'Mirror fixture')
  expect(projected).toContain('"image": "image:2"')
  expect(projected).toContain('"message": "message:1"')
})
