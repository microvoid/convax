// @vitest-environment jsdom
/** Embedded tool widths preview in workspace coordinates and cancel with their presentation lifetime. */
import { randomUUID } from 'node:crypto'
import { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbeddedSidebar } from '../src/client/shell/EmbeddedSidebar.tsx'
import { createSidebarRightStore } from '../src/client/stores.ts'
import type { EmbeddedSidebarResize } from '../src/client/contract/slots.ts'

afterEach(cleanup)

type Props = FactoryComponentPropsOf<'sidebar.right.embedded'>

function fixture(options: { scale?: number; fullscreen?: boolean; resizable?: boolean } = {}) {
  const sessionId = randomUUID() as SessionId
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  store.actions.setExpanded(sessionId, true)
  if (options.fullscreen) store.actions.setMode(sessionId, 'fullscreen')
  const onCommit = vi.fn<EmbeddedSidebarResize['onCommit']>()
  const resize: EmbeddedSidebarResize = { label: 'Resize tools', help: 'Drag or use Left and Right', onCommit }
  const unused = (): never => { throw new Error('Embedded resize fixture does not provide unused Session sources or actions') }
  let props: Props = {
    sessionId, width: 480, fullscreenWidth: 960, active: true,
    ...(options.resizable === false ? {} : { resize }),
    useStore: bindSnapshotSelector(store), actions: store.actions,
    mount: () => () => {}, retainTab: unused,
    renderFactorySlot: () => <input aria-label="Tool draft" defaultValue="keep this page" />,
    useFactorySlot: unused,
    useSession: unused, useProjection: unused, useAccess: unused, useRemoteAccess: unused, useConversation: unused, useInput: unused,
    useChat: unused, useTrajectory: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useSessionAccess: unused, useWorkspaceAccess: unused,
    usePanelInfo: unused, useResource: unused, useWorkspaces: unused,
    inputActions: {
      insertQuote: unused, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
      addAttachments: unused, removeAttachment: unused, removeReference: unused, pruneAttachments: unused, submit: unused,
    },
  }
  const view = render(<EmbeddedSidebar {...props} />)
  const root = view.container.querySelector<HTMLElement>('[data-sidebar-right-embedded]')
  if (root === null) throw new Error('Expected the embedded companion')
  const scale = options.scale ?? 0.5
  Object.defineProperties(root, {
    offsetWidth: { configurable: true, get: () => Number.parseFloat(root.style.width) },
    getBoundingClientRect: {
      configurable: true, value: () => new DOMRect(100, 100, Number.parseFloat(root.style.width) * scale, 400 * scale),
    },
  })
  const grip = () => {
    const button = view.getByRole('button', { name: resize.label })
    let captured: number | undefined
    const capture = {
      setPointerCapture: vi.fn((id: number) => { captured = id }),
      hasPointerCapture: vi.fn((id: number) => captured === id),
      releasePointerCapture: vi.fn((id: number) => { if (captured === id) captured = undefined }),
    }
    for (const [name, value] of Object.entries(capture)) Object.defineProperty(button, name, { configurable: true, value })
    return { button, ...capture }
  }
  return { ...view, root, store, sessionId, onCommit, resize, grip,
    update: (patch: Partial<Props>) => { props = { ...props, ...patch }; view.rerender(<EmbeddedSidebar {...props} />) },
    disableResize: () => { const { resize: _resize, ...rest } = props; props = rest; view.rerender(<EmbeddedSidebar {...props} />) },
  }
}

function pointer(target: HTMLElement, type: string, x: number, pointerId = 7): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 200 })
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

function ReleaseDuringCommit({ release }: { release: () => void }) {
  useLayoutEffect(release, [release])
  return null
}

