/** Canvas membership, rather than Chat selection or tab visibility, owns browser runtimes. */
import { expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { BrowserViewOptions } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import { CanvasBrowserCards } from '../src/client/browser-cards.ts'

const canvasId = 'canvas' as CanvasId
const nodeId = 'browser' as CanvasNodeId
function workspace(present = true): CanvasWorkspace {
  return { revision: 1, nodeTypes: [], nodeIssues: [], chats: [], canvases: [{
    id: canvasId, title: 'Board', revision: 1, connections: [], nodes: present ? [{
      id: nodeId, typeId: 'convax.browser' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Preview', url: 'http://localhost:3000/' }, revision: 1, position: { x: 0, y: 0 },
    }] : [],
  }] }
}

it('retains a canvas browser across unrelated observations and closes it only after graph removal', async () => {
  const created: BrowserViewOptions[] = []
  const create = vi.fn((options: BrowserViewOptions) => { created.push(options) })
  const close = vi.fn(async () => {})
  const ensureDirectory = vi.fn(async () => '/canvases/one')
  const popup = vi.fn()
  const cards = new CanvasBrowserCards({ create, close }, ensureDirectory, popup)
  cards.reconcile(workspace())
  const options = created[0]!
  expect(create).toHaveBeenCalledOnce()
  expect(ensureDirectory).not.toHaveBeenCalled()
  cards.ensure(canvasId, nodeId)
  cards.reconcile(workspace())
  expect(create).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
  expect(await options.workspace(options.signal)).toBe('cwd:/canvases/one')
  expect(ensureDirectory).toHaveBeenCalledWith(canvasId, options.signal)
  options.openRequested('https://popup.example/')
  expect(popup).toHaveBeenCalledWith(canvasId, nodeId, 'https://popup.example/')
  cards.reconcile(workspace(false))
  expect(close).toHaveBeenCalledExactlyOnceWith(nodeId)
  expect(options.signal.aborted).toBe(true)
  cards.reconcile(workspace())
  expect(create).toHaveBeenCalledTimes(2)
  expect(created[1]!.signal).not.toBe(options.signal)
  expect(created[1]!.restoreUrl).toBe('http://localhost:3000/')
  cards.dispose()
  expect(created[1]!.signal.aborted).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  cards.ensure(canvasId, nodeId)
  expect(create).toHaveBeenCalledTimes(2)
})
