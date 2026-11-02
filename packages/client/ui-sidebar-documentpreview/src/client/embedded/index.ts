/** Register the shared document Factory without changing Sidebar navigation. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../../config.ts'
import type { EmbeddedDocumentInjected } from './contract.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import {
  EmbeddedCode, EmbeddedExcel, EmbeddedHtml, EmbeddedImage, EmbeddedMarkdown, EmbeddedPdf, EmbeddedText,
} from './bodies.tsx'
import { PLAIN_BODY_ID } from '../text/index.ts'
import { MARKDOWN_BODY_ID } from '../markdown/index.ts'
import { HTML_BODY_ID } from '../html/index.ts'
import { IMAGE_BODY_ID } from '../image/index.ts'
import { PDF_BODY_ID } from '../pdf/index.ts'
import { FontNotice } from '../office/FontNotice.tsx'

/** @param ctx - Preview registries, locale, and drag services. @param limits - Configured spreadsheet parser bounds. */
export function apply(ctx: Context, limits: Config['excel']): void {
  const source = { getSnapshot: ctx.documentPreviews.getSnapshot, subscribe: ctx.documentPreviews.subscribe }
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'document.preview', scope: 'root', locale: 'sidebarDocumentPreview',
    inject: (): EmbeddedDocumentInjected => ({ hooks: { documentPreviews: source } }),
    children: {
      'document.preview.body': { kind: 'keyed', scope: 'root' },
      'document.preview.fonts': { kind: 'single', scope: 'root' },
    },
  }, DocumentPreview), 'document-preview: embedded Factory')
  ctx.effect(() => ctx.slots.inject('document.preview.body', function* () {
    yield ctx.slots.register({ name: 'document.preview.body', key: PLAIN_BODY_ID }, EmbeddedText)
    yield ctx.slots.register({ name: 'document.preview.body', key: MARKDOWN_BODY_ID, locale: 'documentMarkdown' }, EmbeddedMarkdown)
    yield ctx.slots.register({ name: 'document.preview.body', key: HTML_BODY_ID, locale: 'documentHtml' }, EmbeddedHtml)
    yield ctx.slots.register({ name: 'document.preview.body', key: IMAGE_BODY_ID, locale: 'sidebarImage',
      inject: () => ({ fileDrag: ctx.fileDrag.actions }),
    }, EmbeddedImage)
    yield ctx.slots.register({ name: 'document.preview.body', key: PDF_BODY_ID, locale: 'sidebarPdf' }, EmbeddedPdf)
    yield ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel',
      locale: 'sidebarExcel', inject: () => ({ limits }),
    }, EmbeddedExcel)
    yield ctx.slots.register({ name: 'document.preview.body', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code',
      locale: 'sidebarCodePreview',
    }, EmbeddedCode)
  }), 'document-preview: embedded bodies')
  ctx.effect(() => ctx.slots.inject('document.preview.fonts', () => ctx.slots.register({
    name: 'document.preview.fonts', locale: 'sidebarOffice',
  }, FontNotice)), 'document-preview: embedded font notice')
}
