/** Default node payloads and creation entries; the canvas kernel owns no type identities. */
import { AppWindow, BotMessageSquare, FilePlus, FolderClosed, Globe, TerminalSquare } from 'lucide-react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CanvasConnectionId, CanvasData, CanvasNode, CanvasNodeTypeId, CanvasResource } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasCreationDefinition, CanvasWorkspaceActions, WorkspaceProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'

/** Presentation metadata remains independently reusable in real composition fixtures. */
export const defaultNodePresentation = {
  'convax.file': { defaultSize: { width: 320, height: 140 }, presentation: 'resource' as const },
  'convax.folder': { defaultSize: { width: 320, height: 140 }, presentation: 'resource' as const },
  'convax.chat': { defaultSize: { width: 620, height: 680 }, presentation: 'chat' as const,
    dragHandle: '[data-convax-chat-drag]', clipboardData: defaultNodeClipboardData },
  'convax.terminal': { defaultSize: { width: 640, height: 400 }, presentation: 'resource' as const, dragHandle: '[data-convax-tool-drag]' },
  'convax.browser': { defaultSize: { width: 640, height: 480 }, presentation: 'resource' as const, defaultExpanded: true, dragHandle: '[data-convax-browser-header]' },
  'convax.window': { defaultSize: { width: 480, height: 310 }, presentation: 'resource' as const, dragHandle: '[data-convax-window-header]' },
}

/** Copy Chat identity fields while drafts and native bindings retain their own owner. */
export function defaultNodeClipboardData(node: CanvasNode): CanvasData {
  if (node.typeId !== 'convax.chat') return structuredClone(node.data)
  const data: CanvasData = {}
  if (typeof node.data.title === 'string') data.title = node.data.title
  if (typeof node.data.cwd === 'string') data.cwd = node.data.cwd
  if (node.data.defaultTitle === true) data.defaultTitle = true
  return data
}

/** Build feature payloads through the same public action contribution as external plugins. */
export function defaultNodeActions(describe: (path: string) => Promise<CanvasResource>): CanvasWorkspaceActions {
  return {
    createResourceNode: (resource, id, position) => ({ id, typeId: `convax.${resource.kind}` as CanvasNodeTypeId,
      dataVersion: 1, data: { path: resource.path }, position, revision: 0 }),
    createChatNode: (id, cwd, title, position) => ({ id, typeId: 'convax.chat' as CanvasNodeTypeId,
      dataVersion: 1, data: { title, defaultTitle: true, cwd }, position, revision: 0 }),
    createWindowNode: (id, bindingId, name, position) => ({ id, typeId: 'convax.window' as CanvasNodeTypeId,
      dataVersion: 1, data: { bindingId, name }, position, revision: 0 }),
    inputDirectory: async (node) => {
      if ((node.typeId !== 'convax.file' && node.typeId !== 'convax.folder') || typeof node.data.path !== 'string') return undefined
      try {
        const resource = await describe(node.data.path)
        if (resource.kind === 'folder') return resource.path
        const separator = Math.max(resource.path.lastIndexOf('/'), resource.path.lastIndexOf('\\'))
        const parent = await describe(resource.path.slice(0, separator + 1))
        return parent.kind === 'folder' ? parent.path : undefined
      } catch (_unavailable) { return undefined }
    },
  }
}

/** Translated entries stay reactive because labels resolve at render time. */
export function defaultNodeCreations(t: WorkspaceProps['t'], windowsAvailable = false): CanvasCreationDefinition[] {
  return [
    { id: 'project', label: () => t('workspace.addProject'), icon: FolderClosed, dockGroup: 'resources', defaultSize: { width: 320, height: 140 },
      create: (action) => {
        if (action.origin === undefined) action.addProject(action.position)
        else action.addProject(action.position, action.origin)
      } },
    { id: 'files', label: () => t('workspace.addFile'), icon: FilePlus, dockGroup: 'resources', defaultSize: { width: 320, height: 140 },
      create: (action) => {
        if (action.origin === undefined) action.addFiles(action.position)
        else action.addFiles(action.position, action.origin)
      } },
    ...windowsAvailable ? [{ id: 'window', label: () => t('window.add'), icon: AppWindow, connected: false,
      defaultSize: { width: 480, height: 310 },
      create: (action: Parameters<CanvasCreationDefinition['create']>[0]) => { action.addWindow?.(action.position) } }] : [],
    { id: 'terminal', label: () => t('terminal.title'), icon: TerminalSquare, connectionDirection: 'input',
      defaultSize: { width: 640, height: 400 },
      create: (action) => { const id = randomUUID() as CanvasNode['id']; void action.command({ kind: 'add-node', node: {
        id, typeId: 'convax.terminal' as CanvasNodeTypeId,
        dataVersion: 1, data: {}, position: action.position, revision: 0,
      }, ...(action.origin === undefined ? {} : { initialConnections: [{
        id: randomUUID() as CanvasConnectionId, source: action.origin.nodeId, sourcePort: action.origin.portId,
        target: id, targetPort: 'input', purpose: 'input' as const,
      }] }) }) } },
    { id: 'browser', label: () => t('browser.title'), icon: Globe, connected: false,
      defaultSize: { width: 640, height: 480 },
      create: (action) => { void action.command({ kind: 'add-node', node: {
        id: randomUUID() as CanvasNode['id'], typeId: 'convax.browser' as CanvasNodeTypeId,
        dataVersion: 1, data: {}, position: action.position, revision: 0,
      } }) } },
    { id: 'chat', label: () => t('chat.new'), icon: BotMessageSquare, defaultSize: { width: 620, height: 680 },
      create: (action) => {
        if (action.origin === undefined) action.createChat(undefined, undefined, action.position)
        else action.createChat(undefined, undefined, action.position, action.origin)
      } },
  ]
}
