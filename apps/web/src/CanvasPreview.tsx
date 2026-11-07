/** Static canvas illustration; the public page never mounts the live workspace. */
import { ArrowUp, Check, FileText, Folder, MessageCircle, Minus, MoreHorizontal, Plus } from 'lucide-react'
import { copy, type Locale } from './copy.ts'

/**
 * Show two independent project contexts and their outputs in a shared workspace.
 * @param props - The illustration language.
 * @returns An accessible, non-interactive canvas illustration.
 */
export function CanvasPreview({ locale }: { locale: Locale }) {
  const c = copy[locale].canvas
  return (
    <figure className="canvas-preview" role="img" aria-label={c.alt}>
      <div className="canvas-chrome" aria-hidden="true">
        <span className="window-dots"><i /><i /><i /></span>
        <span className="canvas-wordmark">Convax</span>
        <span className="canvas-active-tab">{c.tab}</span>
        <span className="canvas-other-tab">{c.otherTab}</span>
        <Plus size={13} />
        <span className="canvas-illustration-label">{c.label}</span>
      </div>
      <div className="canvas-scene" aria-hidden="true">
        <svg className="canvas-wires" viewBox="0 0 1000 420" preserveAspectRatio="none">
          <path className="wire wire-a" d="M228 120 C290 120 275 112 335 112 M675 112 C750 112 730 120 790 120" />
          <path className="wire wire-b" d="M228 305 C290 305 275 290 335 290 M675 290 C750 290 730 305 790 305" />
        </svg>
        <div className="preview-source source-a">
          <FileText size={27} className="file-glyph" />
          <div><span>brief.md</span><small>{c.fileType}</small></div>
          <span className="connector right" />
        </div>
        <div className="preview-source source-b">
          <Folder size={29} className="folder-glyph" />
          <div><span>webapp</span><small>{c.folderType}</small></div>
          <span className="connector right" />
        </div>
        <div className="preview-chat chat-a">
          <div className="preview-chat-top"><MessageCircle size={14} /><span>{c.projectA}</span><MoreHorizontal size={15} /></div>
          <div className="preview-chat-content">
            <span className="preview-prompt">{c.promptA}</span>
            <span className="preview-response"><span className="mini-mark">✳</span>{c.replyA}</span>
            <div className="preview-progress"><i /><i /><i /></div>
          </div>
          <div className="preview-composer"><span>{c.composer}</span><ArrowUp size={14} /></div>
          <span className="connector left" /><span className="connector right" />
          <span className="preview-status"><i />{c.running}</span>
        </div>
        <div className="preview-chat chat-b">
          <div className="preview-chat-top"><MessageCircle size={14} /><span>{c.projectB}</span><MoreHorizontal size={15} /></div>
          <div className="preview-chat-content">
            <span className="preview-prompt">{c.promptB}</span>
            <span className="preview-response"><span className="mini-mark">✳</span>{c.replyB}</span>
            <div className="preview-code"><i /><i /><i /></div>
          </div>
          <div className="preview-composer"><span>{c.composer}</span><ArrowUp size={14} /></div>
          <span className="connector left" /><span className="connector right" />
          <span className="preview-status"><i />{c.running}</span>
        </div>
        <div className="preview-output output-a">
          <div className="preview-output-heading"><FileText size={14} />{c.resultA}<Check size={12} /></div>
          <span className="output-line long" /><span className="output-line" /><span className="output-line short" />
          <div className="output-check"><Check size={9} /><span className="output-line" /></div>
          <div className="output-check"><Check size={9} /><span className="output-line short" /></div>
          <span className="connector left" />
        </div>
        <div className="preview-output output-b">
          <div className="preview-output-heading"><span className="tiny-browser" />{c.resultB}<Check size={12} /></div>
          <div className="mini-website"><span /><i /><i /><b /><div><em /><em /><em /></div></div>
          <span className="connector left" />
        </div>
        <div className="preview-navigation"><Minus size={12} /><span>100%</span><Plus size={12} /></div>
        <div className="preview-parallel"><span className="live-dot" />{c.parallel}</div>
      </div>
      <figcaption>{c.hint}</figcaption>
    </figure>
  )
}
