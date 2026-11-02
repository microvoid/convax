/** Canvas shortcuts leave native editors, embedded conversations and overlays in control. */

/** A graph action resolved before React Flow's node keyboard handler runs. */
export type CanvasKeyboardAction =
  | { readonly kind: 'select-all' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'remove' }
  | { readonly kind: 'zoom-in' }
  | { readonly kind: 'zoom-out' }
  | { readonly kind: 'fit' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'paste' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'move'; readonly x: number; readonly y: number }

const PROTECTED_CONTROL = 'input, textarea, select, button, a, [role="button"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="dialog"], [role="menu"], [data-convax-chat], [data-canvas-native-shortcuts], .xterm'

/**
 * Resolve shortcuts only while this canvas owns keyboard focus.
 * @param event - Native key event, including IME and modifier state.
 * @param root - The mounted graph that may own the action.
 * @returns The graph action, or null when another control owns the key.
 */
export function resolveCanvasKeyboardAction(event: KeyboardEvent, root: HTMLElement): CanvasKeyboardAction | null {
  // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null
  const owner = root.ownerDocument
  const focused = owner.activeElement
  if (focused !== owner.body && (focused === null || !root.contains(focused))) return null
  const protectedTarget = (target: EventTarget | null): boolean => target instanceof Element
    && target.closest(PROTECTED_CONTROL) !== null
    && target.closest('[data-convax-edge-cut]') === null
  if (protectedTarget(event.target) || protectedTarget(focused)) return null
  const key = event.key.toLowerCase()
  if (event.metaKey || event.ctrlKey) {
    if (event.altKey || event.repeat) return null
    if (key === 'z') return { kind: event.shiftKey ? 'redo' : 'undo' }
    if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'y') return { kind: 'redo' }
    if (!event.shiftKey && key === 'a') return { kind: 'select-all' }
    if (!event.shiftKey && key === 'c') return owner.getSelection()?.isCollapsed === false ? null : { kind: 'copy' }
    if (!event.shiftKey && key === 'v') return { kind: 'paste' }
    if (!event.shiftKey && key === 'd') return { kind: 'duplicate' }
    if (key === '+' || key === '=') return { kind: 'zoom-in' }
    if (key === '-' || key === '_') return { kind: 'zoom-out' }
    if (!event.shiftKey && key === '0') return { kind: 'fit' }
    return null
  }
  if (event.altKey) return null
  const directions: Record<string, readonly [number, number]> = {
    arrowleft: [-5, 0], arrowright: [5, 0], arrowup: [0, -5], arrowdown: [0, 5],
  }
  const direction = directions[key]
  if (direction !== undefined) return { kind: 'move', x: direction[0], y: direction[1] }
  if (event.shiftKey) return null
  if (key === 'escape') return { kind: 'cancel' }
  if (key === 'delete' || key === 'backspace') return event.repeat ? null : { kind: 'remove' }
  return null
}
