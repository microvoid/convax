// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { DirectoryPicker } from '../src/client/DirectoryPicker.tsx'

afterEach(cleanup)

function fixture(available = true) {
  const availability = createSnapshotStore(available)
  const props = {
    open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    useDirectoryFlow: bindSnapshotSelector(availability), renderSlot: vi.fn(() => null),
  } as FactoryComponentPropsOf<'workspace.directoryPicker'>
  return { props, availability }
}

describe('reusable directory picker', () => {
  it('delegates path selection without adopting a Workspace', () => {
    const { props } = fixture()
    render(<DirectoryPicker {...props} />)
    expect(props.renderSlot).toHaveBeenCalledWith('workspace.directoryPicker.flow', {
      open: true, busy: false, onPicked: props.onPicked, onCancel: props.onCancel, onError: props.onError,
    })
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('settles an open request when its provider disappears', () => {
    const { props, availability } = fixture()
    render(<DirectoryPicker {...props} />)
    act(() => { availability.set(false) })
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.renderSlot).toHaveBeenLastCalledWith('workspace.directoryPicker.flow', expect.objectContaining({ open: false }))
  })

  it('cancels unavailable requests while leaving closed occurrences inert', () => {
    const { props } = fixture(false)
    const view = render(<DirectoryPicker {...props} open={false} />)
    expect(props.onCancel).not.toHaveBeenCalled()
    view.rerender(<DirectoryPicker {...props} />)
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
})
