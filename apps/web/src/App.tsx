/** Bilingual public homepage: product story, local demos, and public desktop downloads. */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, Download, FileText,
  Folder, GitBranch, Languages, Menu, Monitor, Puzzle, SlidersHorizontal, X,
} from 'lucide-react'
import { CanvasPreview } from './CanvasPreview.tsx'
import { DemoVideo } from './DemoVideo.tsx'
import { copy, type Locale } from './copy.ts'
import { loadRelease, type ReleaseState } from './release.ts'
import convaxMark from '../../../packages/plugin-renderer/src/client/assets/convax-mark.svg'

const repository = 'https://github.com/microvoid/convax'
const releases = `${repository}/releases`
const stepIcons = [Download, SlidersHorizontal, Folder]

/**
 * Render the marketing page without loading a Host, profile, or API credentials.
 * @returns The responsive public page and its language navigation.
 */
export function App() {
  const [locale, setLocale] = useState<Locale>(() => new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const firstNavLink = useRef<HTMLAnchorElement>(null)
  const [release, setRelease] = useState<ReleaseState>({ status: 'loading' })
  const [releaseAttempt, setReleaseAttempt] = useState(0)
  const c = copy[locale]
  const docs = `/convax/docs/${locale}/`
  const guide = `${docs}getting-started/`
  const downloadTarget = release.status === 'ready' ? release.downloadUrl : '#download'
  const releaseLabel = release.status === 'ready' ? c.download.ready
    : release.status === 'loading' ? c.download.checking : release.status === 'pending' ? c.download.pending : c.download.unavailable
  const releaseSize = release.status === 'ready'
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(release.size / 1_048_576) : ''

  useEffect(() => {
    const lifetime = new AbortController()
    const timeout = window.setTimeout(() => { lifetime.abort() }, 8_000)
    let mounted = true
    setRelease({ status: 'loading' })
    void loadRelease(lifetime.signal).then((value) => {
      if (mounted) setRelease(value)
    }).catch(() => {
      if (mounted) setRelease({ status: 'unavailable' })
    }).finally(() => { window.clearTimeout(timeout) })
    return () => {
      mounted = false
      lifetime.abort()
      window.clearTimeout(timeout)
    }
  }, [releaseAttempt])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = c.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', c.description)
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', c.title)
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', c.description)
    const url = new URL(window.location.href)
    if (locale === 'en') url.searchParams.set('lang', 'en')
    else url.searchParams.delete('lang')
    window.history.replaceState(null, '', url)
  }, [locale, c.title, c.description])

  useEffect(() => {
    const restoreLanguage = () => { setLocale(new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh') }
    window.addEventListener('popstate', restoreLanguage)
    return () => { window.removeEventListener('popstate', restoreLanguage) }
  }, [])

  useEffect(() => {
    if (menuOpen) firstNavLink.current?.focus()
  }, [menuOpen])

  return (
    <>
      <a className="skip-link" href="#main">{c.skip}</a>
      <header className="site-header" onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          setMenuOpen(false)
          menuButton.current?.focus()
        }
      }}>
        <div className="nav-inner">
          <a href="#" className="brand" aria-label="Convax"><span className="brand-symbol" aria-hidden="true"><img src={convaxMark} alt="" /></span>Convax</a>
          <nav className={`primary-nav${menuOpen ? ' is-open' : ''}`} id="primary-nav" aria-label={c.nav.menu}>
            <a ref={firstNavLink} href="#projects" onClick={() => { setMenuOpen(false) }}>{c.nav.demos}</a>
            <a href="#features" onClick={() => { setMenuOpen(false) }}>{c.nav.features}</a>
            <a href={guide} onClick={() => { setMenuOpen(false) }}>{c.nav.docs}</a>
            <a href="#download" className="mobile-download" onClick={() => { setMenuOpen(false) }}>{c.nav.download}</a>
          </nav>
          <div className="nav-actions">
            <a className="nav-download" href="#download"><Download size={15} />{c.nav.download}</a>
            <button className="locale-button" aria-label={c.nav.language} onClick={() => { setLocale(locale === 'zh' ? 'en' : 'zh') }}>
              <Languages size={16} /><span>{locale === 'zh' ? 'EN' : '中文'}</span>
            </button>
            <button
              ref={menuButton}
              className="mobile-menu-button"
              aria-label={c.nav.menu}
              aria-controls="primary-nav"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(!menuOpen) }}
            >
              {menuOpen ? <X size={21} /> : <Menu size={21} />}
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="hero section-shell">
          <span className="preview-label"><span className="live-dot" />{c.preview}</span>
          <h1><span>{c.hero.lead}</span>{' '}<span>{c.hero.end}</span></h1>
          <p className="hero-description">{c.hero.subtitle}</p>
          <div className="hero-actions">
            <a href={downloadTarget} className="button button-primary" data-download="hero"><Download size={17} />{c.hero.download}</a>
            <a href="#projects" className="button button-secondary"><span className="little-play" />{c.hero.watch}</a>
          </div>
          <p className="hero-platform"><Monitor size={14} />{c.download.platform}<span>·</span>{release.status === 'ready' ? `v${release.version}` : releaseLabel}</p>
          <p className="hero-footnote">{c.hero.footnote}</p>
          <CanvasPreview locale={locale} />
          <a href="#projects" className="scroll-cue" aria-label={c.nav.demos}><ArrowDown size={16} /></a>
        </section>

        <section id="projects" className="story-section section-shell">
          <div className="story-copy">
            <span className="eyebrow">{c.projects.eyebrow}</span>
            <h2>{c.projects.title}</h2>
            <p className="section-description">{c.projects.description}</p>
            <ol className="story-steps">
              {c.projects.steps.map((step, index) => (
                <li key={step.title}><span className="step-number">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>
              ))}
            </ol>
          </div>
          <DemoVideo key={`projects-${locale}`} locale={locale} kind="projects" />
        </section>

        <section id="apps" className="story-section apps-section section-shell">
          <div className="story-copy">
            <span className="eyebrow">{c.apps.eyebrow}</span>
            <h2>{c.apps.title}</h2>
            <p className="section-description">{c.apps.description}</p>
            <ol className="story-steps">
              {c.apps.steps.map((step, index) => (
                <li key={step.title}><span className="step-number">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>
              ))}
            </ol>
          </div>
          <div className="app-demo-group">
            <DemoVideo key={`apps-${locale}`} locale={locale} kind="apps" />
            <p className="app-requirements"><Monitor size={15} /><span>{c.apps.note}</span></p>
          </div>
        </section>

        <section id="features" className="features-section">
          <div className="section-shell">
            <div className="section-heading"><span className="eyebrow">{c.features.eyebrow}</span><h2>{c.features.title}</h2></div>
            <div className="features-grid">
              <article className="feature">
                <div className="feature-illustration illustration-files" aria-hidden="true">
                  <div className="mini-document"><FileText size={20} /><span /><span /><span /></div>
                  <div className="floating-folder"><Folder size={23} /></div>
                  <span className="format-tag">.md</span><span className="format-tag">.pdf</span><span className="format-tag">.mp4</span>
                </div>
                <h3>{c.features.files.title}</h3><p>{c.features.files.body}</p><span className="feature-tag">{c.features.files.tag}</span>
              </article>
              <article className="feature">
                <div className="feature-illustration illustration-threads" aria-hidden="true">
                  <GitBranch size={42} strokeWidth={1.5} /><span>01</span><span>02</span><span>03</span>
                </div>
                <h3>{c.features.threads.title}</h3><p>{c.features.threads.body}</p><span className="feature-tag">{c.features.threads.tag}</span>
              </article>
              <article className="feature">
                <div className="feature-illustration illustration-plugins" aria-hidden="true">
                  <div><Puzzle size={31} strokeWidth={1.4} /></div><span>DSH</span><Check size={15} />
                </div>
                <h3>{c.features.plugins.title}</h3><p>{c.features.plugins.body}</p><span className="feature-tag">{c.features.plugins.tag}</span>
              </article>
            </div>
          </div>
        </section>

        <section id="download" className="download-section section-shell" aria-labelledby="download-heading">
          <div className="download-intro">
            <span className="eyebrow">{c.download.eyebrow}</span>
            <h2 id="download-heading">{c.download.title}</h2>
            <p className="section-description">{c.download.body}</p>
            <a className="text-link" href={guide}><BookOpen size={16} />{c.download.guide}<ArrowRight size={15} /></a>
          </div>
          <div className="download-card" data-release-status={release.status}>
            <div className="download-card-heading">
              <div className="download-app-mark"><img src={convaxMark} alt="" /></div>
              <div><h3>Convax for Mac</h3><p>{c.download.platform}</p></div>
              <span className="download-format">DMG</span>
            </div>
            <p className="download-compatibility">{c.download.compatibility}</p>
            <div className="download-status" aria-live="polite" aria-atomic="true">
              {release.status === 'ready' ? <><span className="release-ready"><span className="live-dot" />{c.download.ready}</span>
                <p>v{release.version}<span>·</span>{releaseSize} MB<span>·</span>{c.download.package}</p></>
                : <><strong>{releaseLabel}</strong>
                  <p>{release.status === 'unavailable' ? c.download.unavailableBody : c.download.pendingBody}</p></>}
            </div>
            {release.status === 'ready'
              ? <a href={release.downloadUrl} className="button button-primary" data-download="installer"><Download size={17} />{c.hero.download}</a>
              : <button className="button button-primary" disabled>{releaseLabel}</button>}
            <div className="download-links">
              <a href={release.status === 'ready' ? release.releaseUrl : releases} target="_blank" rel="noreferrer">{c.download.releases}<ArrowUpRight size={14} /></a>
              <button disabled={release.status === 'loading'} onClick={() => { setReleaseAttempt(value => value + 1) }}>{c.download.retry}</button>
            </div>
            <p className="download-other-platforms">{c.download.otherPlatforms}</p>
          </div>
          <ol className="onboarding-steps">
            {c.download.steps.map((step, index) => {
              const Icon = stepIcons[index] ?? Folder
              return <li key={step.title}><div className="onboarding-step-heading"><span>0{index + 1}</span><Icon size={19} /></div><h3>{step.title}</h3><p>{step.body}</p></li>
            })}
          </ol>
        </section>

        <section id="faq" className="faq-section section-shell">
          <h2>{c.faq.title}</h2>
          <div className="faq-list">{c.faq.items.map(item => (
            <details key={item.question}><summary>{item.question}<ChevronDown size={17} /></summary><p>{item.answer}</p></details>
          ))}</div>
        </section>
      </main>

      <footer className="site-footer section-shell">
        <div className="footer-top"><a href="#" className="brand"><span className="brand-symbol" aria-hidden="true"><img src={convaxMark} alt="" /></span>Convax</a>
          <p>{c.footer.tagline}</p><div><a href={repository} target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={13} /></a>
            <a href={docs}>{c.footer.docs}<ArrowRight size={13} /></a>
            <a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{c.footer.license}</a></div></div>
        <div className="footer-bottom"><span>{c.footer.built}</span><span>© {new Date().getFullYear()} Convax</span></div>
      </footer>
    </>
  )
}
