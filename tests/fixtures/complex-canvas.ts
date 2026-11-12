import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConvaxHost } from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasConnection, CanvasConnectionId, CanvasData, CanvasDocument, CanvasGroup, CanvasGroupId,
  CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'

type Host = Pick<ConvaxHost, 'execute' | 'workspace'>

export const COMPLEX_CANVAS_TITLE = 'Night Ferry · Storyboard and editorial review'

/** Read the document independently of the browser's local state. */
export function canvasDocument(host: Host, id: CanvasId): CanvasDocument {
  const document = host.workspace().canvases.find(item => item.id === id)
  if (document === undefined) throw new Error(`Comparison canvas ${id} is missing`)
  return document
}

async function execute(host: Host, canvasId: CanvasId, expectedRevision: number, command: CanvasCommand): Promise<void> {
  const result = await host.execute({ canvasId, expectedRevision, operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Comparison fixture ${command.kind}: ${result.code}: ${result.message}`)
}

function node(type: string, data: CanvasData, x: number, y: number, groupId?: CanvasGroupId): CanvasNode {
  return {
    id: randomUUID() as CanvasNodeId, typeId: type as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data, position: { x, y }, ...(groupId === undefined ? {} : { groupId }),
  }
}

function group(title: string, color: CanvasGroup['color']): CanvasGroup {
  return { id: randomUUID() as CanvasGroupId, title, ...(color === undefined ? {} : { color }) }
}

function connection(source: CanvasNode, target: CanvasNode, purpose: CanvasConnection['purpose'] = 'input'): CanvasConnection {
  return { id: randomUUID() as CanvasConnectionId, source: source.id, sourcePort: 'output',
    target: target.id, targetPort: 'input', purpose }
}

/** Seed a production-planning board through the same Host commands used by the app. */
export async function seedComplexCanvas(host: Host, workspaceCwd: string) {
  const id = randomUUID() as CanvasId
  const root = join(workspaceCwd, `night-ferry-${id}`)
  const sources = join(root, 'references')
  const scenes = join(root, 'scenes')
  await Promise.all([mkdir(sources, { recursive: true }), mkdir(scenes, { recursive: true })])
  const scriptPath = join(sources, 'night-ferry-outline.md')
  const reviewPath = join(root, 'review-log.md')
  const scriptText = 'The night ferry leaves before dawn.'
  await Promise.all([
    writeFile(scriptPath, `# Night Ferry\n\n${scriptText}\n\n## Act I\n\nLin finds a second ticket tucked behind the timetable.\n`),
    writeFile(join(sources, 'sound-notes.txt'), 'Collect the deck bell, wake noise, and the engine room hum.\n'),
    writeFile(reviewPath, '# Review log\n\nConfirm the opening shot and the closing bell.\n'),
  ])

  const research = group('Script and references', 'blue')
  const review = group('Editorial review', 'purple')
  const script = node('convax.file', { path: scriptPath }, 160, 190, research.id)
  const folder = node('convax.folder', { path: sources }, 160, 480, research.id)
  const chat = node('convax.chat', { title: 'Editorial review chat', cwd: root }, 700, 190, review.id)
  const output = node('convax.file', { path: reviewPath }, 1450, 190, review.id)
  const counter = node('example.convax.counter', { value: 12 }, 700, 720)
  const reviewInput = connection(folder, chat)
  const reviewDelivery = connection(chat, output, 'delivery')
  const groups = [research, review]
  const nodes = [script, folder, chat, output, counter]
  const connections = [reviewInput, reviewDelivery]
  const sections = [
    { title: 'Act I · Departure', color: 'green' },
    { title: 'Act II · Open water', color: 'yellow' },
    { title: 'Act III · Landfall', color: 'orange' },
    { title: 'Alternate edits', color: 'pink' },
  ] satisfies Array<{ title: string; color: CanvasGroup['color'] }>

  for (const [sectionIndex, section] of sections.entries()) {
    const chapter = group(section.title, section.color)
    groups.push(chapter)
    const cards = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const scene = sectionIndex * 16 + index + 1
      const path = join(scenes, `scene-${String(scene).padStart(2, '0')}.md`)
      await writeFile(path, `# Scene ${scene}\n\n${section.title}\n\nCamera, dialogue, and continuity notes for the night crossing.\n`)
      return node('convax.file', { path }, 160 + (index % 8) * 380,
        1060 + sectionIndex * 500 + Math.floor(index / 8) * 145, chapter.id)
    }))
    nodes.push(...cards)
    for (const [index, card] of cards.entries()) {
      const next = cards[index + 1]
      const continuation = cards[index + 8]
      if (next !== undefined && index % 8 !== 7) connections.push(connection(card, next))
      if (continuation !== undefined) connections.push(connection(card, continuation))
    }
  }
  await execute(host, id, 0, { kind: 'create', title: COMPLEX_CANVAS_TITLE })
  await execute(host, id, canvasDocument(host, id).revision, { kind: 'add-subgraph', nodes, groups, connections })
  return { id, root, script, folder, chat, counter, research, review, reviewInput, reviewDelivery, scriptText }
}
