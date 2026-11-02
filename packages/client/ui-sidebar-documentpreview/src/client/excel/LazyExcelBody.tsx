/** Load the spreadsheet renderer only when a supported workbook is opened. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { excelFormat, type ExcelFormat } from './format.ts'
import type { ExcelLimits } from './model.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'

/** Document input plus parser limits and localized copy. */
export type ExcelBodyProps = DocumentPreviewProps & PropsLocale<'sidebarExcel'> & { readonly limits: ExcelLimits }

/** Lazily loaded renderer input with the parser choice and main-bundle loading content. */
export type LoadedExcelBodyProps = Pick<ExcelBodyProps, 'content' | 'limits' | 't'> & { readonly format: ExcelFormat; readonly loading: ReactNode }

const LoadedExcelBody = lazy(async () => ({ default: (await import('./excel.tsx')).ExcelBody }))

/**
 * Load the browser spreadsheet renderer for every registered format.
 * @param props - Complete file bytes and standard document seats.
 * @returns Localized loading state or Excel preview.
 */
export function LazyExcelBody(props: ExcelBodyProps): ReactNode {
  return <LazyExcelDocument {...props} path={hostFileOf(props.resourceAddress).path} />
}

/** @param props - Complete bytes, source path, limits and copy. @returns The shared deferred spreadsheet viewer. */
export function LazyExcelDocument(props: Pick<ExcelBodyProps, 'content' | 'limits' | 't'> & { readonly path: string }): ReactNode {
  const format = excelFormat(props.path)
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <LoadedExcelBody {...props} format={format} loading={loading} />
  </Suspense>
}
