/** Format selection for embedded previews over resource-owner-loaded bytes. */
import { useMemo, useState } from 'react'
import { IconWrapFillRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { binaryDocumentPath, matchingDocumentPreviews } from '../document/registry.ts'
import type { DocumentContent } from '../document/contract.ts'
import { unviewableBinaryPath } from '../document/unviewable.ts'
import { PLAIN_BODY_ID } from '../text/index.ts'
import { PDF_BODY_ID } from '../pdf/index.ts'
import type { EmbeddedDocumentProps } from './contract.ts'
import css from './DocumentPreview.module.css'

/** @param props - Framework Factory seats and complete source bytes. @returns A file-local preview occurrence. */
export function DocumentPreview(props: EmbeddedDocumentProps) {
  return <DocumentOccurrence key={props.source.path} {...props} />
}

function DocumentOccurrence({ source, imageInset, gestureMode, useDocumentPreviews, renderSlot, t }: EmbeddedDocumentProps) {
  const definitions = useDocumentPreviews(value => value)
  const [selectedId, setSelectedId] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [wrap, setWrap] = useState(false)
  const candidates = useMemo(() => {
    if (source.renderedAs === 'pdf') return definitions.filter(entry => entry.id === PDF_BODY_ID)
    const matched = matchingDocumentPreviews(definitions, source.path)
    if (binaryDocumentPath(definitions, source.path) || (matched.length === 0 && unviewableBinaryPath(source.path))) return matched
    const plain = definitions.find(entry => entry.id === PLAIN_BODY_ID)
    return plain === undefined ? matched : [...matched, plain]
  }, [definitions, source.path, source.renderedAs])
  const selected = candidates.find(entry => entry.id === selectedId) ?? candidates[0]
  const content = useMemo<DocumentContent | undefined>(() => {
    if (selected?.loading !== 'text-pages') return { kind: 'bytes', data: source.bytes }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
      if (text.includes('\0')) return undefined
      const page = { offset: 1, text, lines: text.split('\n').length }
      return { kind: 'text', text, pages: [page], eof: true }
    } catch (_invalidUtf8) {
      return undefined
    }
  }, [selected?.loading, source.bytes])
  if (selected === undefined || content === undefined) return <p role="status" className={css.status}>{t('unsupportedFile')}</p>
  return <section className={css.preview} data-document-preview data-document-gesture-mode={gestureMode}>
    {(candidates.length > 1 || selected.wrap === true || (source.missingFonts?.length ?? 0) > 0) && <div className={css.toolbar}>
      {candidates.length > 1 && <Menu open={menuOpen} align="end" portal dense
        anchor={<button type="button" className={css.tool} aria-label={t('openWith')}
          onClick={() => { setMenuOpen(value => !value) }}>{selected.title()}</button>}
        items={candidates.map(entry => ({ id: entry.id, label: entry.title() }))} selectedId={selected.id}
        onSelect={(id) => { setSelectedId(id); setMenuOpen(false) }} onClose={() => { setMenuOpen(false) }} />}
      {selected.wrap === true && <Tooltip label={t(wrap ? 'wrap.disable' : 'wrap.enable')} portal>
        <button type="button" className={css.tool} aria-label={t('wrap.aria')} aria-pressed={wrap}
          onClick={() => { setWrap(value => !value) }}><IconWrapFillRegular size={16} /></button>
      </Tooltip>}
      {source.missingFonts !== undefined && renderSlot('document.preview.fonts', { fonts: source.missingFonts })}
    </div>}
    <div className={`${css.body} ${wrap ? css.wrap : ''}`}>
      {renderSlot('document.preview.body', {
        source, content, wrap, ...(imageInset === undefined ? {} : { imageInset }),
        ...(gestureMode === undefined ? {} : { gestureMode }),
      }, {
        entryKey: selected.id, fallback: <p role="status" className={css.status}>{t('rendererUnavailable', { name: selected.title() })}</p>,
      })}
    </div>
  </section>
}
