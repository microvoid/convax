/** Chat discovery follows the same saved-graph selection as node and edge reads. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { projectCanvasGraph } from '../src/graph-query.ts'
import type { CanvasChat, CanvasConnectionId, CanvasGroupId, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '../src/types.ts'

const canvasId = 'canvas' as CanvasId
const otherCanvasId = 'other' as CanvasId
const groupId = 'project' as CanvasGroupId
const chatId = 'chat' as CanvasNodeId
const siblingId = 'sibling' as CanvasNodeId
const otherId = 'other-chat' as CanvasNodeId
const fileId = 'file' as CanvasNodeId
const chatType = 'convax.chat' as CanvasNodeTypeId
const fileType = 'convax.file' as CanvasNodeTypeId

function node(id: CanvasNodeId, typeId: CanvasNodeTypeId, grouped = false): CanvasNode {
  return { id, typeId, dataVersion: 1, revision: 1, data: {}, position: { x: 0, y: 0 },
    ...(grouped ? { groupId } : {}) }
}

function chat(id: CanvasNodeId, target = canvasId): CanvasChat {
  return { canvasId: target, nodeId: id, title: id, cwd: '/project', deleting: false, issue: null,
    threads: [{ sessionId: SessionId(`${id}-thread`), parentSessionId: null, inheritedEventCount: 0 }] }
}

function workspace(): CanvasWorkspace {
  return {
    revision: 1, nodeTypes: [], nodeIssues: [],
    canvases: [
      { id: canvasId, title: 'Projects', revision: 3, nodes: [node(chatId, chatType, true), node(siblingId, chatType), node(fileId, fileType, true)],
        groups: [{ id: groupId, title: 'Project' }],
        connections: [{ id: 'reference' as CanvasConnectionId, source: fileId, sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'input' }] },
      { id: otherCanvasId, title: 'Other', revision: 1, nodes: [node(otherId, chatType)], connections: [] },
    ],
    chats: [chat(chatId), { ...chat(siblingId), deleting: true, issue: 'Retry delivery', issueCode: 'delivery' }, chat(otherId, otherCanvasId)],
  }
}

describe('Convax Chat graph projection', () => {
  it('omits Chat and thread records until explicitly requested', () => {
    const result = projectCanvasGraph(workspace(), canvasId, {})
    expect(result).not.toHaveProperty('chats')
    expect(result.projection).toMatchObject({ chats: false, completeChats: false })
  })

  it('returns detached current-canvas Chat state without loading nodes or other canvases', () => {
    const source = workspace()
    const result = projectCanvasGraph(source, canvasId, { include: ['chats'] })
    expect(result).toMatchObject({ chats: source.chats.slice(0, 2), projection: { chats: true, completeChats: true } })
    expect(result).not.toHaveProperty('nodes')
    expect(result).not.toHaveProperty('connections')
    const chats = result.chats as unknown as CanvasChat[]
    chats[0]!.threads[0]!.inheritedEventCount = 99
    chats[1]!.issue = 'Changed projection'
    expect(source.chats[0]!.threads[0]!.inheritedEventCount).toBe(0)
    expect(source.chats[1]!.issue).toBe('Retry delivery')
  })

  it.each([
    { nodeIds: [chatId] },
    { groupIds: [groupId] },
    { connectionIds: ['reference' as CanvasConnectionId] },
    { incidentTo: [fileId] },
    { nodeIds: [chatId, fileId], typeIds: [chatType] },
  ])('uses selected graph nodes to restrict Chat state: %j', (selection) => {
    const result = projectCanvasGraph(workspace(), canvasId, { include: ['chats'], selection })
    expect(result).toMatchObject({ chats: [chat(chatId)], projection: { chats: true, completeChats: false } })
  })

  it('does not expose Chat state for missing targets or selected non-Chat nodes', () => {
    for (const target of [null, 'missing' as CanvasId]) {
      expect(projectCanvasGraph(workspace(), target, { include: ['chats'] })).toMatchObject({
        chats: [], projection: { chats: true, completeChats: false },
      })
    }
    expect(projectCanvasGraph(workspace(), canvasId, { include: ['chats'], selection: { typeIds: [fileType] } })).toMatchObject({ chats: [] })
  })
})
