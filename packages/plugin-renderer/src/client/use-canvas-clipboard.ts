/** Clipboard operations capture their graph revision before awaiting the system clipboard. */
import { useEffect, useRef, useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CanvasCommand, CanvasData, CanvasDocument, CanvasNode, CanvasNodeId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'
import {
  copyCanvasSelection, parseCanvasClipboard, type CanvasClipboardNotice, type CanvasClipboardPayload, type CanvasClipboardView,
  type ClipboardNodeSize,
} from './canvas-clipboard.ts'
import { canvasClipboardBounds, createClipboardSubgraph, type ClipboardObstacle } from './clipboard-placement.ts'
import { RESOURCE_CARD_GAP } from './placement.ts'

interface ClipboardOwner {
  readonly copyData?: (node: CanvasNode) => CanvasData
  readonly document: CanvasDocument
  readonly dimensions: Readonly<Record<string, ClipboardNodeSize>>
  readonly views: Readonly<Record<string, CanvasClipboardView>>
  readonly obstacles: readonly ClipboardObstacle[]
  readonly command: (command: CanvasCommand) => Promise<boolean>
  readonly report: (notice: CanvasClipboardNotice) => void
  readonly select: (nodeIds: CanvasNodeId[]) => void
  readonly reveal: (nodeIds: CanvasNodeId[]) => void
  readonly applyViews: (copies: readonly { readonly nodeId: CanvasNodeId; readonly view: CanvasClipboardView }[]) => void
  readonly pasteCenter: () => CanvasPoint | null
}

interface CanvasClipboardActions {
  pending: boolean
  copy: (nodeIds: readonly CanvasNodeId[]) => Promise<void>
  paste: (position?: CanvasPoint) => Promise<void>
  duplicate: (nodeIds: readonly CanvasNodeId[]) => Promise<void>
  cancel: () => boolean
}

/**
 * Keep clipboard work local to this mounted canvas and reject stale async paste intentions.
 * @param owner - Current Host document, measured geometry and UI actions.
 * @returns Pending state and copy, paste and duplicate actions.
 */
export function useCanvasClipboard(owner: ClipboardOwner): CanvasClipboardActions {
  const latest = useRef(owner)
  latest.current = owner
  const mounted = useRef(false)
  const working = useRef<{ phase: 'read' | 'copy' | 'commit'; cancelled: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (working.current !== null) working.current.cancelled = true }
  }, [])

  const begin = (phase: 'read' | 'copy' | 'commit') => {
    if (working.current !== null) return null
    const operation = { phase, cancelled: false }
    working.current = operation
    setPending(true)
    return operation
  }
  const finish = (operation: { cancelled: boolean }): void => {
    if (working.current !== operation) return
    working.current = null
    if (mounted.current) setPending(false)
  }
  const cancel = (): boolean => {
    if (working.current?.phase !== 'read') return false
    working.current.cancelled = true
    working.current = null
    setPending(false)
    return true
  }
  const current = (snapshot: CanvasDocument): boolean => mounted.current && latest.current.document.id === snapshot.id
    && latest.current.document.revision === snapshot.revision
  const sameCanvas = (snapshot: CanvasDocument): boolean => mounted.current && latest.current.document.id === snapshot.id
  const applyViews = (nodes: readonly CanvasNode[], source: CanvasClipboardPayload): void => {
    latest.current.applyViews(nodes.map((node, index) => {
      const original = source.nodes[index]
      const view = original === undefined ? undefined : source.views[original.id]
      if (view === undefined) throw new Error('Copied node presentation is absent')
      return { nodeId: node.id, view }
    }))
  }
  const commitCopy = async (
    payload: CanvasClipboardPayload, command: Extract<CanvasCommand, { kind: 'add-subgraph' }>, snapshot: CanvasDocument,
  ): Promise<void> => {
    const saved = await owner.command(command)
    if (!saved || !sameCanvas(snapshot)) return
    const ids = command.nodes.map(node => node.id)
    applyViews(command.nodes, payload)
    latest.current.select(ids)
    latest.current.reveal(ids)
  }

  const copy = async (nodeIds: readonly CanvasNodeId[]): Promise<void> => {
    const snapshot = owner.document
    const payload = copyCanvasSelection(snapshot, nodeIds, owner.dimensions, owner.views, owner.copyData)
    if (payload === null) return
    const operation = begin('copy')
    if (operation === null) return
    try {
      const accepted = await writeClipboard(JSON.stringify(payload))
      if (sameCanvas(snapshot)) owner.report(accepted ? 'clipboard.copied' : 'clipboard.copyFailed')
    } catch (_clipboardWriteFailure) {
      if (sameCanvas(snapshot)) owner.report('clipboard.copyFailed')
    } finally { finish(operation) }
  }

  const paste = async (position?: CanvasPoint): Promise<void> => {
    const snapshot = owner.document
    const operation = begin('read')
    if (operation === null) return
    try {
      let text: string
      try {
        text = await navigator.clipboard.readText()
      } catch (_clipboardReadFailure) {
        if (!operation.cancelled && sameCanvas(snapshot)) owner.report('clipboard.readFailed')
        return
      }
      if (operation.cancelled) return
      if (!current(snapshot)) {
        if (sameCanvas(snapshot)) owner.report('clipboard.changed')
        return
      }
      const payload = parseCanvasClipboard(text)
      if (payload === null) { owner.report('clipboard.invalid'); return }
      const present = latest.current
      const center = present.pasteCenter()
      if (position === undefined && center === null) return
      const bounds = canvasClipboardBounds(payload)
      const desired = position ?? (center === null ? null : { x: center.x - bounds.width / 2, y: center.y - bounds.height / 2 })
      if (desired === null) return
      const command = createClipboardSubgraph(payload, desired, present.obstacles, randomUUID, present.copyData)
      operation.phase = 'commit'
      await commitCopy(payload, command, snapshot)
    } catch (_clipboardPasteFailure) {
      if (sameCanvas(snapshot)) owner.report('clipboard.invalid')
    } finally { finish(operation) }
  }

  const duplicate = async (nodeIds: readonly CanvasNodeId[]): Promise<void> => {
    const snapshot = owner.document
    const payload = copyCanvasSelection(snapshot, nodeIds, owner.dimensions, owner.views, owner.copyData)
    if (payload === null) return
    const operation = begin('commit')
    if (operation === null) return
    try {
      const bounds = canvasClipboardBounds(payload)
      const command = createClipboardSubgraph(payload,
        { x: bounds.x + RESOURCE_CARD_GAP, y: bounds.y + RESOURCE_CARD_GAP }, owner.obstacles, randomUUID, owner.copyData)
      await commitCopy(payload, command, snapshot)
    } catch (_duplicateFailure) {
      if (sameCanvas(snapshot)) owner.report('clipboard.invalid')
    } finally { finish(operation) }
  }
  return { pending, copy, paste, duplicate, cancel }
}
