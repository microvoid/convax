/** Explicit native-window selection keeps source identities out of durable graph data. */
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { AppWindow } from 'lucide-react'
import type { DesktopWindowSource, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type { WorkspaceProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from './WindowPicker.module.css'

/**
 * Choose one exact running window and retain the list when capture or graph admission fails.
 * @param props - Native enumeration, explicit selection and localized copy.
 * @returns A dismissible, searchable source picker.
 */
export function WindowPicker({ rebind, list, select, close, t }: {
  readonly rebind: boolean
  readonly list: () => Promise<readonly DesktopWindowSource[]>
  readonly select: (id: DesktopWindowSourceId) => Promise<boolean>
  readonly close: () => void
  readonly t: WorkspaceProps['t']
}) {
  const [sources, setSources] = useState<readonly DesktopWindowSource[]>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setFailed(false)
    void list().then((value) => { if (active) setSources(value) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [list, reload])
  const choose = async (id: DesktopWindowSourceId): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try { if (await select(id)) close(); else setFailed(true) }
    catch (_selectionFailure) { setFailed(true) }
    finally { setBusy(false) }
  }
  const filtered = sources?.filter(source => source.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <Modal open title={t(rebind ? 'window.rebind' : 'window.add')} closeLabel={t('canvas.cancel')}
    className={`${css.picker}`} onClose={() => { if (!busy) close() }}>
    <div className={css.contents}>
      <Input aria-label={t('window.search')} value={query} disabled={busy}
        onChange={(event) => { setQuery(event.target.value) }} />
      <p className={css.description}>{t('window.chooseDescription')}</p>
      <div><Button size="sm" disabled={busy} onClick={() => { setReload(value => value + 1) }}>{t('workspace.refresh')}</Button></div>
      {failed && <div className={css.notice} role="alert">{t('window.failed')}
        <Button size="sm" disabled={busy} onClick={() => { setReload(value => value + 1) }}>{t('workspace.retry')}</Button>
      </div>}
      {busy ? <div className={css.notice} role="status">{t('window.connecting')}</div>
        : sources === undefined && !failed ? <div className={css.loading}><span className={css.spinner} /></div>
          : <div className={css.sources}>
            {filtered?.map(source => <button key={source.id} type="button" className={css.source}
              aria-label={source.name} onClick={() => { void choose(source.id) }}>
              {source.appIcon === undefined ? <AppWindow size={18} aria-hidden />
                : <img className={css.appIcon} src={source.appIcon} alt="" draggable={false} />}
              <span>{source.name}</span>
            </button>)}
            {filtered?.length === 0 && <p className={css.description}>{t('window.empty')}</p>}
          </div>}
    </div>
  </Modal>
}
