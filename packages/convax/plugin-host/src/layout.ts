/** Pure grid positioning; callers supply measured or explicitly estimated node sizes. */
import type { CanvasNodeId, CanvasPoint } from './types.ts'

/** Geometry supplied by the caller rather than inferred from provider payloads. */
export interface CanvasLayoutNode {
  /** Identity retained in the resulting position edit. */
  id: CanvasNodeId
  /** Width in canvas coordinates; zero represents a point. */
  width: number
  /** Height in canvas coordinates; zero represents a point. */
  height: number
}

/** Explicit grid policy independent of persistence and revision guards. */
export interface CanvasGridLayout {
  /** Upper-left position of the first cell. */
  origin: CanvasPoint
  /** Positive integer count of columns. */
  columns: number
  /** Empty horizontal space between cells. */
  columnGap: number
  /** Empty vertical space between rows. */
  rowGap: number
}

/**
 * Calculate non-overlapping cells using the largest width per column and height per row.
 * @param nodes - Ordered nodes with finite nonnegative dimensions supplied by the caller.
 * @param options - Finite origin, nonnegative gaps and a positive integer column count.
 * @returns Detached position edits; no graph, revision or input object is changed.
 */
export function layoutGrid(nodes: readonly CanvasLayoutNode[], options: CanvasGridLayout): { id: CanvasNodeId; position: CanvasPoint }[] {
  const widths: number[] = [], heights: number[] = []
  nodes.forEach((node, index) => {
    const column = index % options.columns, row = Math.floor(index / options.columns)
    widths[column] = Math.max(widths[column] ?? 0, node.width)
    heights[row] = Math.max(heights[row] ?? 0, node.height)
  })
  const offsets = (sizes: number[], start: number, gap: number): number[] => {
    let next = start
    return sizes.map((size) => { const current = next; next += size + gap; return current })
  }
  const xs = offsets(widths, options.origin.x, options.columnGap), ys = offsets(heights, options.origin.y, options.rowGap)
  return nodes.map((node, index) => {
    const x = xs[index % options.columns], y = ys[Math.floor(index / options.columns)]
    if (x === undefined || y === undefined) throw new RangeError('A grid layout requires a positive integer column count')
    return { id: node.id, position: { x, y } }
  })
}
