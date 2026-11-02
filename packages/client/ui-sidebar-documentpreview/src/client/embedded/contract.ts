/** Session-independent document presentation over resource-owner-loaded bytes. */
import type { FactoryComponentPropsOf, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DocumentContent } from '../document/contract.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'

/** Complete transient bytes supplied by a resource owner, never persisted in layout. */
export interface EmbeddedDocumentSource {
  /** Absolute original file path, used for format detection and relative Markdown images. */
  readonly path: string
  /** Original file bytes, or converted PDF bytes when renderedAs is pdf. */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** Office conversion retains the original path while supplying a PDF. */
  readonly renderedAs?: 'pdf'
  /** Font families unavailable during Office conversion. */
  readonly missingFonts?: readonly string[]
}

/** Renderer inputs supplied by the root preview Factory. */
export interface EmbeddedDocumentBodyOwner {
  readonly source: EmbeddedDocumentSource
  readonly content: DocumentContent
  readonly wrap: boolean
  /** Omit the image's outer inset and let the containing preview own corner clipping. */
  readonly imageInset?: 'none'
  /** Let the containing surface own wheel gestures until a document's isolated content is explicitly entered. */
  readonly gestureMode?: 'container'
}

/** Registry source bound to a framework-generated hook. */
export interface EmbeddedDocumentInjected {
  readonly hooks: { readonly documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Render an existing document implementation without creating a Session or Sidebar tab. */
    'document.preview': {
      scope: 'root'
      props: {
        readonly source: EmbeddedDocumentSource
        /** Omit the image's 12px outer inset; other document renderers retain their own layout. */
        readonly imageInset?: 'none'
        /** Declare isolated content interaction so the containing surface can route wheel and zoom gestures. */
        readonly gestureMode?: 'container'
      }
      locale: 'sidebarDocumentPreview'
      inject: EmbeddedDocumentInjected
      children: {
        'document.preview.body': { kind: 'keyed'; scope: 'root' }
        'document.preview.fonts': { kind: 'single'; scope: 'root' }
      }
    }
  }
  interface SlotMap {
    /** Session-independent adapters to the same document bodies used by Sidebar previews. */
    'document.preview.body': { kind: 'keyed'; scope: 'root'; owner: EmbeddedDocumentBodyOwner }
    /** Missing-font details for an Office document converted by the resource owner. */
    'document.preview.fonts': { kind: 'single'; scope: 'root'; owner: { readonly fonts: readonly string[] } }
  }
}

/** Framework-composed inputs for the shared preview assembly. */
export type EmbeddedDocumentProps = FactoryComponentPropsOf<'document.preview'>

/** Framework-composed inputs for one root-scoped document renderer. */
export type EmbeddedDocumentBodyProps = PropsRuntime<'document.preview.body'>
