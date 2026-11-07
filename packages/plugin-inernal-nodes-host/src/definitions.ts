/** Default node schemas and semantics, installed through the public provider API. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CanvasNodeDefinition, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host'

/**
 * Register each default type without privileged access to the graph store.
 * @param register - Effect-owned registration supplied by the composing plugin.
 */
export function registerDefaultNodes(register: (definition: CanvasNodeDefinition) => void): void {
  const resourceData = z.looseObject({ path: z.string().min(1) })
  for (const id of ['convax.file', 'convax.folder']) {
    register({
      id: id as CanvasNodeTypeId, dataVersion: 1, capabilities: { resourceKind: id === 'convax.file' ? 'file' : 'folder' },
      description: id === 'convax.file' ? 'Reference to an existing file; file contents remain in the filesystem.' : 'Reference to an existing folder; directory entries are read on demand.',
      dataSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, description: 'Absolute path to an existing resource.' } }, required: ['path'], additionalProperties: true },
      ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
      parse: data => ({ ...data, path: resourceData.parse(data).path }),
    })
  }
  const terminalData = z.strictObject({ title: z.string().trim().min(1).optional(), shellPath: z.string().min(1).optional() })
  register({
    id: 'convax.terminal' as CanvasNodeTypeId, dataVersion: 1,
    description: 'Interactive user terminal owned by this canvas card. Input files and folders select its launch directory.',
    dataSchema: { type: 'object', properties: {
      title: { type: 'string', minLength: 1, description: 'Optional display title.' },
      shellPath: { type: 'string', minLength: 1, description: 'Optional installed shell executable.' },
    }, additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }],
    parse: (data) => {
      const value = terminalData.parse(data)
      return { ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.shellPath === undefined ? {} : { shellPath: value.shellPath }) }
    },
  })
  const browserData = z.strictObject({ title: z.string().trim().min(1).optional(), url: z.string().min(1).optional() })
  register({
    id: 'convax.browser' as CanvasNodeTypeId, dataVersion: 1,
    description: 'Interactive browser page owned by this canvas card.',
    dataSchema: { type: 'object', properties: {
      title: { type: 'string', minLength: 1, description: 'Optional display title.' },
      url: { type: 'string', minLength: 1, description: 'Page address.' },
    }, additionalProperties: false },
    ports: [],
    parse: (data) => {
      const value = browserData.parse(data)
      return { ...(value.title === undefined ? {} : { title: value.title }), ...(value.url === undefined ? {} : { url: value.url }) }
    },
  })
  const windowData = z.strictObject({ bindingId: z.uuid(), name: z.string().trim().min(1) })
  register({
    id: 'convax.window' as CanvasNodeTypeId, dataVersion: 1,
    description: 'Selected application window. Live capture belongs to the current Desktop; graph data does not grant capture or input access.',
    dataSchema: { type: 'object', properties: {
      bindingId: { type: 'string', format: 'uuid', description: 'Selection identity; no native window or process handle.' },
      name: { type: 'string', minLength: 1, description: 'Display name of the explicitly selected window.' },
    }, required: ['bindingId', 'name'], additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse: data => windowData.parse(data),
  })
  const chatData = z.object({ title: z.string().trim().min(1), defaultTitle: z.boolean().optional(), cwd: z.string().refine(isAbsolute, 'An absolute project directory is required') })
    .transform(({ defaultTitle, ...value }) => ({ ...value, ...(defaultTitle === undefined ? {} : { defaultTitle }) }))
  register({
    id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, capabilities: { sessions: true },
    description: 'Chat container with a project directory and independently created DSH Session threads.',
    dataSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, defaultTitle: { type: 'boolean', description: 'True only for a system-generated untitled Chat; omit for explicit names.' }, cwd: { type: 'string', description: 'Absolute project directory.' } }, required: ['title', 'cwd'], additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse: data => chatData.parse(data),
  })
}
