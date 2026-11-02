/** Reusable directory selection with the currently composed picker interaction. */
import { useEffect } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract/slots.ts'

/**
 * Render the composed interaction and withdraw a pending request when its provider disappears.
 * @param props - Directory outcome callbacks and the framework-bound provider availability.
 * @returns The native driver or in-page directory browser.
 */
export function DirectoryPicker(props: FactoryComponentPropsOf<'workspace.directoryPicker'>) {
  const available = props.useDirectoryFlow(value => value)
  const { open, onCancel } = props
  useEffect(() => {
    if (open && !available) onCancel()
  }, [open, available, onCancel])
  return props.renderSlot('workspace.directoryPicker.flow', {
    open: open && available, busy: props.busy,
    onPicked: props.onPicked, onCancel, onError: props.onError,
  })
}
