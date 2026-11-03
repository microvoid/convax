/** Load the PDF renderer only after a PDF body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { PdfBodyProps, PdfDocumentViewProps } from './pdf.tsx'

const LoadedPdfDocument = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfDocumentView }))

const LoadedPdfBody = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfBody }))

/**
 * Suspend while the package-local PDF chunk arrives.
 * @param props - PDF body props supplied by the document slot.
 * @returns the deferred PDF renderer.
 */
export function LazyPdfBody(props: PdfBodyProps): ReactNode {
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <LoadedPdfBody {...props} loading={loading} />
  </Suspense>
}

/** @param props - Session-independent PDF inputs. @returns The same deferred PDF reader. */
export function LazyPdfDocument(props: Omit<PdfDocumentViewProps, 'loading'>): ReactNode {
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}><LoadedPdfDocument {...props} loading={loading} /></Suspense>
}
