/** Root-scoped adapters to the same file presenters used by Sidebar tabs. */
import { useCallback, useEffect, useId, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EmbeddedDocumentBodyProps } from './contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { TextDocument } from '../text/TextBody.tsx'
import { MarkdownDocument } from '../markdown/MarkdownBody.tsx'
import { CodeDocument } from '../code/CodeBody.tsx'
import { HtmlDocument } from '../html/HtmlBody.tsx'
import { ImageDocument, type ImageBodyInjected } from '../image/ImageBody.tsx'
import { LazyPdfDocument } from '../pdf/LazyPdfBody.tsx'
import { LazyExcelDocument } from '../excel/LazyExcelBody.tsx'
import { ZoomViewport, zoomSurfaceClass } from '../zoom/ZoomViewport.tsx'
import { FIT_WIDTH, type ZoomPreference } from '../zoom/types.ts'
import type { PdfView } from '../pdf/store.ts'
import type { ExcelLimits } from '../excel/model.ts'
import css from './DocumentPreview.module.css'

function ignoreScrollport(): void {}

function useDocumentLifetime(): AbortSignal | undefined {
  const [signal, setSignal] = useState<AbortSignal>()
  useEffect(() => {
    const controller = new AbortController()
    setSignal(controller.signal)
    return () => { controller.abort() }
  }, [])
  return signal
}

/** @param props - Owner-decoded text. @returns Shared plain-text pages. */
export function EmbeddedText({ content }: EmbeddedDocumentBodyProps) {
  return <TextDocument content={content} />
}

/** @param props - Owner-decoded Markdown and source path. @returns Shared Markdown presentation. */
export function EmbeddedMarkdown({ source, content, t }: EmbeddedDocumentBodyProps & PropsLocale<'documentMarkdown'>) {
  return <MarkdownDocument content={content} path={source.path} t={t} />
}

/** @param props - Owner-decoded code. @returns Shared highlighted source. */
export function EmbeddedCode({ source, content, wrap, t }: EmbeddedDocumentBodyProps & PropsLocale<'sidebarCodePreview'>) {
  return <CodeDocument content={content} path={source.path} wrap={wrap} scrollportRef={ignoreScrollport} t={t} />
}

/** @param props - Complete HTML bytes. @returns The existing static sandboxed preview. */
export function EmbeddedHtml({ source, gestureMode, t }: EmbeddedDocumentBodyProps & PropsLocale<'documentHtml'>) {
  const id = useId()
  const [interacting, setInteracting] = useState(false)
  if (gestureMode !== 'container') return <HtmlDocument data={source.bytes} frameName={`dsh-document-html-${id}`} t={t} />
  return <div className={css.isolatedPreview} data-gesture-surface={interacting ? 'content' : 'container'}
    data-content-interaction={interacting || undefined}>
    <HtmlDocument data={source.bytes} frameName={`dsh-document-html-${id}`} t={t} inert={!interacting} />
    {!interacting && <div className={css.interactionCover} aria-hidden="true" />}
    <div className={css.interactionActions}>
      <Button size="sm" aria-pressed={interacting} onClick={() => { setInteracting(value => !value) }}>
        {t(interacting ? 'interaction.leave' : 'interaction.enter')}
      </Button>
    </div>
  </div>
}

/** @param props - Image bytes, source path and drag callbacks. @returns A file-local image viewer. */
export function EmbeddedImage(props: EmbeddedDocumentBodyProps & PropsLocale<'sidebarImage'> & Pick<ImageBodyInjected, 'fileDrag'>) {
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH)
  const signal = useDocumentLifetime()
  if (signal === undefined) return <LoadingIndicator label={props.t('loading')} />
  return <ImageDocument content={props.content} path={props.source.path} preference={preference}
    onPreference={setPreference} signal={signal} resourceAddress={undefined}
    {...(props.imageInset === undefined ? {} : { imageInset: props.imageInset })}
    scrollportRef={ignoreScrollport} t={props.t} fileDrag={props.fileDrag} />
}

/** @param props - Original or Office-converted PDF bytes. @returns A file-local PDF reader. */
export function EmbeddedPdf(props: EmbeddedDocumentBodyProps & PropsLocale<'sidebarPdf'>) {
  const [view, setView] = useState<PdfView>({ page: 1 })
  const signal = useDocumentLifetime()
  const onPage = useCallback((page: number) => { setView(current => current.page === page ? current : { ...current, page }) }, [])
  const onPreference = useCallback((zoom: ZoomPreference) => { setView(current => ({ ...current, zoom })) }, [])
  if (signal === undefined) return <LoadingIndicator label={props.t('loading')} />
  return <LazyPdfDocument content={props.content} view={view} onPage={onPage} onPreference={onPreference}
    signal={signal} scrollportRef={ignoreScrollport} ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} t={props.t} />
}

/** @param props - Workbook bytes and configured parsing limits. @returns The shared read-only spreadsheet surface. */
export function EmbeddedExcel(props: EmbeddedDocumentBodyProps & PropsLocale<'sidebarExcel'> & { readonly limits: ExcelLimits }) {
  const body = <LazyExcelDocument content={props.content} path={props.source.path} limits={props.limits} t={props.t} />
  return props.gestureMode === 'container'
    ? <div className={css.contentSurface} data-gesture-surface="content">{body}</div>
    : body
}
