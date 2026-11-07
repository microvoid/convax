/** Session-bound preset control for composers that can create another Session. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import type { AgentPresetDefaultController } from './default-store.ts'
import { presetDisplayText } from './locales.ts'
import { requiresCodingTools } from './settings-store.ts'
import css from './AgentPresetInput.module.css'
import seatCss from './AgentPresetSeat.module.css'

/** Controller operations and snapshots shared with the native preset seat. */
export type AgentPresetInputInjected = Pick<AgentPresetSeatInjected, 'load' | 'select'> & {
  hooks: AgentPresetSeatInjected['hooks'] & {
    /** Default-save feedback survives switching to the Session just created. */
    presetDefault: AgentPresetDefaultController['store']
  }
  /** Create a Session with the owner's action and remember its accepted mode. */
  startSession: (id: string, create: (id: string) => Promise<void>) => Promise<void>
}

/** Full props of the session-bound composer control. */
export type AgentPresetInputProps =
  PropsRuntime<'conversation.input.agentPreset'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetInputInjected>

/**
 * Select a blank Session's preset, or create another Session after it starts.
 * @param props - bound Session sources, controller operations, and the occurrence's creation action.
 * @returns the mode menu and local loading or failure feedback.
 */
export function AgentPresetInput({
  sessionId, useSessions, useDeveloperTools, useAgentPresetSeat, usePresetDefault, load, select, startSession, locked, onNewSession, t,
}: AgentPresetInputProps) {
  const state = useAgentPresetSeat(snapshot => snapshot)
  const defaults = usePresetDefault(snapshot => snapshot)
  const developerTools = useDeveloperTools(value => value)
  const session = useSessions(snapshot => snapshot.byId[sessionId])
  const started = (session?.projectionValues?.sessionListMetadata?.blank ?? session?.blank) === false
  const recorded = session?.projectionValues?.agentPreset
  const current = started && typeof recorded === 'string' ? recorded : state.current
  const chosen = state.options.find(option => option.id === current)
  const label = chosen === undefined ? current || t('composerMode') : presetDisplayText(chosen, t).name
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const options = state.options.filter(option => developerTools || !requiresCodingTools(option))
  const disabled = locked || state.busy || state.loading || defaults.saving || creating || session === undefined
  const error = creationError !== null
    ? t('composerCreateFailed', { reason: creationError })
    : defaults.error !== null ? t('composerSaveFailed', { reason: defaults.error })
      : state.error === null ? null : typeof state.error === 'string'
        ? t('composerLoadFailed', { reason: state.error })
        : t('switchRefused', { name: presetDisplayText(state.error.preset, t).name, reason: state.error.reason })

  useEffect(() => { void load() }, [load])

  const choose = async (id: string): Promise<void> => {
    setOpen(false)
    setCreationError(null)
    if (!started) {
      await select(id)
      return
    }
    setCreating(true)
    try {
      await startSession(id, onNewSession)
    } catch (error) {
      setCreationError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className={css.root}>
      <Menu
        open={open && !disabled}
        onClose={() => { setOpen(false) }}
        items={[
          ...(started ? [{ type: 'label' as const, id: 'fixed', text: t('composerFixed') }] : []),
          ...options.map((option) => {
            const text = presetDisplayText(option, t)
            return {
              id: `preset:${option.id}`,
              label: <span className={seatCss.item}>
                <span className={seatCss.itemName}>{started ? t('composerStart', { name: text.name }) : text.name}</span>
                <span className={seatCss.itemDesc}>{text.description ?? t('noDescription')}</span>
              </span>,
            }
          }),
          ...(options.length === 0 ? [{ type: 'label' as const, id: 'empty', text: t('composerEmpty') }] : []),
          { type: 'separator', id: 'refresh-separator' },
          { id: 'refresh', label: t('composerRefresh') },
        ]}
        {...started ? {} : { selectedId: `preset:${current}` }}
        onSelect={(id) => {
          if (id === 'refresh') {
            setOpen(false)
            void load()
          } else void choose(id.slice('preset:'.length))
        }}
        align="start"
        portal
        className={css.anchor}
        anchor={<Tooltip label={t('composerHint', { name: label })} portal side="top">
          <button
            type="button"
            className={`${seatCss.seat} ${css.control}`}
            aria-label={t('composerHint', { name: label })}
            aria-haspopup="menu"
            aria-expanded={open && !disabled}
            aria-busy={state.loading || state.busy || defaults.saving || creating}
            disabled={disabled}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconAgentPresetOutlineRegular className={seatCss.seatIcon} />
            <span className={seatCss.seatLabel}>{creating ? t('composerCreating') : state.loading && current === '' ? t('composerLoading') : label}</span>
            {!started && <IconChevronDownOutlineRegular className={seatCss.chevron} />}
          </button>
        </Tooltip>}
      />
      {error !== null && <span role="alert" className={css.feedback}>{error}</span>}
    </div>
  )
}
