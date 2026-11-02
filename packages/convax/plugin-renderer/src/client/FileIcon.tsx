/** Lucide resource glyphs reuse DSH file classification without its artwork. */
import {
  File, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, FolderClosed, Presentation,
  type LucideIcon,
} from 'lucide-react'
import { classifyFileType, type FileType } from '@deepseek-ai/dsh-client-ui-primitives'
import { mediaKind } from './media-kind.ts'
import css from './FileIcon.module.css'

type FileIconProps = { size?: number; className?: string } & (
  | { path: string; kind?: never }
  | { kind: 'folder'; path?: never }
)

interface FileAppearance {
  icon: LucideIcon
  className: string | undefined
}

const CODE: FileAppearance = { icon: FileCode, className: css.code }
const APPEARANCE: Partial<Record<FileType | 'audio', FileAppearance>> = {
  audio: { icon: FileAudio, className: css.media },
  code: CODE,
  excel: { icon: FileSpreadsheet, className: css.sheet },
  folder: { icon: FolderClosed, className: css.folder },
  html: CODE,
  image: { icon: FileImage, className: css.media },
  markdown: { icon: FileText, className: css.document },
  other: { icon: File, className: css.other },
  pdf: { icon: FileText, className: css.pdf },
  ppt: { icon: Presentation, className: css.presentation },
  video: { icon: FileVideo, className: css.media },
  word: { icon: FileText, className: css.document },
}

/**
 * Render a decorative resource icon while the containing row owns its name.
 * @param props - Resource path or folder kind, square size and caller layout class.
 * @returns A Lucide SVG with category color from the current theme.
 */
export function FileIcon({ size = 16, className, ...resource }: FileIconProps) {
  const kind = resource.path === undefined ? resource.kind
    : mediaKind(resource.path) === 'audio' ? 'audio' : classifyFileType(resource.path)
  // Source-language categories share the same code glyph.
  const appearance = APPEARANCE[kind] ?? CODE
  const Icon = appearance.icon
  return <Icon size={size} className={[css.icon, appearance.className, className].filter(Boolean).join(' ')} aria-hidden />
}
