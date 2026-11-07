/** Bilingual public homepage: product story, local demo media, and source setup. */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronDown, FileText,
  Folder, CodeXml, GitBranch, Globe2, Languages, Menu, Monitor, Puzzle, X,
} from 'lucide-react'
import { CanvasPreview } from './CanvasPreview.tsx'
import { DemoVideo } from './DemoVideo.tsx'
import { copy, type Locale } from './copy.ts'
import convaxMark from '../../../packages/plugin-renderer/src/client/assets/convax-mark.svg'

const repository = 'https://github.com/microvoid/convax'
const install = 'git clone https://github.com/microvoid/convax.git\ncd convax\npnpm install --frozen-lockfile\npnpm run build'
const launch = {
  desktop: 'pnpm run start:desktop',
  web: 'pnpm dsh web --patch packages/plugin-renderer/cordis.patch.yml --no-open',
}

/**
 * Render the marketing page without loading a Host, profile, or API credentials.
 * @returns The responsive public page and its language navigation.
 */
export function App() {
  const [locale, setLocale] = useState<Locale>(() => new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const firstNavLink = useRef<HTMLAnchorElement>(null)
  const [platform, setPlatform] = useState<'desktop' | 'web'>('desktop')
  const c = copy[locale]
  const readme = `${repository}/blob/main/README${locale === 'zh' ? '.zh' : ''}.md`

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
            <a href="#start" onClick={() => { setMenuOpen(false) }}>{c.nav.start}</a>
          </nav>
          <div className="nav-actions">
            <a className="github-link" href={repository} target="_blank" rel="noreferrer"><CodeXml size={17} />GitHub<ArrowUpRight size={13} /></a>
            <span className="nav-divider" />
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
          <a href={`${readme}#run`} className="preview-label"><span className="live-dot" />{c.preview}<ArrowUpRight size={13} /></a>
          <h1><span>{c.hero.lead}</span>{' '}<span>{c.hero.end}</span></h1>
          <p className="hero-description">{c.hero.subtitle}</p>
          <div className="hero-actions">
            <a href="#start" className="button button-primary">{c.hero.start}<ArrowRight size={17} /></a>
            <a href="#projects" className="button button-secondary"><span className="little-play" />{c.hero.watch}</a>
          </div>
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

        <section id="start" className="start-section section-shell">
          <div className="start-copy"><span className="eyebrow">{c.start.eyebrow}</span><h2>{c.start.title}</h2>
            <p className="section-description">{c.start.body}</p>
            <a className="button button-primary" href={`${readme}#run`} target="_blank" rel="noreferrer">{c.start.guide}<ArrowUpRight size={17} /></a>
            <a className="text-link" href={repository} target="_blank" rel="noreferrer"><CodeXml size={15} />{c.start.source}<ArrowUpRight size={14} /></a>
          </div>
          <div className="setup-card">
            <div className="setup-tabs" role="tablist" aria-label={c.start.tabLabel}>
              {(['desktop', 'web'] as const).map((value, index) => (
                <button
                  key={value}
                  id={`tab-${value}`}
                  role="tab"
                  aria-selected={platform === value}
                  aria-controls={`panel-${value}`}
                  tabIndex={platform === value ? 0 : -1}
                  onClick={() => { setPlatform(value) }}
                  onKeyDown={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const next = event.key === 'Home' ? 'desktop' : event.key === 'End' ? 'web' : index === 0 ? 'web' : 'desktop'
                      setPlatform(next)
                      document.getElementById(`tab-${next}`)?.focus()
                    }
                  }}
                >
                  {value === 'desktop' ? <Monitor size={16} /> : <Globe2 size={16} />}{value === 'desktop' ? 'Desktop' : 'Web'}
                </button>
              ))}
              <span className="setup-terminal-dot" />
            </div>
            <div role="tabpanel" id={`panel-${platform}`} aria-labelledby={`tab-${platform}`} tabIndex={0} className="setup-content">
              <p>{c.start[platform]}</p>
              <pre><code><span className="code-comment"># 01 / Install</span>{'\n'}{install}{'\n\n'}<span className="code-comment"># 02 / Launch</span>{'\n'}<span className="code-launch">{launch[platform]}</span></code></pre>
              <p className="setup-note">{platform === 'desktop' ? c.start.desktopNote : c.start.webNote}</p>
            </div>
            <div className="setup-requirements"><Check size={13} />{c.start.requirements}</div>
          </div>
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
            <a href={readme} target="_blank" rel="noreferrer">{c.footer.docs}<ArrowUpRight size={13} /></a>
            <a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{c.footer.license}</a></div></div>
        <div className="footer-bottom"><span>{c.footer.built}</span><span>© {new Date().getFullYear()} Convax</span></div>
      </footer>
    </>
  )
}
