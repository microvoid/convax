/** Public graph Factory projects only safe preferences from the shared Chat store. */
import { CanvasGraph } from './CanvasGraph.tsx'
import type { CanvasChatPresentation, CanvasGraphSurfaceProps } from './props.ts'

/**
 * Bind graph presentation to the same window-owned preferences used by Chat cards.
 * @param props - Framework-owned store access and revision-bound graph inputs.
 * @returns The controlled graph with safe presentation reads and copy actions.
 */
export function CanvasGraphSurface(props: CanvasGraphSurfaceProps) {
  const sizes = props.useStore(state => state.sizes)
  const collapsedChats = props.useStore(state => state.collapsedChats)
  const toolWidths = props.useStore(state => state.toolWidths)
  const chatPresentations: Record<string, CanvasChatPresentation> = {}
  for (const node of props.document.nodes) {
    if (node.typeId !== 'convax.chat') continue
    const size = sizes?.[node.id]
    const widths = toolWidths?.[node.id]
    chatPresentations[node.id] = {
      collapsed: collapsedChats?.[node.id] === true,
      ...(size === undefined ? {} : { size }),
      ...(widths === undefined ? {} : { toolWidths: widths }),
    }
  }
  return <CanvasGraph {...props} chatPresentations={chatPresentations}
    applyChatPresentation={props.actions.copyPresentation} />
}