describe('Embedded Sidebar resizing', () => {
  it.each([[0.5, 560], [2, 500]] as const)('previews pointer movement at scale %s and commits only on release', (scale, width) => {
    const b = fixture({ scale })
    const grip = b.grip()
    const draft = b.getByRole('textbox', { name: 'Tool draft' })
    pointer(grip.button, 'pointerdown', 100)
    expect(document.activeElement).toBe(grip.button)
    pointer(grip.button, 'pointermove', 140)
    expect(b.root.style.width).toBe(`${width}px`)
    expect(b.root.hasAttribute('data-sidebar-right-resizing')).toBe(true)
    expect(b.getByRole('button', { name: b.resize.label })).toBe(grip.button)
    expect(grip.hasPointerCapture(7)).toBe(true)
    expect(grip.releasePointerCapture).not.toHaveBeenCalled()
    expect(b.onCommit).not.toHaveBeenCalled()
    expect(b.getByRole('textbox', { name: 'Tool draft' })).toBe(draft)
    pointer(grip.button, 'pointerup', 140)
    expect(b.onCommit).toHaveBeenCalledExactlyOnceWith(width, false)
    expect(b.root.hasAttribute('data-sidebar-right-resizing')).toBe(false)
    expect(b.root.style.width).toBe('480px')
    expect(grip.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('commits the final release coordinate and expanded-mode identity without a move event', () => {
    const b = fixture({ fullscreen: true })
    const grip = b.grip()
    expect(b.root.style.width).toBe('960px')
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointerup', 120)
    expect(b.onCommit).toHaveBeenCalledExactlyOnceWith(1000, true)
  })

  it('does not commit a press and release without horizontal displacement', () => {
    const b = fixture()
    const grip = b.grip()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointerup', 100)
    expect(b.onCommit).not.toHaveBeenCalled()
    expect(grip.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('keeps the original capture when another pointer presses or releases the grip', () => {
    const b = fixture()
    const grip = b.grip()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointerdown', 200, 8)
    pointer(grip.button, 'pointermove', 300, 8)
    pointer(grip.button, 'pointerup', 300, 8)
    expect(b.root.style.width).toBe('480px')
    expect(b.onCommit).not.toHaveBeenCalled()
    pointer(grip.button, 'pointerup', 120)
    expect(b.onCommit).toHaveBeenCalledExactlyOnceWith(520, false)
    expect(grip.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7)
  })

  it.each(['pointercancel', 'lostpointercapture'])('restores the owner width after %s without a commit', (event) => {
    const b = fixture()
    const grip = b.grip()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointermove', 120)
    expect(b.root.style.width).toBe('520px')
    pointer(grip.button, event, 120)
    expect(b.root.style.width).toBe('480px')
    expect(b.root.hasAttribute('data-sidebar-right-resizing')).toBe(false)
    pointer(grip.button, 'pointerup', 140)
    expect(b.onCommit).not.toHaveBeenCalled()
  })

  it.each(['inactive', 'collapsed', 'mode', 'session', 'disabled', 'unmounted'] as const)(
    'cancels an unfinished gesture when the companion becomes %s', (change) => {
      const b = fixture()
      const grip = b.grip()
      pointer(grip.button, 'pointerdown', 100)
      pointer(grip.button, 'pointermove', 120)
      expect(b.root.style.width).toBe('520px')
      switch (change) {
        case 'inactive': b.update({ active: false }); break
        case 'collapsed': act(() => { b.store.actions.setExpanded(b.sessionId, false) }); break
        case 'mode': act(() => { b.store.actions.setMode(b.sessionId, 'fullscreen') }); break
        case 'session': {
          const next = randomUUID() as SessionId
          act(() => { b.store.actions.setExpanded(next, true) })
          b.update({ sessionId: next })
          break
        }
        case 'disabled': b.disableResize(); break
        case 'unmounted': b.unmount(); break
      }
      expect(grip.releasePointerCapture).toHaveBeenCalledWith(7)
      if (change === 'unmounted') expect(b.root.isConnected).toBe(false)
      else expect(b.root.hasAttribute('data-sidebar-right-resizing')).toBe(false)
      pointer(grip.button, 'pointerup', 140)
      expect(b.onCommit).not.toHaveBeenCalled()
      if (change === 'mode') expect(b.root.style.width).toBe('960px')
      if (change === 'session' || change === 'disabled') expect(b.root.style.width).toBe('480px')
    },
  )

  it('keeps a captured gesture through callback identity changes', () => {
    const b = fixture()
    const grip = b.grip()
    const nextCommit = vi.fn<EmbeddedSidebarResize['onCommit']>()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointermove', 120)
    b.update({ resize: { ...b.resize, onCommit: nextCommit } })
    expect(grip.releasePointerCapture).not.toHaveBeenCalled()
    pointer(grip.button, 'pointerup', 130)
    expect(nextCommit).toHaveBeenCalledExactlyOnceWith(540, false)
    expect(b.onCommit).not.toHaveBeenCalled()
  })

  it('rejects a previous Session release before passive cleanup runs', () => {
    const b = fixture()
    const grip = b.grip()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointermove', 120)
    const next = randomUUID() as SessionId
    act(() => { b.store.actions.setExpanded(next, true) })
    const release = () => { pointer(grip.button, 'pointerup', 140) }
    b.update({ sessionId: next, renderFactorySlot: () => <ReleaseDuringCommit release={release} /> })
    expect(b.onCommit).not.toHaveBeenCalled()
    expect(grip.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7)
    expect(b.root.style.width).toBe('480px')
    expect(b.root.hasAttribute('data-sidebar-right-resizing')).toBe(false)
  })

  it('clamps to the docking minimum and permits growth without a maximum', () => {
    const b = fixture()
    const grip = b.grip()
    pointer(grip.button, 'pointerdown', 100)
    pointer(grip.button, 'pointermove', -1000)
    expect(b.root.style.width).toBe('220px')
    pointer(grip.button, 'pointerup', 5000)
    expect(b.onCommit).toHaveBeenCalledExactlyOnceWith(10280, false)
  })

  it.each([
    ['ArrowLeft', false, 470], ['ArrowRight', false, 490],
    ['ArrowLeft', true, 470], ['ArrowRight', true, 490],
  ] as const)('resizes in canvas pixels with %s and Shift=%s', (key, shiftKey, width) => {
    const b = fixture()
    const grip = b.grip()
    fireEvent.keyDown(grip.button, { key, shiftKey })
    expect(b.onCommit).toHaveBeenCalledExactlyOnceWith(width, false)
    fireEvent.keyDown(grip.button, { key: 'ArrowUp' })
    expect(b.onCommit).toHaveBeenCalledOnce()
  })

  it('omits the control for existing callers without resize and while hidden or collapsed', () => {
    const b = fixture({ resizable: false })
    expect(b.queryByRole('button', { name: b.resize.label })).toBeNull()
    b.update({ resize: b.resize, active: false })
    expect(b.queryByRole('button', { name: b.resize.label })).toBeNull()
    act(() => { b.store.actions.setExpanded(b.sessionId, false) })
    b.update({ active: true })
    expect(b.queryByRole('button', { name: b.resize.label })).toBeNull()
    expect(b.getByRole('textbox', { name: 'Tool draft' })).toBeTruthy()
  })
})
