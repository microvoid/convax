/** Detached graph projections for Agent reads; view selection and camera state stay client-owned. */
import type { CanvasConnection, CanvasData, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace, CanvasGroupId, CanvasGroup } from './types.ts'

/** Select an induced subgraph or the endpoints of explicitly selected connections. */
export interface CanvasGraphSelection {
  /** Restrict nodes to these identities. */
  nodeIds?: CanvasNodeId[]
  /** Intersect node identities with these provider types. */
  typeIds?: CanvasNodeTypeId[]
  /** Restrict connections and their endpoint nodes to these identities. */
  connectionIds?: CanvasConnection['id'][]
  /** Read connections touching these nodes and their endpoint nodes. */
  incidentTo?: CanvasNodeId[]
  /** Restrict nodes and group records to these logical groups. */
  groupIds?: CanvasGroupId[]
}

/** Optional projections; omitted node or connection fields retain their complete records. */
export interface CanvasGraphFields {
  /** Included node fields; identity is always retained. */
  nodes?: (keyof CanvasNode)[]
  /** Included connection fields; identity is always retained. */
  connections?: (keyof CanvasConnection)[]
  /** Included group metadata fields; identity is always retained. */
  groups?: (keyof CanvasGroup)[]
}

/** Read choices independent of the calling Session's default canvas resolution. */
export interface CanvasGraphQuery {
  /** Intersecting record selectors; absence selects the complete target graph. */
  selection?: CanvasGraphSelection
  /** Fields retained in each requested record collection. */
  fields?: CanvasGraphFields
  /** Collections to return; omission returns only canvas summaries. */
  include?: ('canvases' | 'nodes' | 'connections' | 'groups' | 'chats' | 'nodeTypes' | 'issues')[]
}

function project(record: CanvasData & { id: string }, fields: string[] | undefined): CanvasData {
  if (fields === undefined) return structuredClone(record)
  const selected: CanvasData = { id: record.id }
  for (const field of fields) if (record[field] !== undefined) selected[field] = structuredClone(record[field])
  return selected
}

/**
 * Project only requested records and mark omitted collections and fields explicitly.
 * @param workspace - Detached current graph and runtime provider metadata.
 * @param canvasId - Resolved canvas, or null for an unbound workspace read.
 * @param query - Optional subgraph selection and field projections; default returns canvas summaries.
 * @returns JSON-compatible records with the target revision and explicit projection completeness.
 */
export function projectCanvasGraph(workspace: CanvasWorkspace, canvasId: CanvasId | null, query: CanvasGraphQuery): CanvasData {
  const canvas = workspace.canvases.find(value => value.id === canvasId)
  const include = new Set(query.include ?? ['canvases'])
  const selection = query.selection
  const selectedNode = (node: CanvasNode): boolean => (selection?.nodeIds === undefined || selection.nodeIds.includes(node.id))
    && (selection?.typeIds === undefined || selection.typeIds.includes(node.typeId))
    && (selection?.groupIds === undefined || node.groupId !== undefined && selection.groupIds.includes(node.groupId))
  let nodes = (canvas?.nodes ?? []).filter(selectedNode)
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = (canvas?.connections ?? []).filter(edge =>
    (selection?.connectionIds === undefined || selection.connectionIds.includes(edge.id))
    && (selection?.incidentTo === undefined || selection.incidentTo.includes(edge.source) || selection.incidentTo.includes(edge.target))
    && nodeIds.has(edge.source) && nodeIds.has(edge.target))
  if (selection?.connectionIds !== undefined || selection?.incidentTo !== undefined) {
    const endpoints = new Set(edges.flatMap(edge => [edge.source, edge.target]))
    for (const id of selection.incidentTo ?? []) endpoints.add(id)
    nodes = nodes.filter(node => endpoints.has(node.id))
  }
  const selectedNodeIds = new Set(nodes.map(node => node.id))
  return {
    canvasId: canvas?.id ?? null, revision: canvas?.revision ?? null, title: canvas?.title ?? null,
    projection: {
      nodes: include.has('nodes'), connections: include.has('connections'), nodeTypes: include.has('nodeTypes'), issues: include.has('issues'),
      groups: include.has('groups'), chats: include.has('chats'),
      completeChats: canvas !== undefined && include.has('chats') && selection === undefined,
      completeGroups: canvas !== undefined && include.has('groups') && selection === undefined && query.fields?.groups === undefined,
      groupFields: query.fields?.groups ?? null,
      completeNodes: canvas !== undefined && include.has('nodes') && selection === undefined && query.fields?.nodes === undefined,
      completeConnections: canvas !== undefined && include.has('connections') && selection === undefined && query.fields?.connections === undefined,
      nodeFields: query.fields?.nodes ?? null, connectionFields: query.fields?.connections ?? null,
    },
    ...(include.has('canvases') ? { canvases: workspace.canvases.map(({ id, title, revision, archived }) => ({
      id, title, revision, ...(archived === undefined ? {} : { archived }),
    })) } : {}),
    ...(include.has('nodes') ? { nodes: nodes.map(node => project({ ...node, position: { ...node.position } }, query.fields?.nodes)) } : {}),
    ...(include.has('groups') ? { groups: (canvas?.groups ?? []).filter(group => selection === undefined
      || nodes.some(node => node.groupId === group.id)).map(group => project({ ...group }, query.fields?.groups)) } : {}),
    ...(include.has('connections') ? { connections: edges.map(edge => project({ ...edge }, query.fields?.connections)) } : {}),
    ...(include.has('chats') ? { chats: workspace.chats.filter(chat => chat.canvasId === canvasId
      && selectedNodeIds.has(chat.nodeId)).map(chat => ({ ...chat, threads: chat.threads.map(thread => ({ ...thread })) })) } : {}),
    ...(include.has('nodeTypes') ? { nodeTypes: workspace.nodeTypes.map(type => ({ ...type, ports: type.ports.map(port => ({ ...port })), description: type.description ?? null, dataSchema: type.dataSchema ?? null })) } : {}),
    ...(include.has('issues') ? { nodeIssues: workspace.nodeIssues.filter(issue => canvasId === null || issue.canvasId === canvasId).map(issue => ({ ...issue })) } : {}),
  }
}
